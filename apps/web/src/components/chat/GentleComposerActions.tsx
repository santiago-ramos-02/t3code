import { gentleComposerAction } from "@t3tools/client-runtime/piGentleComposer";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PiGentleComposerState, ProviderInstanceId } from "@t3tools/contracts";
import {
  AlertCircleIcon,
  ChevronDownIcon,
  CircleHelpIcon,
  ClipboardListIcon,
  PlusIcon,
  RefreshCwIcon,
  Settings2Icon,
  StethoscopeIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

export function GentleComposerActions({
  environmentId,
  instanceId,
  cwd,
  onRun,
  canInitialize,
  canRunDoctor,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly onRun: (prompt: string) => void;
  readonly canInitialize: boolean;
  readonly canRunDoctor: boolean;
}) {
  const read = useAtomCommand(serverEnvironment.readPiGentleComposer, {
    reportFailure: false,
    reportDefect: false,
  });
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<PiGentleComposerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [newChangeOpen, setNewChangeOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const floatingLayer = useComposerMenuProps();

  useEffect(() => {
    let current = true;
    void read({ environmentId, input: { instanceId, cwd } }).then((result) => {
      if (!current) return;
      if (result._tag === "Success") {
        setLoaded(result.value);
        setError(null);
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setLoaded(null);
        setError(failure instanceof Error ? failure.message : "Could not read Gentle AI status.");
      }
    });
    return () => {
      current = false;
    };
  }, [cwd, environmentId, instanceId, read, refresh]);

  if (loaded?.available !== true && error === null) return null;
  const status = loaded?.sddStatus ?? null;
  const action = loaded ? gentleComposerAction(loaded, canInitialize) : null;
  const showPrimary = action !== null;
  const ActionIcon =
    action?.kind === "setup"
      ? WrenchIcon
      : action?.kind === "start"
        ? PlusIcon
        : action?.kind === "continue"
          ? ClipboardListIcon
          : action?.kind === "select-change"
            ? CircleHelpIcon
            : AlertCircleIcon;

  return (
    <div
      className="mb-1 flex items-center justify-end gap-1 px-2"
      data-chat-composer-collapsed-controls="true"
    >
      {showPrimary ? (
        <ComposerControl
          size="xs"
          onClick={() => {
            if (action.kind === "start") setNewChangeOpen(true);
            else if (action.prompt === null) setStatusOpen(true);
            else onRun(action.prompt);
          }}
        >
          <ComposerControlIcon icon={ActionIcon} size="xs" />
          {action.label}
        </ComposerControl>
      ) : null}
      <Menu>
        <MenuTrigger render={<ComposerControl size="xs" aria-label="Gentle AI actions" />}>
          Gentle AI <ChevronDownIcon className="size-3 opacity-60" aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end" side="top" {...floatingLayer}>
          <MenuItem onClick={() => setStatusOpen(true)}>
            <ClipboardListIcon aria-hidden /> View SDD status
          </MenuItem>
          <MenuItem onClick={() => onRun("/gentle:sdd-preflight --edit")}>
            <Settings2Icon aria-hidden />{" "}
            {loaded?.projectInitNeeded ? "Choose SDD preferences" : "Change SDD preferences"}
          </MenuItem>
          {canRunDoctor && (status === null || error !== null) ? (
            <MenuItem onClick={() => onRun("/gentle:doctor")}>
              <StethoscopeIcon aria-hidden /> Run Gentle doctor
            </MenuItem>
          ) : null}
          <MenuItem onClick={() => setRefresh((value) => value + 1)}>
            <RefreshCwIcon aria-hidden /> Refresh status
          </MenuItem>
        </MenuPopup>
      </Menu>
      <Dialog open={newChangeOpen} onOpenChange={setNewChangeOpen}>
        <DialogPopup {...floatingLayer} className="max-w-md">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!goal.trim()) return;
              onRun(`Use Gentle SDD to ${goal.trim()}`);
              setNewChangeOpen(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>New SDD change</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <Input
                autoFocus
                aria-label="Change goal"
                placeholder="What do you want to build?"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
              />
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNewChangeOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!goal.trim()}>
                Start change
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
      <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
        <DialogPopup {...floatingLayer} className="max-w-md">
          <DialogHeader>
            <DialogTitle>Gentle SDD status</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {status ? (
              <div className="space-y-2 text-sm">
                <p>Change: {status.changeName ?? "No active change"}</p>
                <p>Next step: {action?.label ?? status.nextRecommended}</p>
                {action?.reason ? <p>{action.reason}</p> : null}
                {status.taskProgress.total > 0 ? (
                  <p>
                    Tasks: {status.taskProgress.completed} of {status.taskProgress.total} complete
                  </p>
                ) : null}
                {status.blockedReasons.length > 0 &&
                status.nextRecommended !== "sdd-new" &&
                status.nextRecommended !== "archived" ? (
                  <div>
                    <p className="font-medium">Status details</p>
                    <ul className="list-disc space-y-1 pl-5">
                      {status.blockedReasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {error ?? "SDD status is unavailable from this Gentle AI installation."}
              </p>
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
