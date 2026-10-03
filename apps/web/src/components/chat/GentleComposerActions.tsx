import {
  gentleProfileModelChange,
  gentleProfileModelLabel,
  type GentleProfileOption,
} from "@t3tools/client-runtime/piGentleComposer";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  GENTLE_AI_OPTION_ID,
  gentleAiEnabled,
  type EnvironmentId,
  type ModelSelection,
  type PiGentleComposerState,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  GENTLE_ODD_NEW_SPEC_PROMPT,
  gentleOddContinuePrompt,
  gentleOddFeatureSummary,
  gentleOddMenuFeatures,
  gentleOddThreadFeaturePaths,
  isProxiedClaudeInstance,
  type GentleOddThreadTrail,
} from "@t3tools/client-runtime/gentle-ai";
import {
  ChevronDownIcon,
  ClipboardListIcon,
  FileTextIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { GentleRoseIcon } from "../GentleRoseIcon";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { ComposerBanner } from "./ComposerBanner";
import { useComposerMenuProps } from "./composerEventScope";
import { useGentleAiJob, useGentleAiQuery } from "../settings/gentle-ai/useGentleAi";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";

/**
 * Gentle AI entry point in the composer of any provider Gentle AI is set up for. Its menu shows
 * the profile in use and turns Gentle AI on or off for the thread, switches the profile, and opens the project's ODD feature documents in a new thread. Pi threads switch
 * gentle-pi's profiles, which also move the thread onto the profile's orchestrator model; Claude
 * Code threads through a proxy switch Gentle AI's Claude Code profiles.
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
  readThreadTrail,
  onStartThread,
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
  /** This thread's messages and activities, read when the feature menu opens. */
  readonly readThreadTrail: () => GentleOddThreadTrail | null;
  /** Opens a new thread with Gentle AI on and this request written, ready to review and send. */
  readonly onStartThread: (prompt: string) => void;
}) {
  const read = useAtomCommand(serverEnvironment.readPiGentleComposer, {
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
  const gentleAiStatus = useEnvironmentQuery(
    serverEnvironment.gentleAiStatus({ environmentId, input: {} }),
  ).data;
  const floatingLayer = useComposerMenuProps();
  const [menuOpen, setMenuOpen] = useState(false);
  // ODD feature documents are read only while the menu is open.
  const oddListed = gentleAiStatus?.oddFeatures === true;
  const oddFeatures = useGentleAiQuery(
    environmentId,
    "odd.features",
    { cwd },
    { enabled: menuOpen && oddListed },
  );
  // Finished documents drop out; the ones this thread works on come first.
  const oddMenu = useMemo(() => {
    const features = oddFeatures.data?.features ?? [];
    const trail = menuOpen ? readThreadTrail() : null;
    const inThread =
      trail === null
        ? new Set<string>()
        : gentleOddThreadFeaturePaths(
            trail,
            features.map((feature) => feature.path),
          );
    return gentleOddMenuFeatures(features, inThread);
  }, [menuOpen, oddFeatures.data, readThreadTrail]);
  // Claude Code profiles apply only to Claude Code going through a proxy, so only those
  // threads offer them.
  const instanceConfig = useEnvironmentSettings(
    environmentId,
    (settings) => settings.providerInstances[instanceId],
  );
  const claudeProxied =
    !pi && instanceConfig !== undefined && isProxiedClaudeInstance(instanceConfig);
  const claudeProfiles = useGentleAiQuery(
    environmentId,
    "claude.profiles",
    {},
    { enabled: claudeProxied && gentleAiStatus?.claudeProfiles === true },
  );
  const { startJob } = useGentleAiJob(environmentId);
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

  // In Pi, nothing Gentle-related shows unless the server confirms Pi loads gentle-pi here.
  if (pi && loaded?.available !== true) return null;
  const startThread = (prompt: string) => onStartThread(prompt);
  const profiles = enabled ? (loaded?.profiles ?? []) : [];
  const effectiveProfile = loaded?.effectiveProfile ?? null;
  const claudeData = claudeProxied && enabled ? claudeProfiles.data : null;
  const currentProfile = pi ? (effectiveProfile?.name ?? null) : (claudeData?.active ?? null);
  const applyClaudeProfile = (name: string | null) => {
    setApplying(name ?? "");
    void startJob("claude.profiles.apply", { name }).then((started) => {
      setApplying(null);
      if (started !== null && "error" in started) {
        setError(started.error);
        setErrorOpen(true);
      }
    });
  };
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
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger
            render={
              <ComposerBanner.Row
                render={<button type="button" />}
                aria-label={
                  enabled
                    ? `Gentle AI${currentProfile ? `, profile ${currentProfile}` : ""}`
                    : "Gentle AI off"
                }
                data-composer-shortcut="composer.gentle"
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
                  Gentle AI
                </MenuCheckboxItem>
                <MenuSeparator />
              </>
            ) : null}
            {profiles.length > 0 ? (
              <>
                <MenuGroup>
                  <MenuGroupLabel>
                    {effectiveProfile?.pinned ? "Profile · pinned here" : "Profile"}
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
                        <ProfileItemLabel
                          name={profile.name}
                          detail={
                            applying === profile.name
                              ? "Applying…"
                              : gentleProfileModelLabel(modelSelection, profile, models)
                          }
                        />
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
                <MenuSeparator />
              </>
            ) : null}
            {claudeData !== null && claudeData.profiles.length > 0 ? (
              <>
                <MenuGroup>
                  <MenuGroupLabel>Profile</MenuGroupLabel>
                  <MenuRadioGroup value={claudeData.active ?? ""}>
                    <MenuRadioItem
                      value=""
                      disabled={applying !== null}
                      closeOnClick
                      onClick={() => applyClaudeProfile(null)}
                    >
                      <ProfileItemLabel name="Default" />
                    </MenuRadioItem>
                    {claudeData.profiles.map((profile) => (
                      <MenuRadioItem
                        key={profile.name}
                        value={profile.name}
                        disabled={applying !== null}
                        closeOnClick
                        onClick={() => applyClaudeProfile(profile.name)}
                      >
                        <ProfileItemLabel name={profile.name} />
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
                <MenuSeparator />
              </>
            ) : null}
            {oddListed ? (
              <MenuSub>
                <MenuSubTrigger>
                  <FileTextIcon aria-hidden /> Feature documents
                </MenuSubTrigger>
                <MenuSubPopup {...floatingLayer} className="max-w-sm">
                  {oddFeatures.data === null ? (
                    <MenuItem disabled>
                      {oddFeatures.error ?? (
                        <>
                          <Spinner className="size-3.5" /> Reading…
                        </>
                      )}
                    </MenuItem>
                  ) : oddMenu.length === 0 ? (
                    <MenuItem disabled>
                      {oddFeatures.data.features.length === 0 ? "None yet" : "All finished"}
                    </MenuItem>
                  ) : (
                    [true, false].map((inThread) => {
                      const entries = oddMenu.filter((entry) => entry.inThread === inThread);
                      return entries.length === 0 ? null : (
                        <MenuGroup key={inThread ? "thread" : "other"}>
                          <MenuGroupLabel>
                            {inThread ? "In this thread" : "Continue"}
                          </MenuGroupLabel>
                          {entries.map(({ feature }) => (
                            <MenuItem
                              key={feature.path}
                              onClick={() => startThread(gentleOddContinuePrompt(feature))}
                            >
                              <span className="min-w-0">
                                <span className="block truncate">{feature.title}</span>
                                <span className="block truncate text-muted-foreground text-xs">
                                  {gentleOddFeatureSummary(feature)}
                                </span>
                              </span>
                            </MenuItem>
                          ))}
                        </MenuGroup>
                      );
                    })
                  )}
                  <MenuSeparator />
                  <MenuItem onClick={() => startThread(GENTLE_ODD_NEW_SPEC_PROMPT)}>
                    <PlusIcon aria-hidden /> New spec
                  </MenuItem>
                </MenuSubPopup>
              </MenuSub>
            ) : null}
            {error ? (
              <MenuItem onClick={() => setErrorOpen(true)}>
                <ClipboardListIcon aria-hidden /> Show error
              </MenuItem>
            ) : null}
            {pi ? (
              <MenuItem onClick={() => setRefresh((value) => value + 1)}>
                <RefreshCwIcon aria-hidden /> Refresh
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
      </div>
    </ComposerBanner.Root>
  );
}

/** A profile in the chip's menu, checked when it is the one in use. */
/** The selection with Gentle AI turned on or off, every other option kept. */
function withGentleAi(selection: ModelSelection, enabled: boolean) {
  return createModelSelection(selection.instanceId, selection.model, [
    ...(selection.options?.filter((option) => option.id !== GENTLE_AI_OPTION_ID) ?? []),
    { id: GENTLE_AI_OPTION_ID, value: enabled },
  ]);
}

/**
 * The composer's Gentle AI actions, for a provider Gentle AI is set up for in a project. Kept
 * here, with what it changes in the draft, so the composer only hands over what it knows.
 */
export function GentleComposerSlot({
  resetKey,
  gentleAi,
  cwd,
  draftTarget,
  isDraft,
  multipleModels,
  modelSelection,
  pi,
  modelLocked,
  onStartThread,
  ...props
}: {
  /** Changes whenever the menu's answers may have: another thread, run, model or project. */
  readonly resetKey: string;
  /** Whether Gentle AI is set up for the selected provider. */
  readonly gentleAi: boolean;
  readonly cwd: string | null;
  readonly draftTarget: ComposerThreadTarget;
  /** A thread not sent yet, the only kind Gentle AI can still be turned on or off for. */
  readonly isDraft: boolean;
  readonly multipleModels: boolean;
  readonly modelSelection: ModelSelection;
  readonly pi: boolean;
  readonly modelLocked: boolean;
  readonly environmentId: EnvironmentId;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly readThreadTrail: () => GentleOddThreadTrail | null;
  readonly onStartThread: (prompt: string, modelSelection: ModelSelection) => void;
}) {
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setStickyModelSelection = useComposerDraftStore((store) => store.setStickyModelSelection);
  const enabled = gentleAiEnabled(modelSelection.options);
  // A thread that started without Gentle AI keeps it off, so it has nothing to offer.
  if (!gentleAi || cwd === null || !(enabled || isDraft)) return null;
  return (
    <GentleComposerActions
      key={resetKey}
      {...props}
      instanceId={modelSelection.instanceId}
      pi={pi}
      cwd={cwd}
      enabled={enabled}
      canChange={isDraft && !multipleModels}
      modelSelection={modelSelection}
      modelLocked={modelLocked || multipleModels}
      onModelSelectionChange={(selection) => {
        // A complete selection: the profile's thinking level replaces the thread's.
        setModelSelection(draftTarget, selection, { explicit: true, replaceOptions: true });
        setStickyModelSelection(selection);
      }}
      onStartThread={(prompt) => onStartThread(prompt, withGentleAi(modelSelection, true))}
      onEnabledChange={(on) => setModelSelection(draftTarget, withGentleAi(modelSelection, on))}
    />
  );
}

function ProfileItemLabel({ name, detail }: { readonly name: string; readonly detail?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex-1 truncate">{name}</span>
      {detail ? <span className="truncate text-muted-foreground text-xs">{detail}</span> : null}
      <MenuRadioItemIndicator />
    </span>
  );
}
