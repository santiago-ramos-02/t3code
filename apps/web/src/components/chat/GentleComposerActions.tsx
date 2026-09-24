import { gentleComposerAction } from "@t3tools/client-runtime/piGentleComposer";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PiGentleComposerState,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, ClipboardListIcon, RefreshCwIcon, WrenchIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { GentleRoseIcon } from "../GentleRoseIcon";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

export function GentleComposerActions({
  environmentId,
  instanceId,
  threadId,
  cwd,
  canMutate,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId | null;
  readonly cwd: string;
  readonly canMutate: boolean;
}) {
  const read = useAtomCommand(serverEnvironment.readPiGentleComposer, {
    reportFailure: false,
    reportDefect: false,
  });
  const initialize = useAtomCommand(serverEnvironment.initializePiGentleSdd, {
    reportFailure: false,
    reportDefect: false,
  });
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<PiGentleComposerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [runningCommand, setRunningCommand] = useState<"setup" | "review" | null>(null);
  const floatingLayer = useComposerMenuProps();
  const requestKey = `${environmentId}:${instanceId}:${cwd}:${refresh}`;

  useEffect(() => {
    let current: string | null = requestKey;
    void read({ environmentId, input: { instanceId, cwd } }).then((result) => {
      if (current !== requestKey) return;
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
      current = null;
    };
  }, [cwd, environmentId, instanceId, read, requestKey]);

  if (loaded?.available !== true && error === null) return null;
  const status = loaded?.sddStatus ?? null;
  const guidance = loaded ? gentleComposerAction(loaded) : null;
  const canSetUp = loaded?.projectInitNeeded && canMutate && threadId !== null;
  const canReview =
    loaded?.available && !loaded.projectInitNeeded && canMutate && threadId !== null;

  const runCommand = async (command: "setup" | "review") => {
    if (threadId === null || runningCommand !== null || !canMutate) return;
    setRunningCommand(command);
    const result = await initialize({
      environmentId,
      input: { instanceId, threadId, cwd, command },
    });
    setRunningCommand(null);
    if (result._tag === "Success") {
      setLoaded(result.value);
      setError(
        command === "setup" && result.value.projectInitNeeded
          ? "SDD setup was not completed."
          : null,
      );
      if (command === "setup" && result.value.projectInitNeeded) setStatusOpen(true);
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not open Gentle SDD.");
      setStatusOpen(true);
    }
  };

  return (
    <div
      className="mb-1 flex items-center justify-end gap-1 px-2"
      data-chat-composer-collapsed-controls="true"
    >
      {canSetUp ? (
        <ComposerControl
          size="xs"
          disabled={runningCommand !== null}
          onClick={() => void runCommand("setup")}
        >
          <ComposerControlIcon icon={WrenchIcon} size="xs" />
          {runningCommand === "setup" ? "Setting up SDD…" : "Set up SDD"}
        </ComposerControl>
      ) : null}
      <Menu>
        <MenuTrigger render={<ComposerControl size="xs" aria-label="Gentle AI actions" />}>
          <GentleRoseIcon className="size-5 text-foreground" data-composer-control-icon />
          Gentle AI <ChevronDownIcon className="size-3 opacity-60" aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end" side="top" {...floatingLayer}>
          {canReview ? (
            <MenuItem disabled={runningCommand !== null} onClick={() => void runCommand("review")}>
              <WrenchIcon aria-hidden /> Review SDD choices
            </MenuItem>
          ) : null}
          <MenuItem onClick={() => setStatusOpen(true)}>
            <ClipboardListIcon aria-hidden /> View SDD status
          </MenuItem>
          <MenuItem onClick={() => setRefresh((value) => value + 1)}>
            <RefreshCwIcon aria-hidden /> Refresh status
          </MenuItem>
        </MenuPopup>
      </Menu>
      <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
        <DialogPopup {...floatingLayer} className="max-w-md">
          <DialogHeader>
            <DialogTitle>Gentle SDD status</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            {status ? (
              <div className="space-y-2 text-sm">
                <p>Change: {status.changeName ?? "No active change"}</p>
                <p>Next step: {guidance?.label ?? status.nextRecommended}</p>
                {loaded?.projectInitNeeded && threadId === null ? (
                  <p>Send a message to start this Pi thread, then use Set up SDD.</p>
                ) : null}
                {guidance?.reason ? <p>{guidance.reason}</p> : null}
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
            ) : error === null ? (
              <p className="text-sm text-muted-foreground">
                SDD status is unavailable from this Gentle AI installation.
              </p>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
