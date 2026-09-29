import {
  GENTLE_AI_CLAUDE_SLOTS,
  type GentleAiClaudeProfile,
  type GentleAiModelConfig,
} from "@t3tools/contracts";
import { gentleAiClaudeProfileSummary } from "@t3tools/client-runtime/gentle-ai";
import { useState } from "react";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { SettingsRow } from "../settingsLayout";
import {
  claudeSlotModelOptions,
  profilePhaseModels,
  withPhaseModels,
  withSlotModel,
  withSlotUse,
} from "./GentleAiClaudeProfiles.logic";
import { GentleAiFlowFooter, GentleAiFlowHeader, GentleAiFlowPanel } from "./GentleAiFlow";
import { GentleAiModelEditor } from "./GentleAiModelEditor";
import type { GentleAiSectionProps } from "./GentleAiSettingsPage";
import { useGentleAiQuery } from "./useGentleAi";

// Select values for "no profile" and "a new profile", which no profile name can be.
const NONE = "\u0000none";
const NEW = "\u0000new";

const SLOT_HINTS = {
  fable: "Spare slot, above opus",
  opus: "The strongest; ODD's hard reasoning",
  sonnet: "Smart everyday work",
  haiku: "Cheap, bounded tasks; also titles and other background work",
} as const;

