import {
  GENTLE_AI_CLAUDE_SLOTS,
  type GentleAiClaudeProfile,
  type GentleAiModelConfig,
} from "@t3tools/contracts";
import {
  claudeProfileSlotModels,
  GENTLE_AI_CLAUDE_PROFILE_NEEDS_PROXY,
  gentleAiClaudeProfileSummary,
  isProxiedClaudeInstance,
} from "@t3tools/client-runtime/gentle-ai";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../../hooks/useSettings";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Skeleton } from "../../ui/skeleton";
import { Spinner } from "../../ui/spinner";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import {
  profilePhaseModels,
  withPhaseModels,
  withSlotModel,
  withSlotUse,
} from "./GentleAiClaudeProfiles.logic";
import { GentleAiModelEditor } from "./GentleAiModelEditor";
import { GentleAiProfileList } from "./GentleAiProfileList";
import type { GentleAiSectionProps } from "./GentleAiSettingsPage";
import { useGentleAiQuery } from "./useGentleAi";

// Select value for "no profile", which no profile name can be.
const NONE = "\u0000none";

const SLOT_HINTS = {
  fable: "Spare slot, above opus",
  opus: "The strongest; ODD's hard reasoning",
  sonnet: "Smart everyday work",
  haiku: "Cheap, bounded tasks; also titles and other background work",
} as const;

/** The Claude Code profiles, which one is applied, and what that means in a line. */
export function useGentleAiClaudeProfiles({
  environmentId,
  startJob,
  onError,
}: Pick<GentleAiSectionProps, "environmentId" | "startJob" | "onError">) {
  const profiles = useGentleAiQuery(environmentId, "claude.profiles", {});
  const proxied = useEnvironmentSettings(environmentId, (settings) =>
    Object.values(settings.providerInstances).some(isProxiedClaudeInstance),
  );
  const data = profiles.data;
  const active = data?.profiles.find((profile) => profile.name === data.active) ?? null;
  const summary =
    profiles.error ??
    (data === null ? (
      <Skeleton className="h-4 w-48" />
    ) : data.profiles.length > 0 && !proxied ? (
      GENTLE_AI_CLAUDE_PROFILE_NEEDS_PROXY
    ) : active !== null ? (
      gentleAiClaudeProfileSummary(active)
    ) : data.profiles.length === 0 ? (
      "Which models Claude Code's slots run through a proxy, and what it should use each for. Switch profiles to move work off an account near its limit."
    ) : (
      "Claude Code runs its own models."
    ));
  const apply = (name: string | null) =>
    void startJob("claude.profiles.apply", { name }).then((error) =>
      error ? onError(error) : undefined,
    );
  return { data, error: profiles.error, summary, apply };
}

