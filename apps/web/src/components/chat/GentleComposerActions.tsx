import {
  gentleProfileModelChange,
  gentleProfileModelLabel,
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
  ProviderInstanceId,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  GENTLE_ODD_NEW_SPEC_PROMPT,
  gentleOddContinuePrompt,
  gentleOddFeatureSummary,
  isProxiedClaudeInstance,
} from "@t3tools/client-runtime/gentle-ai";
import {
  ChevronDownIcon,
  ClipboardListIcon,
  FileTextIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

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

/**
 * Gentle AI entry point in the composer of any provider Gentle AI is set up for. The chip names
 * the profile in use, or says Off; its menu turns Gentle AI on or off for the thread, switches
 * the profile, and opens the project's ODD feature documents in a new thread. Pi threads switch
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
            {!enabled ? (
              <ComposerBanner.Content>Off</ComposerBanner.Content>
            ) : currentProfile ? (
              <ComposerBanner.Content>{currentProfile}</ComposerBanner.Content>
            ) : null}
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
            {claudeData !== null && claudeData.profiles.length > 0 ? (
              <>
                <MenuGroup>
                  <MenuGroupLabel>Profile</MenuGroupLabel>
                  <MenuRadioGroup value={claudeData.active ?? ""}>
                    {claudeData.profiles.map((profile) => (
                      <MenuRadioItem
                        key={profile.name}
                        value={profile.name}
                        disabled={applying !== null}
                        closeOnClick
                        onClick={() => applyClaudeProfile(profile.name)}
                      >
                        {profile.name}
                      </MenuRadioItem>
                    ))}
                    <MenuRadioItem
                      value=""
                      disabled={applying !== null}
                      closeOnClick
                      onClick={() => applyClaudeProfile(null)}
                    >
                      None
                    </MenuRadioItem>
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
                  ) : oddFeatures.data.features.length === 0 ? (
                    <MenuItem disabled>None yet</MenuItem>
                  ) : (
                    <MenuGroup>
                      <MenuGroupLabel>Continue</MenuGroupLabel>
                      {oddFeatures.data.features.map((feature) => (
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