/** Which Claude Code profile is applied, switchable in place. */
export function GentleAiClaudeProfileRow({
  environmentId,
  disabled,
  startJob,
  onError,
  openFlow,
}: GentleAiSectionProps) {
  const profiles = useGentleAiQuery(environmentId, "claude.profiles", {});
  const data = profiles.data;
  const active = data?.profiles.find((profile) => profile.name === data.active) ?? null;
  const apply = (name: string | null) =>
    void startJob("claude.profiles.apply", { name }).then((error) =>
      error ? onError(error) : undefined,
    );

  return (
    <SettingsRow
      title="Profile"
      description={
        profiles.error ??
        (data === null
          ? "Reading profiles…"
          : active !== null
            ? (active.description ?? gentleAiClaudeProfileSummary(active))
            : data.profiles.length === 0
              ? "Which models Claude Code's slots run and what it should use each for. Switch profiles to move work off an account near its limit."
              : "Claude Code runs its own models.")
      }
      control={
        <div className="flex items-center gap-2">
          {data === null ? (
            profiles.error ? null : (
              <Spinner className="size-3.5" />
            )
          ) : data.profiles.length === 0 ? null : (
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
                  <span className="truncate">{data.active ?? "None"}</span>
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                <SelectItem value={NONE}>None</SelectItem>
                {data.profiles.map((profile) => (
                  <SelectItem key={profile.name} value={profile.name}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || data === null}
            onClick={() => openFlow({ kind: "claudeProfiles" })}
          >
            {data !== null && data.profiles.length === 0 ? "Create" : "Edit"}
          </Button>
        </div>
      }
    />
  );
}

/** Creates, edits, deletes, and applies Claude Code profiles, in place of the page. */
export function GentleAiClaudeProfilesFlow({
  environmentId,
  disabled,
  startJob,
  onError,
  onClose,
}: GentleAiSectionProps & { readonly onClose: () => void }) {
  const profiles = useGentleAiQuery(environmentId, "claude.profiles", {});
  // Discovery lists the models of the proxy Claude Code is connected to.
  const models = useGentleAiQuery(environmentId, "models.get", {
    agent: "claude-code",
    discover: true,
  });
  const [editing, setEditing] = useState<string | null>(null);
  const data = profiles.data;
  const run = (promise: Promise<string | null>, after?: () => void) =>
    void promise.then((error) => (error ? onError(error) : after?.()));

  const selected =
    editing === NEW
      ? null
      : (data?.profiles.find((profile) => profile.name === (editing ?? data.active)) ??
        data?.profiles[0] ??
        null);
  const selectedKey = editing === NEW || selected === null ? NEW : selected.name;

  return (
    <section className="space-y-4">
      <GentleAiFlowHeader
        title="Claude Code profiles"
        description="A profile sets which model each of Claude Code's slots runs and tells it what each is for, so it picks per task. It can also pin Gentle AI's phases."
        onBack={onClose}
      />
      {data === null ? (
        <GentleAiFlowPanel>
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            {profiles.error ?? (
              <>
                <Spinner className="size-3.5" />
                Reading profiles
              </>
            )}
          </p>
        </GentleAiFlowPanel>
      ) : (
        <>
          <GentleAiFlowPanel>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm">Profile</span>
              <Select
                value={selectedKey}
                onValueChange={(next) => next !== null && setEditing(next)}
                disabled={disabled}
              >
                <SelectTrigger size="sm" className="w-56" aria-label="Profile to edit">
                  <SelectValue>
                    <span className="truncate">
                      {selectedKey === NEW
                        ? "New profile"
                        : `${selectedKey}${selectedKey === data.active ? " · applied" : ""}`}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  {data.profiles.map((profile) => (
                    <SelectItem key={profile.name} value={profile.name}>
                      {profile.name}
                      {profile.name === data.active ? " · applied" : ""}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW}>New profile</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          </GentleAiFlowPanel>
          <ProfileDraft
            key={selectedKey}
            initial={selected}
            applied={selected !== null && selected.name === data.active}
            config={models.data}
            modelsError={models.error}
            disabled={disabled}
            onSave={(profile, andApply) =>
              run(
                startJob("claude.profiles.save", {
                  profile,
                  ...(selected === null ? {} : { replaces: selected.name }),
                }),
                () => {
                  setEditing(profile.name);
                  if (andApply && profile.name !== data.active)
                    run(startJob("claude.profiles.apply", { name: profile.name }));
                },
              )
            }
            onDelete={
              selected === null || selected.name === data.active
                ? null
                : () =>
                    run(startJob("claude.profiles.delete", { name: selected.name }), () =>
                      setEditing(null),
                    )
            }
          />
        </>
      )}
    </section>
  );
}

function ProfileDraft({
  initial,
  applied,
  config,
  modelsError,
  disabled,
  onSave,
  onDelete,
}: {
  readonly initial: GentleAiClaudeProfile | null;
  readonly applied: boolean;
  readonly config: GentleAiModelConfig | null;
  readonly modelsError: string | null;
  readonly disabled: boolean;
  readonly onSave: (profile: GentleAiClaudeProfile, andApply: boolean) => void;
  readonly onDelete: (() => void) | null;
}) {
  const [draft, setDraft] = useState<GentleAiClaudeProfile>(initial ?? { name: "", slots: {} });
  const [pinning, setPinning] = useState(Object.keys(initial?.phases ?? {}).length > 0);
  const slotOptions = claudeSlotModelOptions(config);
  const name = draft.name.trim();
  const profile = { ...draft, name };
  const canSave = !disabled && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name);

  return (
    <>
      <GentleAiFlowPanel>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            size="sm"
            aria-label="Profile name"
            placeholder="Name, e.g. Dynamic"
            value={draft.name}
            disabled={disabled}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          <Input
            size="sm"
            aria-label="Profile description"
            placeholder="When to use it (optional)"
            value={draft.description ?? ""}
            disabled={disabled}
            onChange={(event) => {
              const { description: _previous, ...rest } = draft;
              const text = event.target.value;
              setDraft(text === "" ? rest : { ...rest, description: text });
            }}
          />
        </div>
      </GentleAiFlowPanel>

      <GentleAiFlowPanel>
        <div className="space-y-3">
          <div>
            <h3 className="font-medium text-xs uppercase tracking-wide">Slots</h3>
            <p className="text-muted-foreground text-xs">
              {config === null
                ? (modelsError ?? "Discovering the models Claude Code can reach…")
                : slotOptions.length === 0
                  ? "Connect Claude Code to a proxy to run other models in its slots. Unset slots run Claude Code's own models."
                  : "Unset slots run Claude Code's own models. Say what each slot is for so Claude picks well."}
            </p>
          </div>
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
                className="grid grid-cols-1 gap-1 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1.4fr)] sm:items-center sm:gap-2"
              >
                <div className="min-w-0">
                  <div className="font-mono text-sm">{slot}</div>
                  <div className="text-muted-foreground text-xs">{SLOT_HINTS[slot]}</div>
                </div>
                <Select
                  value={value?.model ?? NONE}
                  onValueChange={(next) => {
                    if (next === null) return;
                    setDraft(
                      withSlotModel(
                        draft,
                        slot,
                        next === NONE
                          ? null
                          : (options.find((option) => option.id === next) ?? null),
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
                  aria-label={`Use ${slot} for`}
                  placeholder={value === undefined ? "Pick a model first" : "Use it for…"}
                  value={value?.useFor ?? ""}
                  disabled={disabled || value === undefined}
                  onChange={(event) => setDraft(withSlotUse(draft, slot, event.target.value))}
                />
              </div>
            );
          })}
        </div>
      </GentleAiFlowPanel>

      <GentleAiFlowPanel>
        <div className="space-y-3">
          <label className="flex items-center justify-between gap-3">
            <span>
              <span className="block text-sm">Pin Gentle AI's phases</span>
              <span className="block text-muted-foreground text-xs">
                Off, Claude picks the model for every task itself. On, the phases you set always run
                on their model; a slot name runs whatever that slot runs.
              </span>
            </span>
            <Switch
              aria-label="Pin Gentle AI's phases"
              checked={pinning}
              disabled={disabled}
              onCheckedChange={(checked) => {
                setPinning(checked);
                if (!checked) setDraft(withPhaseModels(draft, null));
              }}
            />
          </label>
          {!pinning ? null : config === null ? (
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
      </GentleAiFlowPanel>

      <GentleAiFlowFooter
        leading={
          onDelete === null ? null : (
            <Button variant="ghost" disabled={disabled} onClick={onDelete}>
              Delete
            </Button>
          )
        }
      >
        <Button variant="outline" disabled={!canSave} onClick={() => onSave(profile, false)}>
          Save
        </Button>
        {applied ? null : (
          <Button disabled={!canSave} onClick={() => onSave(profile, true)}>
            Save and apply
          </Button>
        )}
      </GentleAiFlowFooter>
    </>
  );
}
