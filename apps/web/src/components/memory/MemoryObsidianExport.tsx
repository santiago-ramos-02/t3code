import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, MemoryObsidianExportResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { readLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
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
import { Label } from "../ui/label";

// The last vault used on each environment, so exporting again is one click.
const VAULTS_KEY = "t3code:memory:obsidian-vaults:v1";
const Vaults = Schema.Record(Schema.String, Schema.String);

type ExportState =
  | { readonly phase: "idle" }
  | { readonly phase: "running" }
  | { readonly phase: "done"; readonly result: MemoryObsidianExportResult }
  | { readonly phase: "failed"; readonly error: string };

/** Writes the environment's memories into an Obsidian vault as linked notes. */
export function MemoryObsidianExport(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  // The environment is this desktop app's own, so its folder picker shows the right disk.
  readonly local: boolean;
  readonly project: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [vaults, setVaults] = useLocalStorage(VAULTS_KEY, {}, Vaults);
  const [vault, setVault] = useState("");
  const [state, setState] = useState<ExportState>({ phase: "idle" });
  const run = useAtomCommand(serverEnvironment.exportMemoryToObsidian, {
    reportFailure: false,
    reportDefect: false,
  });
  const api = readLocalApi();
  const canPick = props.local && window.desktopBridge !== undefined && api !== undefined;

  const start = async () => {
    const folder = vault.trim();
    if (folder === "") return;
    setState({ phase: "running" });
    const result = await run({
      environmentId: props.environmentId,
      input: { vault: folder, ...(props.project === null ? {} : { project: props.project }) },
    });
    if (result._tag === "Success") {
      setVaults((previous) => ({ ...previous, [props.environmentId]: folder }));
      setState({ phase: "done", result: result.value });
    } else if (isAtomCommandInterrupted(result)) {
      setState({ phase: "idle" });
    } else {
      const failure = squashAtomCommandFailure(result);
      setState({
        phase: "failed",
        error: failure instanceof Error ? failure.message : "The export did not finish.",
      });
    }
  };

  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          setVault(vaults[props.environmentId] ?? "");
          setState({ phase: "idle" });
          setOpen(true);
        }}
      >
        Export to Obsidian
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Export to Obsidian</DialogTitle>
            <DialogDescription>
              Writes{" "}
              {props.project === null ? "every project's memories" : `${props.project}'s memories`}{" "}
              into an Obsidian vault on {props.environmentLabel} as notes linked to their sessions.
              Exporting again adds only what is new.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void start();
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="memory-obsidian-vault">Vault folder</Label>
                <div className="flex gap-2">
                  <Input
                    id="memory-obsidian-vault"
                    placeholder="Full path of the vault on that machine"
                    value={vault}
                    onChange={(event) => setVault(event.target.value)}
                    disabled={state.phase === "running"}
                    autoFocus
                  />
                  {canPick ? (
                    <Button
                      variant="outline"
                      disabled={state.phase === "running"}
                      onClick={async () => {
                        const picked = await api.dialogs
                          .pickFolder(vault.trim() ? { initialPath: vault.trim() } : undefined)
                          .catch(() => null);
                        if (picked) setVault(picked);
                      }}
                    >
                      Choose…
                    </Button>
                  ) : null}
                </div>
              </div>
              {state.phase === "done" ? (
                <ExportSummary result={state.result} />
              ) : state.phase === "failed" ? (
                <p className="text-sm text-destructive-foreground">{state.error}</p>
              ) : null}
            </form>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button variant="outline" onClick={() => setOpen(false)}>
              {state.phase === "done" ? "Close" : "Cancel"}
            </Button>
            <Button
              onClick={() => void start()}
              disabled={vault.trim() === "" || state.phase === "running"}
            >
              {state.phase === "running"
                ? "Exporting…"
                : state.phase === "done"
                  ? "Export again"
                  : "Export"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

const notes = (count: number, what: string) =>
  count === 0 ? null : `${count.toLocaleString()} ${what}`;

/** What the export wrote, and the notes Engram could not write. */
function ExportSummary(props: { readonly result: MemoryObsidianExportResult }) {
  const { created, updated, deleted, problems } = props.result;
  const changes = [
    notes(created, created === 1 ? "new note" : "new notes"),
    notes(updated, "updated"),
    notes(deleted, "removed"),
  ].filter((entry) => entry !== null);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        {changes.length === 0
          ? "The vault was already up to date."
          : `Exported ${changes.join(", ")}.`}
      </p>
      {problems.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-1.5 text-warning-foreground">
            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
            Engram could not write {problems.length === 1 ? "1 note" : `${problems.length} notes`}:
          </p>
          <ul className="max-h-28 overflow-y-auto font-mono text-xs break-all text-muted-foreground">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
