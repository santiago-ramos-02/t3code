import type { EnvironmentPresentation } from "~/state/environments";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  BOAT_SIZE_DETAILS,
  BoatSize,
  DEFAULT_BOAT_SETTINGS,
  boatMachineLabel,
  type BoatMachine,
  type BoatMachineAction,
  type BoatStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { environmentCatalog } from "~/connection/catalog";
import { isBoatMachineAt } from "../../hooks/useBoat";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { EnvironmentRow } from "./EnvironmentRow";

function commandError(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Boat could not do that.";
}

export function boatSizeSummary(size: BoatSize) {
  const details = BOAT_SIZE_DETAILS[size];
  return [details.specs, details.hourlyPrice, details.note].filter(Boolean).join(" · ");
}

/** What a machine costs right now, in the words the user decides on. */
export function boatMachineStateText(machine: BoatMachine): string {
  switch (machine.state) {
    case "starting":
      return "Starting";
    case "running":
      return `Running, ${BOAT_SIZE_DETAILS[machine.size].hourlyPrice}`;
    case "stopping":
      return "Stopping";
    case "stopped":
      return "Stopped, not billed";
    case "deleting":
      return "Deleting";
    case "failed":
      return machine.problem ?? "Failed";
  }
}

/** Stop, resume, and delete for the host's Boat machines; delete also forgets the pairing. */
export function useBoatMachineActions(
  hostEnvironmentId: EnvironmentId,
  savedEnvironments: ReadonlyArray<EnvironmentPresentation>,
) {
  const runAction = useAtomCommand(serverEnvironment.runBoatMachineAction, {
    reportFailure: false,
  });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const [busySandboxId, setBusySandboxId] = useState<string | null>(null);

  const act = async (machine: BoatMachine, action: BoatMachineAction) => {
    const label = boatMachineLabel(machine);
    if (action === "delete") {
      const confirmed = await requestConfirmDialog(
        `Delete ${label}?\nIts disk goes with it, including work that was not pushed.`,
        { variant: "destructive" },
      );
      if (confirmed !== true) return;
    }
    setBusySandboxId(machine.sandboxId);
    const result = await runAction({
      environmentId: hostEnvironmentId,
      input: { sandboxId: machine.sandboxId, action },
    });
    setBusySandboxId(null);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not ${action} ${label}`,
          description: commandError(result),
        }),
      );
      return;
    }
    if (action !== "delete") return;
    const paired = savedEnvironments.find((environment) =>
      isBoatMachineAt(machine, environment.displayUrl),
    );
    if (paired) await removeEnvironment(paired.environmentId);
  };

  return { act, busySandboxId };
}

/** Stop or resume, then delete; for a machine's row menu. */
export function BoatMachineMenuItems({
  machine,
  busy,
  onAction,
}: {
  readonly machine: BoatMachine;
  readonly busy: boolean;
  readonly onAction: (action: BoatMachineAction) => void;
}) {
  return (
    <>
      {machine.state === "running" ? (
        <MenuItem disabled={busy} onClick={() => onAction("stop")}>
          Stop machine
        </MenuItem>
      ) : null}
      {machine.state === "stopped" ? (
        <MenuItem disabled={busy} onClick={() => onAction("resume")}>
          Resume machine
        </MenuItem>
      ) : null}
      <MenuItem variant="destructive" disabled={busy} onClick={() => onAction("delete")}>
        Delete machine…
      </MenuItem>
    </>
  );
}

/** The Boat API key and how new machines start, saved on the host environment. */
export function BoatSetupForm({
  hostEnvironmentId,
  status,
  onSaved,
  onCancel,
}: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly status: BoatStatus | null;
  readonly onSaved: () => void;
  // Set when the form is a dialog's whole body, which then also holds the dialog's footer.
  readonly onCancel?: () => void;
}) {
  const id = useId();
  const canWrite = useEnvironmentScope(hostEnvironmentId, AuthSettingsWriteScope);
  const configure = useAtomCommand(serverEnvironment.configureBoat, { reportFailure: false });
  const saved = status?.settings ?? DEFAULT_BOAT_SETTINGS;
  const configured = status?.configured === true;
  const [apiKey, setApiKey] = useState("");
  const [template, setTemplate] = useState(saved.template ?? "");
  const [defaultSize, setDefaultSize] = useState<BoatSize>(saved.defaultSize);
  const [idleMinutes, setIdleMinutes] = useState(String(saved.idleStopMinutes));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idleStopMinutes = Number(idleMinutes);
  const idleValid =
    Number.isInteger(idleStopMinutes) && idleStopMinutes >= 1 && idleStopMinutes <= 1440;

  const cli = status?.cli ?? null;
  const pastedKey = apiKey.trim();

  // "key" keeps the saved key unless one was pasted.
  const save = async (source: "key" | "cli" | "remove") => {
    if (source === "key" && !configured && pastedKey === "") {
      setError(
        cli?.signedIn
          ? "Paste a Boat API key, or use the Boat CLI's login."
          : "Paste a Boat API key.",
      );
      return;
    }
    if (!idleValid) {
      setError("Enter idle minutes from 1 to 1440.");
      return;
    }
    setSaving(true);
    setError(null);
    const result = await configure({
      environmentId: hostEnvironmentId,
      input: {
        ...(source === "remove"
          ? { apiKey: null }
          : source === "cli"
            ? { useCliLogin: true }
            : pastedKey
              ? { apiKey: pastedKey }
              : {}),
        settings: {
          template: template.trim() || null,
          defaultSize,
          idleStopMinutes,
        },
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(commandError(result));
      return;
    }
    setApiKey("");
    onSaved();
  };

  const disabled = saving || !canWrite;
  const fields = (
    <>
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">Connection</h3>
        {cli?.signedIn ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <p className="min-w-0 text-xs text-foreground">
              The Boat CLI here is signed in{cli.account ? ` as ${cli.account}` : ""}.
              {configured ? "" : " T3 Code can use it instead of a pasted key."}
            </p>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => void save("cli")}
            >
              {configured ? "Use its login" : "Connect"}
            </Button>
          </div>
        ) : cli ? (
          <p className="text-xs text-muted-foreground">
            The Boat CLI here is signed out. Run <code>boat login</code>, then open this again to
            connect without a key.
          </p>
        ) : null}
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">API key</span>
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              configured
                ? "Saved. Paste a new key to replace it."
                : cli?.signedIn
                  ? "Or paste one from boat.dev"
                  : "From boat.dev"
            }
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </section>
      <section className="space-y-3 border-t border-border pt-4">
        <h3 className="text-sm font-medium text-foreground">New machines</h3>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-foreground">Template</span>
          <Input
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            placeholder="Boat's base image"
            disabled={disabled}
            spellCheck={false}
          />
          <span className="mt-1 block text-2xs text-muted-foreground">
            A named Boat snapshot with your providers signed in. Without one, machines start bare
            and run the published T3 Code server.
          </span>
        </label>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <div>
            <label
              htmlFor={`${id}-size`}
              className="mb-1.5 block text-xs font-medium text-foreground"
            >
              Default size
            </label>
            <Select
              value={defaultSize}
              onValueChange={(value) => {
                if (value) setDefaultSize(value);
              }}
              disabled={disabled}
              items={BoatSize.literals.map((value) => ({ value, label: value }))}
            >
              <SelectTrigger id={`${id}-size`}>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {BoatSize.literals.map((value) => (
                  <SelectItem key={value} value={value}>
                    <span className="flex flex-col">
                      <span>{value}</span>
                      <span className="text-muted-foreground text-xs">
                        {boatSizeSummary(value)}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              Stop after idle minutes
            </span>
            <Input
              value={idleMinutes}
              onChange={(event) => setIdleMinutes(event.target.value)}
              inputMode="numeric"
              disabled={disabled}
            />
          </label>
        </div>
      </section>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {!canWrite ? (
        <p className="text-xs text-muted-foreground">
          This connection lacks permission to change settings on this environment.
        </p>
      ) : null}
    </>
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save("key");
  };

  // In a dialog of its own, the actions sit in the dialog's footer like other dialogs'.
  if (onCancel) {
    return (
      <form className="flex min-h-0 flex-col" onSubmit={submit}>
        <DialogPanel>{fields}</DialogPanel>
        <DialogFooter>
          {configured ? (
            <Button
              type="button"
              variant="destructive-outline"
              className="sm:me-auto"
              disabled={disabled}
              onClick={() => void save("remove")}
            >
              Remove key
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={disabled}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </form>
    );
  }
  return (
    <form className="space-y-4" onSubmit={submit}>
      {fields}
      <div className="flex gap-2">
        {configured ? (
          <Button
            type="button"
            variant="destructive-outline"
            disabled={disabled}
            onClick={() => void save("remove")}
          >
            Remove key
          </Button>
        ) : null}
        <Button type="submit" variant="outline" className="flex-1" disabled={disabled}>
          {saving ? "Saving…" : configured ? "Save" : "Add Boat with this key"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Boat in the Environments list: one row for the spawner, then its machines. A machine this
 * device paired with is shown through `renderPairedRow` so it keeps its connection controls.
 */
export function BoatEnvironmentRows({
  hostEnvironmentId,
  status,
  savedEnvironments,
  renderPairedRow,
}: {
  readonly hostEnvironmentId: EnvironmentId;
  readonly status: BoatStatus;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
  readonly renderPairedRow: (
    environment: EnvironmentPresentation,
    machine: BoatMachine,
  ) => ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const { act, busySandboxId } = useBoatMachineActions(hostEnvironmentId, savedEnvironments);
  const { settings, machines } = status;
  const running = machines.filter((machine) => machine.state === "running").length;

  return (
    <>
      <EnvironmentRow
        kind="cloud"
        label="Boat"
        subtitle={
          machines.length === 0
            ? "No machines"
            : `${machines.length} ${machines.length === 1 ? "machine" : "machines"}, ${running} running`
        }
        below={
          <p className="text-xs text-muted-foreground">
            New machines are {settings.defaultSize} size and stop after {settings.idleStopMinutes}{" "}
            idle {settings.idleStopMinutes === 1 ? "minute" : "minutes"}.
          </p>
        }
      >
        <Button type="button" size="xs" variant="outline" onClick={() => setEditing(true)}>
          Edit
        </Button>
      </EnvironmentRow>
      {machines.map((machine) => {
        const paired = savedEnvironments.find((environment) =>
          isBoatMachineAt(machine, environment.displayUrl),
        );
        if (paired) return renderPairedRow(paired, machine);
        const label = boatMachineLabel(machine);
        return (
          <EnvironmentRow
            key={machine.sandboxId}
            kind="cloud"
            label={label}
            className="ps-8 sm:ps-10"
            subtitle={
              <span
                className={cn(
                  "min-w-0",
                  machine.state === "failed" ? "text-destructive" : "truncate",
                )}
              >
                {boatMachineStateText(machine)}
                {machine.state === "failed" ? null : " · Not paired with this device"}
              </span>
            }
          >
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost-muted"
                    size="icon-xs"
                    disabled={busySandboxId === machine.sandboxId}
                    aria-label={`More actions for ${label}`}
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                <BoatMachineMenuItems
                  machine={machine}
                  busy={busySandboxId === machine.sandboxId}
                  onAction={(action) => void act(machine, action)}
                />
              </MenuPopup>
            </Menu>
          </EnvironmentRow>
        );
      })}
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogPopup className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Boat</DialogTitle>
            <DialogDescription>
              Each thread you send to Boat gets its own machine, billed by the second while it runs.
            </DialogDescription>
          </DialogHeader>
          <BoatSetupForm
            hostEnvironmentId={hostEnvironmentId}
            status={status}
            onSaved={() => setEditing(false)}
            onCancel={() => setEditing(false)}
          />
        </DialogPopup>
      </Dialog>
    </>
  );
}
