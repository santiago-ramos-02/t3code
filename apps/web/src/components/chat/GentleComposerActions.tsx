import { gentleComposerAction } from "@t3tools/client-runtime/piGentleComposer";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PiGentleComposerState, ProviderInstanceId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ComposerControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

export function GentleComposerActions({
  environmentId,
  instanceId,
  cwd,
  allowDraftAction,
  onDraft,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly allowDraftAction: boolean;
  readonly onDraft: (draft: string) => void;
}) {
  const read = useAtomCommand(serverEnvironment.readPiGentleComposer, {
    reportFailure: false,
    reportDefect: false,
  });
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<PiGentleComposerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
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
  const action = status ? gentleComposerAction(status) : null;
  const showPrimary = action !== null && (action.draft === null || allowDraftAction);

  return (
    <div
      className="mb-1 flex items-center justify-end gap-1 px-2"
      data-chat-composer-collapsed-controls="true"
    >
      {showPrimary ? (
        <ComposerControl
          size="xs"
          onClick={() => {
            if (action.draft === null) setStatusOpen(true);
            else onDraft(action.draft);
          }}
        >
          {action.label}
        </ComposerControl>
      ) : null}
      <Menu>
        <MenuTrigger render={<ComposerControl size="xs" aria-label="Gentle AI actions" />}>
          Gentle AI <ChevronDownIcon className="size-3 opacity-60" aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end" side="top" {...floatingLayer}>
          <MenuItem onClick={() => setStatusOpen(true)}>View SDD status</MenuItem>
          <MenuItem
            disabled={!allowDraftAction}
            onClick={() => onDraft("/gentle:sdd-preflight --edit")}
          >
            Edit SDD choices
          </MenuItem>
          <MenuItem disabled={!allowDraftAction} onClick={() => onDraft("/gentle:doctor")}>
            Run Gentle doctor
          </MenuItem>
          <MenuItem onClick={() => setRefresh((value) => value + 1)}>Refresh status</MenuItem>
        </MenuPopup>
      </Menu>
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