/** Switches the applied Claude Code profile; nothing while there are none. */
export function GentleAiClaudeProfileSelect({
  profiles,
  disabled,
}: {
  readonly profiles: ReturnType<typeof useGentleAiClaudeProfiles>;
  readonly disabled: boolean;
}) {
  const { data, error, apply } = profiles;
  if (data === null) return error ? null : <Skeleton className="h-8 w-56" />;
  if (data.profiles.length === 0) return null;
  return (
    <Select
      value={data.active ?? NONE}
      onValueChange={(next) => {
        if (next === null || next === (data.active ?? NONE)) return;
        apply(next === NONE ? null : next);
      }}
      disabled={disabled}
    >
      <SelectTrigger size="sm" className="w-40" aria-label="Claude Code profile">
        <SelectValue>
          <span className="truncate">{data.active ?? "Default"}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end">
        <SelectItem value={NONE}>Default</SelectItem>
        {data.profiles.map((profile) => (
          <SelectItem key={profile.name} value={profile.name}>
            {profile.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Claude Code's profiles on its agent page, as the same list Pi's use: what each runs, Use to
 * switch, and a row opens its editor. Saving the profile in use applies it again.
 */
export function GentleAiClaudeProfilesSection(props: GentleAiSectionProps) {
  const { environmentId, disabled, startJob, onError } = props;
  const profiles = useGentleAiClaudeProfiles(props);
  // The phases a profile can pin, and the slots they can be pinned to.
  const models = useGentleAiQuery(environmentId, "models.get", { agent: "claude-code" });
  const providerInstances = useEnvironmentSettings(
    environmentId,
    (settings) => settings.providerInstances,
  );
  const slotOptions = claudeProfileSlotModels(providerInstances);
  const data = profiles.data;
  const run = async (promise: Promise<string | null>) => {
    const error = await promise;
    if (error) onError(error);
    return error === null;
  };

  return (
    <GentleAiProfileList
      title="Profiles"
      profiles={(data?.profiles ?? []).map((profile) => ({
        name: profile.name,
        summary: gentleAiClaudeProfileSummary(profile),
      }))}
      active={data?.active ?? null}
      loading={data === null && profiles.error === null}
      error={profiles.error}
      emptyText="A profile sets which model each of Claude Code's slots runs through a proxy, such as CLIProxyAPI, and what Claude should use each for."
      disabled={disabled}
      builtIn={{
        label: "Default",
        summary: "Claude Code runs its own models.",
        onUse: () => profiles.apply(null),
      }}
      onUse={(name) => profiles.apply(name)}
      onCreate={(name) => {
        const copy = data?.profiles.find((profile) => profile.name === data.active);
        return run(
          startJob("claude.profiles.save", {
            profile: copy === undefined ? { name, slots: {} } : { ...copy, name },
          }),
        );
      }}
      renderEditor={(name) => {
        const profile = data?.profiles.find((entry) => entry.name === name);
        return profile === undefined ? (
          <Spinner className="size-3.5" />
        ) : (
          <ClaudeProfileEditor
            // A saved profile resets the draft to what gentle-ai now holds.
            key={JSON.stringify(profile)}
            profile={profile}
            inUse={profile.name === data?.active}
            slotOptions={slotOptions}
            config={models.data}
            modelsError={models.error}
            disabled={disabled}
            onSave={(next) =>
              void run(startJob("claude.profiles.save", { profile: next, replaces: name }))
            }
            onDelete={() => void run(startJob("claude.profiles.delete", { name }))}
          />
        );
      }}
    />
  );
}

function ClaudeProfileEditor({
  profile,
  inUse,
  slotOptions,
  config,
  modelsError,
  disabled,
  onSave,
  onDelete,
}: {
  readonly profile: GentleAiClaudeProfile;
  readonly inUse: boolean;
  readonly slotOptions: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly config: GentleAiModelConfig | null;
  readonly modelsError: string | null;
  readonly disabled: boolean;
  readonly onSave: (profile: GentleAiClaudeProfile) => void;
  readonly onDelete: () => void;
}) {
  const [draft, setDraft] = useState(profile);
  const name = draft.name.trim();
  const changed = JSON.stringify({ ...draft, name }) !== JSON.stringify(profile);
  const canSave = !disabled && changed && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name);
  const pinned = Object.keys(draft.phases ?? {}).length;

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <Input
          size="sm"
          aria-label="Profile name"
          value={draft.name}
          disabled={disabled}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <Input
          size="sm"
          aria-label="Profile description"
          placeholder="When to use it"
          value={draft.description ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const { description: _previous, ...rest } = draft;
            const text = event.target.value;
            setDraft(text === "" ? rest : { ...rest, description: text });
          }}
        />
      </div>

      <div className="space-y-1.5">
        {slotOptions.length === 0 ? (
          <p className="text-muted-foreground text-xs">{GENTLE_AI_CLAUDE_PROFILE_NEEDS_PROXY}</p>
        ) : null}
        {GENTLE_AI_CLAUDE_SLOTS.map((slot) => {
          const value = draft.slots[slot];
          const listed =
            value === undefined || slotOptions.some((option) => option.id === value.model);
          const options = listed
            ? slotOptions
            : [...slotOptions, { id: value.model, label: value.label ?? value.model }];
          return (
            <div
              key={slot}
              className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[4rem_minmax(0,1fr)_minmax(0,1.3fr)]"
            >
              <span className="font-mono text-sm">{slot}</span>
              <Select
                value={value?.model ?? NONE}
                onValueChange={(next) => {
                  if (next === null) return;
                  setDraft(
                    withSlotModel(
                      draft,
                      slot,
                      next === NONE ? null : (options.find((option) => option.id === next) ?? null),
                    ),
                  );
                }}
                disabled={disabled || options.length === 0}
              >
                <SelectTrigger size="sm" className="min-w-0" aria-label={`${slot} model`}>
                  <SelectValue>
                    <span className="truncate">
                      {value?.label ?? value?.model ?? "Claude Code's own"}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={NONE}>Claude Code's own</SelectItem>
                  {options.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Input
                size="sm"
                className="col-span-2 sm:col-span-1"
                aria-label={`Use ${slot} for`}
                placeholder={value === undefined ? SLOT_HINTS[slot] : "Use it for…"}
                value={value?.useFor ?? ""}
                disabled={disabled || value === undefined}
                onChange={(event) => setDraft(withSlotUse(draft, slot, event.target.value))}
              />
            </div>
          );
        })}
      </div>

      <Collapsible>
        <CollapsibleTrigger className="flex items-center gap-1.5 text-sm">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 text-muted-foreground transition-transform duration-150 in-data-[panel-open]:rotate-90 motion-reduce:transition-none"
          />
          Fixed models for Gentle AI's phases
          <span className="text-muted-foreground text-xs">
            {pinned === 0 ? "none: Claude picks per task" : `${pinned} set`}
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="pt-3">
            {config === null ? (
              <p className="text-muted-foreground text-sm">{modelsError ?? "Reading phases…"}</p>
            ) : (
              <GentleAiModelEditor
                config={config}
                value={profilePhaseModels(draft)}
                onChange={(models) => setDraft(withPhaseModels(draft, models))}
                disabled={disabled}
              />
            )}
          </div>
        </CollapsiblePanel>
      </Collapsible>

      <div className="flex items-center justify-between gap-2">
        {inUse ? (
          <span />
        ) : (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={onDelete}>
            Delete
          </Button>
        )}
        {changed ? (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDraft(profile)}>
              Discard
            </Button>
            <Button size="sm" disabled={!canSave} onClick={() => onSave({ ...draft, name })}>
              Save
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
