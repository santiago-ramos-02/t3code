import { gentleComposerAction } from "@t3tools/client-runtime/piGentleComposer";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PiGentleComposerState, ProviderInstanceId } from "@t3tools/contracts";
import { ChevronDownIcon, ClipboardListIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { GentleRoseIcon } from "../GentleRoseIcon";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ComposerBanner } from "./ComposerBanner";
import { useComposerMenuProps } from "./composerEventScope";

export function GentleComposerActions({
  environmentId,
  instanceId,
  cwd,
  enabled,
  canChange,
  onEnabledChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly enabled: boolean;
  readonly canChange: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
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
  const [settingUp, setSettingUp] = useState(false);
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
  const needsSetup = loaded?.projectInitNeeded === true;

  return (
    <ComposerBanner.Root
      density="comfortable"
      width="content"
      data-composer-shoulder-tab
      className="ml-auto"
    >
      <div data-chat-composer-collapsed-controls="true">
        <Menu>
          <MenuTrigger
            render={
              <ComposerBanner.Row
                render={<button type="button" />}
                aria-label="Gentle AI actions"
                className="text-muted-foreground transition-colors duration-200 hover:text-foreground data-popup-open:text-foreground"
              />
            }
          >
            <ComposerBanner.Icon className="[&>svg]:size-5">
              <GentleRoseIcon />
            </ComposerBanner.Icon>
            <ComposerBanner.Content>Gentle AI</ComposerBanner.Content>
            <ComposerBanner.Actions>
              <ChevronDownIcon className="size-3 opacity-60" aria-hidden />
            </ComposerBanner.Actions>
          </MenuTrigger>
          <MenuPopup align="end" side="top" {...floatingLayer}>
            {canChange ? (
              <>
                <MenuCheckboxItem checked={enabled} onCheckedChange={onEnabledChange}>
                  Enable
                </MenuCheckboxItem>
                <MenuSeparator />
              </>
            ) : null}
            {enabled && status && !loaded?.projectInitNeeded ? (
              <MenuItem onClick={() => setStatusOpen(true)}>
                <ClipboardListIcon aria-hidden /> View SDD status
              </MenuItem>
            ) : null}
            {enabled && loaded?.available && status === null ? (
              <MenuItem onClick={() => setStatusOpen(true)}>
                <ClipboardListIcon aria-hidden /> SDD status unavailable
              </MenuItem>
            ) : null}
            {enabled && needsSetup ? (
              <MenuItem
                disabled={settingUp}
                onClick={() => {
                  setSettingUp(true);
                  void initialize({
                    environmentId,
                    input: { instanceId, cwd, command: "setup" },
                  }).then((result) => {
                    if (result._tag === "Success") {
                      setLoaded(result.value);
                      setError(null);
                    } else if (!isAtomCommandInterrupted(result)) {
                      const failure = squashAtomCommandFailure(result);
                      setError(
                        failure instanceof Error ? failure.message : "Could not set up SDD.",
                      );
                      setStatusOpen(true);
                    }
                    setSettingUp(false);
                  });
                }}
              >
                <ClipboardListIcon aria-hidden /> {settingUp ? "Setting up SDD…" : "Set up SDD"}
              </MenuItem>
            ) : null}
            {error ? (
              <MenuItem onClick={() => setStatusOpen(true)}>
                <ClipboardListIcon aria-hidden /> View Gentle AI error
              </MenuItem>
            ) : null}
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
    </ComposerBanner.Root>
  );
}
