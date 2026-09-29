import type {
  GentleAiModelConfig,
  GentleAiModels,
  GentleAiOpenCodeModel,
} from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxStatus,
  ComboboxTrigger,
} from "../../ui/combobox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import {
  claudePhaseModelOptions,
  type GentleAiFixedModelAgent,
  groupPhases,
  phaseChoice,
  readPhase,
  writeOpenCodePhases,
  writePhase,
} from "./GentleAiModelEditor.logic";

type OpenCodeProviders = NonNullable<GentleAiModelConfig["options"]["opencode"]>["providers"];
type Option = { readonly id: string; readonly label: string };

// Select value for "no choice": gentle-ai's default applies.
const DEFAULT = "__default__";
// Popups render at most this many matches; searching narrows the rest.
const MAX_MATCHES = 200;

/**
 * Edits one agent's per-phase model choices in gentle-ai's shape. `value` holds every agent's
 * fields; only `config.agent`'s are changed.
 */
export function GentleAiModelEditor({
  config,
  value,
  onChange,
  disabled = false,
}: {
  readonly config: GentleAiModelConfig;
  readonly value: GentleAiModels;
  readonly onChange: (next: GentleAiModels) => void;
  readonly disabled?: boolean;
}) {
  const { agent } = config;
  const groups = groupPhases(config.phases);
  if (groups.length === 0)
    return (
      <p className="text-muted-foreground text-sm">Gentle AI reports no phases to configure.</p>
    );

  return (
    <div className="@container/phases space-y-4">
      {groups.map((group) => (
        <section key={group.id} aria-label={group.label} className="space-y-1.5">
          <div className="flex min-h-7 items-center justify-between gap-2">
            <h3 className="font-medium text-xs uppercase tracking-wide">{group.label}</h3>
            {agent === "opencode" && group.id === "odd" && group.phases.length > 1 ? (
              <SetAllPhases
                providers={config.options.opencode?.providers ?? []}
                disabled={disabled}
                onSet={(model) =>
                  onChange(
                    writeOpenCodePhases(
                      value,
                      group.phases.map((phase) => phase.id),
                      model,
                    ),
                  )
                }
              />
            ) : null}
          </div>
          {group.phases.map((phase) => (
            <div
              key={phase.id}
              className="grid grid-cols-1 gap-1 @min-[30rem]/phases:grid-cols-[minmax(7rem,1fr)_minmax(0,3fr)] @min-[30rem]/phases:items-center @min-[30rem]/phases:gap-2"
            >
              <span className="min-w-0 wrap-anywhere text-sm">{phase.label}</span>
              {agent === "opencode" ? (
                <GentleAiOpenCodeModelPicker
                  label={phase.label}
                  providers={config.options.opencode?.providers ?? []}
                  value={value.modelAssignments?.[phase.id] ?? null}
                  disabled={disabled}
                  onChange={(model) => onChange(writeOpenCodePhases(value, [phase.id], model))}
                />
              ) : (
                <FixedPhaseControls
                  agent={agent}
                  config={config}
                  phaseId={phase.id}
                  label={phase.label}
                  value={readPhase(agent, value, phase.id)}
                  disabled={disabled}
                  onChange={(next) => onChange(writePhase(agent, value, phase.id, next))}
                />
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** Model and effort controls for Claude, Codex, and Kiro, which pick from fixed lists. */
function FixedPhaseControls({
  agent,
  config,
  phaseId,
  label,
  value,
  disabled,
  onChange,
}: {
  readonly agent: GentleAiFixedModelAgent;
  readonly config: GentleAiModelConfig;
  readonly phaseId: string;
  readonly label: string;
  readonly value: ReturnType<typeof readPhase>;
  readonly disabled: boolean;
  readonly onChange: (next: ReturnType<typeof readPhase>) => void;
}) {
  const { options } = config;
  const models: ReadonlyArray<Option & { readonly efforts?: ReadonlyArray<string> }> =
    agent === "claude-code"
      ? claudePhaseModelOptions(options.claude?.models ?? [], phaseId)
      : agent === "codex"
        ? (options.codex?.models ?? [])
        : (options.kiro?.models ?? []);
  // Claude's efforts depend on the model; Codex's apply to any model; Kiro has none.
  const efforts =
    agent === "claude-code"
      ? (models.find((model) => model.id === value.model)?.efforts ?? [])
      : agent === "codex"
        ? (options.codex?.efforts ?? [])
        : null;

  return (
    <div className="flex min-w-0 gap-2">
      <ChoiceSelect
        label={`${label} model`}
        value={value.model}
        options={models}
        disabled={disabled}
        onChange={(model) => {
          if (agent !== "claude-code") return onChange(phaseChoice(model, value.effort));
          // A Claude effort only exists for the model it belongs to.
          const valid = models.find((entry) => entry.id === model)?.efforts ?? [];
          const keep = value.effort !== undefined && valid.includes(value.effort);
          onChange(phaseChoice(model, keep ? value.effort : undefined));
        }}
      />
      {efforts === null ? null : (
        <div className="w-28 shrink-0">
          {efforts.length > 0 || value.effort !== undefined ? (
            <ChoiceSelect
              label={`${label} effort`}
              value={value.effort}
              options={efforts.map((effort) => ({ id: effort, label: effort }))}
              disabled={disabled || (agent === "claude-code" && value.model === undefined)}
              onChange={(effort) => onChange(phaseChoice(value.model, effort))}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/** A Select over `options` plus "Default"; a stored value gentle-ai no longer lists stays visible. */
function ChoiceSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly options: ReadonlyArray<Option>;
  readonly disabled: boolean;
  readonly onChange: (value: string | undefined) => void;
}) {
  const listed = value === undefined || options.some((option) => option.id === value);
  const all =
    listed || value === undefined
      ? options
      : [...options, { id: value, label: `${value} (unavailable)` }];
  const selected = all.find((option) => option.id === value);
  return (
    <Select
      value={value ?? DEFAULT}
      onValueChange={(next) => {
        if (next === null) return;
        const chosen = next === DEFAULT ? undefined : next;
        if (chosen !== value) onChange(chosen);
      }}
      disabled={disabled}
    >
      <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={label}>
        <SelectValue>
          <span className="truncate">{selected?.label ?? "Default"}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={DEFAULT}>Default</SelectItem>
        {all.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

const modelKey = (providerId: string, modelId: string) => `${providerId}/${modelId}`;

/**
 * Picks one OpenCode model (searchable across providers) and its effort, or null for
 * gentle-ai's default. Used by phase rows and the "set all" control.
 */
export function GentleAiOpenCodeModelPicker({
  label,
  providers,
  value,
  onChange,
  disabled = false,
  emptyLabel = "Default",
  emptyOption = true,
}: {
  /** What is being assigned, for accessible names. */
  readonly label: string;
  readonly providers: OpenCodeProviders;
  readonly value: GentleAiOpenCodeModel | null;
  readonly onChange: (next: GentleAiOpenCodeModel | null) => void;
  readonly disabled?: boolean;
  /** Shown when nothing is picked. */
  readonly emptyLabel?: string;
  /** Whether the list offers going back to nothing picked. */
  readonly emptyOption?: boolean;
}) {
  const [query, setQuery] = useState("");
  const entries = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      key: modelKey(provider.id, model.id),
      providerId: provider.id,
      providerName: provider.name,
      modelId: model.id,
      name: model.name,
      variants: model.variants,
    })),
  );
  const selectedKey = value === null ? DEFAULT : modelKey(value.providerId, value.modelId);
  const selected = entries.find((entry) => entry.key === selectedKey);
  const normalized = query.trim().toLocaleLowerCase();
  const matches = normalized
    ? entries.filter((entry) =>
        `${entry.name} ${entry.providerName} ${entry.key}`.toLocaleLowerCase().includes(normalized),
      )
    : entries;
  const shown = matches.slice(0, MAX_MATCHES);
  const items = [
    ...(normalized || !emptyOption ? [] : [DEFAULT]),
    ...(value !== null && selected === undefined && !normalized ? [selectedKey] : []),
    ...shown.map((entry) => entry.key),
  ];
  const variants = selected?.variants ?? [];

  const choose = (key: string) => {
    if (key === selectedKey) return;
    if (key === DEFAULT) return onChange(null);
    const entry = entries.find((candidate) => candidate.key === key);
    if (entry === undefined) return;
    // Keep the effort when the new model offers it too.
    const effort =
      value?.effort !== undefined && entry.variants.includes(value.effort)
        ? value.effort
        : undefined;
    onChange({
      providerId: entry.providerId,
      modelId: entry.modelId,
      ...(effort === undefined ? {} : { effort }),
    });
  };

  return (
    <div className="flex min-w-0 gap-2">
      <Combobox
        items={items}
        filteredItems={items}
        value={selectedKey}
        onOpenChange={(open) => {
          if (!open) setQuery("");
        }}
        onValueChange={(key) => {
          if (key !== null) choose(key);
        }}
      >
        <ComboboxTrigger
          render={<Button size="sm" variant="outline" />}
          className="min-w-0 flex-1 justify-between"
          aria-label={`${label} model`}
          disabled={disabled}
        >
          <span className="min-w-0 truncate">
            {value === null
              ? emptyLabel
              : selected
                ? `${selected.name} · ${selected.providerName}`
                : `${selectedKey} (unavailable)`}
          </span>
          <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 opacity-60" />
        </ComboboxTrigger>
        <ComboboxPopup align="start" className="w-96 min-w-0 max-w-[calc(100vw-1rem)]">
          <ComboboxSearchInput
            placeholder="Search OpenCode models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ComboboxEmpty>
            {entries.length === 0 ? "OpenCode reported no models." : "No matching models."}
          </ComboboxEmpty>
          <ComboboxList className="max-h-72 min-w-0 overflow-x-hidden">
            {items.map((key) => {
              const entry = entries.find((candidate) => candidate.key === key);
              return (
                <ComboboxItem key={key} value={key} className="w-full min-w-0">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">
                      {key === DEFAULT ? emptyLabel : (entry?.name ?? `${key} (unavailable)`)}
                    </span>
                    {entry ? (
                      <span className="truncate text-muted-foreground text-xs">{entry.key}</span>
                    ) : null}
                  </span>
                </ComboboxItem>
              );
            })}
          </ComboboxList>
          {matches.length > shown.length ? (
            <ComboboxStatus>
              {matches.length - shown.length} more. Search to narrow the list.
            </ComboboxStatus>
          ) : null}
        </ComboboxPopup>
      </Combobox>
      <div className="w-28 shrink-0">
        {variants.length > 0 || value?.effort !== undefined ? (
          <ChoiceSelect
            label={`${label} effort`}
            value={value?.effort}
            options={variants.map((variant) => ({ id: variant, label: variant }))}
            disabled={disabled || value === null}
            onChange={(effort) => {
              if (value === null) return;
              const { effort: _previous, ...rest } = value;
              onChange({ ...rest, ...(effort === undefined ? {} : { effort }) });
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Assigns one model to every ODD role at once, like the TUI's "set all" row. */
function SetAllPhases({
  providers,
  disabled,
  onSet,
}: {
  readonly providers: OpenCodeProviders;
  readonly disabled: boolean;
  readonly onSet: (model: GentleAiOpenCodeModel) => void;
}) {
  return (
    <div className="w-80 min-w-0 max-w-full">
      <GentleAiOpenCodeModelPicker
        label="All ODD roles"
        providers={providers}
        value={null}
        onChange={(model) => (model === null ? undefined : onSet(model))}
        disabled={disabled}
        emptyLabel="Set all ODD roles"
        emptyOption={false}
      />
    </div>
  );
}
