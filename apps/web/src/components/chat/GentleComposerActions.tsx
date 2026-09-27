import {
  GENTLE_SDD_DEFAULTS,
  GENTLE_SDD_NEW_CHANGE_PROMPT,
  gentleProfileModelChange,
  gentleProfileModelLabel,
  gentleSddChangeStep,
  gentleSddSetupNotice,
  gentleSddTaskSummary,
  gentleSddUnlistedReason,
  type GentleProfileOption,
} from "@t3tools/client-runtime/piGentleComposer";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  GentleAiSddChange,
  GentleAiSddChanges,
  ModelSelection,
  PiGentleComposerState,
  PiGentleSddPreferences,
  ProviderInstanceId,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ClipboardListIcon,
  PlusIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
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
import { GentleSddSetupDialog } from "./GentleSddSetupDialog";

/**
 * Gentle AI entry point in the composer of any provider Gentle AI is set up for: the per-thread
 * Enable choice and the project's SDD changes, each ready one handing its phase to a new thread.
 * Pi threads also get gentle-pi's profiles, which move the thread onto a profile's orchestrator
 * model, and project SDD setup, which gentle-pi keeps in a file other agents ask for in chat.
 */
export function GentleComposerActions({
  environmentId,
  instanceId,
  pi,
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
  /** True for a Pi thread, which gets Gentle AI through gentle-pi. */
  readonly pi: boolean;
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
  const readChanges = useAtomCommand(serverEnvironment.readGentleAiSddChanges, {
    reportFailure: false,
    reportDefect: false,
  });
  const [changes, setChanges] = useState<
    | { readonly _tag: "Loaded"; readonly value: GentleAiSddChanges }
    | { readonly _tag: "Failed"; readonly error: string }
    | null
  >(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const floatingLayer = useComposerMenuProps();
  const requestKey = `${environmentId}:${instanceId}:${cwd}:${refresh}`;

  useEffect(() => {
    if (!pi) return;
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
  }, [cwd, environmentId, instanceId, pi, read, requestKey]);

  // Listing runs Gentle AI once per change, so it happens only while the dialog is open.
  useEffect(() => {
    if (!changesOpen) return;
    let current = true;
    void readChanges({ environmentId, input: { cwd } }).then((result) => {
      if (!current) return;
      if (result._tag === "Success") {
        setChanges({ _tag: "Loaded", value: result.value });
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setChanges({
          _tag: "Failed",
          error: failure instanceof Error ? failure.message : "Could not read SDD changes.",
        });
      }
    });
    return () => {
      current = false;
    };
  }, [changesOpen, cwd, environmentId, readChanges]);

  // In Pi, nothing Gentle-related shows unless the server confirms Pi loads gentle-pi here.
  if (pi && loaded?.available !== true) return null;
  // Only gentle-pi needs T3 Code to set up SDD; other agents run its preflight in the thread.
  const needsSetup = pi && loaded?.projectInitNeeded === true;
  const unlistedReason =
    changes?._tag === "Loaded" ? gentleSddUnlistedReason(changes.value.artifactStore) : null;
  const setUpSdd = (preferences: PiGentleSddPreferences) => {
    setSettingUp(true);
    setSetupError(null);
    void initialize({ environmentId, input: { instanceId, cwd, preferences } }).then((result) => {
      setSettingUp(false);
      if (result._tag === "Success") {
        setLoaded(result.value);
        setError(null);
        setSetupOpen(false);
        const notice = gentleSddSetupNotice(preferences, result.value.sdd);
        if (notice) toastManager.add({ type: "warning", title: "SDD set up", description: notice });
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setSetupError(failure instanceof Error ? failure.message : "Could not set up SDD.");
      }
    });
  };
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
            {!needsSetup ? (
              <MenuItem
                onClick={() => {
                  setChanges(null);
                  setChangesOpen(true);
                }}
              >
                <ClipboardListIcon aria-hidden /> SDD changes
              </MenuItem>
            ) : null}
            {pi ? (
              <MenuItem
                onClick={() => {
                  setSetupError(null);
                  setSetupOpen(true);
                }}
              >
                <SlidersHorizontalIcon aria-hidden />
                {needsSetup ? "Set up SDD" : "SDD preferences"}
              </MenuItem>
            ) : null}
            {error ? (
              <MenuItem onClick={() => setErrorOpen(true)}>
                <ClipboardListIcon aria-hidden /> View Gentle AI error
              </MenuItem>
            ) : null}
            {pi ? (
              <MenuItem onClick={() => setRefresh((value) => value + 1)}>
                <RefreshCwIcon aria-hidden /> Refresh status
              </MenuItem>
            ) : null}
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
                ) : changes._tag === "Failed" ? (
                  <p className="text-sm text-destructive">{changes.error}</p>
                ) : changes.value.changes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {unlistedReason ?? "No active changes."}
                  </p>
                ) : (
                  <ul className="divide-y divide-border/60">
                    {changes.value.changes.map((change) => (
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
        {pi ? (
          <GentleSddSetupDialog
            open={setupOpen}
            setUp={!needsSetup}
            initial={loaded?.sdd ?? GENTLE_SDD_DEFAULTS}
            pending={settingUp}
            error={setupError}
            onOpenChange={setSetupOpen}
            onSubmit={setUpSdd}
          />
        ) : null}
      </div>
    </ComposerBanner.Root>
  );
}

function SddChangeRow({
  change,
  onStart,
}: {
  readonly change: GentleAiSddChange;
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
