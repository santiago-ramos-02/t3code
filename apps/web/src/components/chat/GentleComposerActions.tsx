import {
  GENTLE_SDD_NEW_CHANGE_PROMPT,
  gentleProfileModelChange,
  gentleProfileModelLabel,
  gentleSddChangeStep,
  gentleSddTaskSummary,
  type GentleProfileOption,
} from "@t3tools/client-runtime/piGentleComposer";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ModelSelection,
  PiGentleComposerState,
  PiGentleSddChange,
  ProviderInstanceId,
  ServerProviderModel,
} from "@t3tools/contracts";
import { ChevronDownIcon, ClipboardListIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { GentleRoseIcon } from "../GentleRoseIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { ComposerBanner } from "./ComposerBanner";
import { useComposerMenuProps } from "./composerEventScope";

/**
 * Gentle AI entry point in a Pi thread's composer: the per-thread Enable choice, the Gentle
 * profile, project SDD setup, and the project's SDD changes. Applying a profile moves the
 * thread onto its orchestrator model; each ready change hands its phase to a new thread.
 */
export function GentleComposerActions({
  environmentId,
  instanceId,
  cwd,
  enabled,
  canChange,
  modelSelection,
  models,
  modelLocked,
  onEnabledChange,
  onModelSelectionChange,
  onStartSddThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly enabled: boolean;
  readonly canChange: boolean;
  readonly modelSelection: ModelSelection;
  readonly models: ReadonlyArray<ServerProviderModel>;
  /** True while the thread's model cannot change, as when the model picker is disabled. */
  readonly modelLocked: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onModelSelectionChange: (selection: ModelSelection) => void;
  readonly onStartSddThread: (prompt: string) => void;
}) {
  const read = useAtomCommand(serverEnvironment.readPiGentleComposer, {
    reportFailure: false,
    reportDefect: false,
  });
  const initialize = useAtomCommand(serverEnvironment.initializePiGentleSdd, {
    reportFailure: false,
    reportDefect: false,
  });
  const update = useAtomCommand(serverEnvironment.updatePiGentle, {
    reportFailure: false,
    reportDefect: false,
  });
  const [applying, setApplying] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<PiGentleComposerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorOpen, setErrorOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [changes, setChanges] = useState<{
    readonly list: ReadonlyArray<PiGentleSddChange>;
    readonly error: string | null;
  } | null>(null);
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

  // Listing runs Gentle AI once per change, so it happens only while the dialog is open.
  useEffect(() => {
    if (!changesOpen) return;
    let current = true;
    void read({ environmentId, input: { instanceId, cwd, includeChanges: true } }).then(
      (result) => {
        if (!current) return;
        if (result._tag === "Success") {
          setChanges({
            list: result.value.changes ?? [],
            error: result.value.changesError ?? null,
          });
        } else if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setChanges({
            list: [],
            error: failure instanceof Error ? failure.message : "Could not read SDD changes.",
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [changesOpen, cwd, environmentId, instanceId, read]);

  if (loaded?.available !== true && error === null) return null;
  const needsSetup = loaded?.projectInitNeeded === true;
  const startThread = (prompt: string) => {
    setChangesOpen(false);
    onStartSddThread(prompt);
  };
  const profiles = enabled ? (loaded?.profiles ?? []) : [];
  const effectiveProfile = loaded?.effectiveProfile ?? null;
  const applyProfile = (profile: GentleProfileOption) => {
    setApplying(profile.name);
    void update({
      environmentId,
      input: { instanceId, action: { type: "apply", name: profile.name, cwd } },
    }).then((result) => {
      setApplying(null);
      if (result._tag !== "Success") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : "Could not apply the profile.");
          setErrorOpen(true);
        }
        return;
      }
      setRefresh((value) => value + 1);
      const change = gentleProfileModelChange(modelSelection, profile, models);
      if (change.kind === "switch") onModelSelectionChange(change.selection);
      if (change.kind === "unavailable") {
        toastManager.add({
          type: "warning",
          title: `Applied ${profile.name}`,
          description: `${change.model} is not in Pi's model list, so this thread keeps its model.`,
        });
      }
    });
  };

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
                data-composer-shortcut="composer.gentle"
                className="text-muted-foreground transition-colors duration-200 hover:text-foreground data-popup-open:text-foreground"
              />
            }
          >
            <ComposerBanner.Icon className="[&>svg]:size-5">
              <GentleRoseIcon />
            </ComposerBanner.Icon>
            <ComposerBanner.Content>
              {enabled ? "Gentle AI" : "Gentle AI off"}
            </ComposerBanner.Content>
            <ComposerBanner.Actions>
              <ChevronDownIcon className="size-3 opacity-60" aria-hidden />
            </ComposerBanner.Actions>
          </MenuTrigger>
          <MenuPopup align="end" side="top" {...floatingLayer}>
            {canChange ? (
              <MenuCheckboxItem checked={enabled} onCheckedChange={onEnabledChange}>
                Enable
              </MenuCheckboxItem>
            ) : (
              <MenuItem disabled>{enabled ? "On for this thread" : "Off for this thread"}</MenuItem>
            )}
            <MenuSeparator />
            {profiles.length > 0 ? (
              <>
                <MenuGroup>
                  <MenuGroupLabel>
                    {effectiveProfile?.pinned ? "Profile pinned for this checkout" : "Profile"}
                  </MenuGroupLabel>
                  <MenuRadioGroup value={effectiveProfile?.name ?? ""}>
                    {profiles.map((profile) => (
                      <MenuRadioItem
                        key={profile.name}
                        value={profile.name}
                        disabled={modelLocked || applying !== null}
                        closeOnClick
                        // Reapplying the current profile also moves the thread back to its model.
                        onClick={() => applyProfile(profile)}
                      >
                        <span className="flex min-w-0 items-center justify-between gap-4">
                          <span className="truncate">{profile.name}</span>
                          <span className="truncate text-muted-foreground text-xs">
                            {applying === profile.name
                              ? "Applying…"
                              : gentleProfileModelLabel(modelSelection, profile, models)}
                          </span>
                        </span>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
                <MenuSeparator />
              </>
            ) : null}
            {loaded?.available && needsSetup ? (
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
                      setErrorOpen(true);
                    }
                    setSettingUp(false);
                  });
                }}
              >
                <ClipboardListIcon aria-hidden /> {settingUp ? "Setting up SDD…" : "Set up SDD"}
              </MenuItem>
            ) : null}
            {loaded?.available && !needsSetup ? (
              <MenuItem
                onClick={() => {
                  setChanges(null);
                  setChangesOpen(true);
                }}
              >
                <ClipboardListIcon aria-hidden /> SDD changes
              </MenuItem>
            ) : null}
            {error ? (
              <MenuItem onClick={() => setErrorOpen(true)}>
                <ClipboardListIcon aria-hidden /> View Gentle AI error
              </MenuItem>
            ) : null}
            <MenuItem onClick={() => setRefresh((value) => value + 1)}>
              <RefreshCwIcon aria-hidden /> Refresh status
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Dialog open={errorOpen} onOpenChange={setErrorOpen}>
          <DialogPopup {...floatingLayer} className="max-w-md">
            <DialogHeader>
              <DialogTitle>Gentle AI</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <p className="text-sm text-destructive">{error}</p>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
        <Dialog open={changesOpen} onOpenChange={setChangesOpen}>
          <DialogPopup {...floatingLayer} className="max-w-lg">
            <DialogHeader>
              <DialogTitle>SDD changes</DialogTitle>
              <DialogDescription>
                Each phase starts in a new thread with Gentle AI on.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="space-y-3">
                {changes === null ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner className="size-3.5" /> Reading changes
                  </p>
                ) : changes.error !== null ? (
                  <p className="text-sm text-destructive">{changes.error}</p>
                ) : changes.list.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No active changes.</p>
                ) : (
                  <ul className="divide-y divide-border/60">
                    {changes.list.map((change) => (
                      <SddChangeRow key={change.changeName} change={change} onStart={startThread} />
                    ))}
                  </ul>
                )}
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => startThread(GENTLE_SDD_NEW_CHANGE_PROMPT)}
                  >
                    <PlusIcon className="size-3" />
                    New change
                  </Button>
                </div>
              </div>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      </div>
    </ComposerBanner.Root>
  );
}

function SddChangeRow({
  change,
  onStart,
}: {
  readonly change: PiGentleSddChange;
  readonly onStart: (prompt: string) => void;
}) {
  const step = gentleSddChangeStep(change);
  const detail = [
    step.kind === "ready" ? `Next: ${step.label}` : step.label,
    gentleSddTaskSummary(change),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <li className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="truncate font-mono text-sm">{change.changeName}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
        {step.kind === "blocked" ? (
          <p className="text-xs text-muted-foreground">{step.reason}</p>
        ) : null}
      </div>
      {step.kind === "ready" ? (
        <Button size="sm" variant="outline" onClick={() => onStart(step.prompt)}>
          {step.label}
        </Button>
      ) : null}
    </li>
  );
}
