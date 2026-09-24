import {
  PiGentleActionInput,
  type EnvironmentId,
  type PiGentleRouting,
  type PiGentleSddPreferences,
  type PiGentleState,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type GentleAction = typeof PiGentleActionInput.Type.action;
type GentleArea = "global" | "profiles" | "project" | "sdd";
type ProjectOption = { readonly title: string; readonly workspaceRoot: string };

const DEFAULT_SDD: PiGentleSddPreferences = {
  executionMode: "auto",
  artifactStore: "openspec",
  chainedPrStrategy: "ask-on-risk",
  reviewBudgetLines: 400,
};
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LABELS = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
} satisfies Record<(typeof THINKING)[number], string>;
const PERSONA_LABELS = { gentleman: "Gentleman", neutral: "Neutral" } as const;
// Select value for "no local pin": the repository declaration or global profile applies.
const PROJECT_DEFAULT_PROFILE = "__default__";
const SDD_LABELS = {
  executionMode: { auto: "Automatic", interactive: "Confirm each phase" },
  artifactStore: {
    openspec: "OpenSpec project files",
    engram: "Engram memory",
    hybrid: "Project files + Engram",
    none: "No saved artifacts",
  },
  chainedPrStrategy: {
    "ask-on-risk": "Ask when over budget",
    "auto-chain": "Chain large changes",
    "single-pr": "One pull request",
  },
} as const;
// Matches the control width of the shared provider settings rows.
const ROW_CONTROL = "w-full max-w-full @min-[32rem]/settings-row:w-56";

function errorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : "Gentle AI settings could not be updated.";
}

const INHERIT_MODEL = "__inherit__";

function GentleModelSelect({
  agent,
  value,
  models,
  disabled,
  onChange,
}: {
  readonly agent: string;
  readonly value: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly disabled: boolean;
  readonly onChange: (model: string | undefined) => void;
}) {
  const [query, setQuery] = useState("");
  const options = [INHERIT_MODEL, ...models.map((model) => model.slug)];
  if (value && !options.includes(value)) options.push(value);
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = normalized
    ? options.filter((slug) => {
        if (slug === INHERIT_MODEL) return "inherit model".includes(normalized);
        const model = models.find((entry) => entry.slug === slug);
        return `${model?.name ?? ""} ${model?.subProvider ?? ""} ${slug}`
          .toLocaleLowerCase()
          .includes(normalized);
      })
    : options;
  const selected = models.find((model) => model.slug === value);

  return (
    <Combobox
      items={options}
      filteredItems={filtered}
      value={value ?? INHERIT_MODEL}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
      onValueChange={(model) => {
        if (model) onChange(model === INHERIT_MODEL ? undefined : model);
      }}
    >
      <ComboboxTrigger
        render={<Button size="sm" variant="outline" />}
        className="col-span-3 col-start-1 row-start-2 w-full min-w-0 justify-between @min-[30rem]/gentle-rows:col-span-1 @min-[30rem]/gentle-rows:col-start-2 @min-[30rem]/gentle-rows:row-start-1"
        aria-label={`${agent} model`}
        disabled={disabled}
      >
        <span className="min-w-0 truncate">
          {selected?.name ?? (value ? `Unavailable: ${value}` : "Inherit model")}
        </span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 opacity-60" />
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="w-80 min-w-0 max-w-[calc(100vw-1rem)]">
        <ComboboxSearchInput
          placeholder="Search Pi models…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No matching Pi models.</ComboboxEmpty>
        <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
          {filtered.map((slug) => {
            const model = models.find((entry) => entry.slug === slug);
            return (
              <ComboboxItem key={slug} value={slug} className="w-full min-w-0">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">
                    {slug === INHERIT_MODEL
                      ? "Inherit model"
                      : (model?.name ?? `Unavailable: ${slug}`)}
                  </span>
                  {model ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {model.subProvider ?? "Pi"} · {slug}
                    </span>
                  ) : null}
                </span>
              </ComboboxItem>
            );
          })}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

/** A settings-row select over a label map; `value` is one of its keys, or null when unset. */
function GentleSelect<T extends string>({
  label,
  value,
  labels,
  placeholder,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: T | null;
  readonly labels: Record<T, string>;
  readonly placeholder?: string;
  readonly disabled: boolean;
  readonly onChange: (value: T) => void;
}) {
  const options = Object.keys(labels).filter((key): key is T => Object.hasOwn(labels, key));
  return (
    <Select
      value={value ?? ""}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate === next);
        if (option !== undefined && option !== value) onChange(option);
      }}
      disabled={disabled}
    >
      <SelectTrigger size="sm" className={ROW_CONTROL} aria-label={label}>
        {value === null ? (
          <SelectValue placeholder={placeholder} />
        ) : (
          <SelectValue>{labels[value]}</SelectValue>
        )}
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {labels[option]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Gentle AI controls for a Pi provider instance, rendered as extra sections of its settings card.
 * Every change is written to the environment's Gentle AI config immediately, like other provider
 * settings.
 */
export function PiGentleSettingsSection({
  environmentId,
  instanceId,
  binaryPathValue,
  onBinaryPathChange,
  refreshKey,
  models,
  projects,
  initialProjectCwd,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly binaryPathValue: string;
  readonly onBinaryPathChange: (value: string) => void;
  readonly refreshKey: number;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly projects: ReadonlyArray<ProjectOption>;
  readonly initialProjectCwd?: string | undefined;
  readonly readOnly: boolean;
}) {
  const [selectedCwdChoice, setSelectedCwdChoice] = useState<string | null>(
    initialProjectCwd ?? null,
  );
  const selectedCwd = projects.some((project) => project.workspaceRoot === selectedCwdChoice)
    ? selectedCwdChoice
    : (projects[0]?.workspaceRoot ?? null);
  const stateKey = `${environmentId}:${instanceId}:${selectedCwd ?? ""}`;
  const [loaded, setLoaded] = useState<{ key: string; state: PiGentleState } | null>(null);
  const state = loaded?.key === stateKey ? loaded.state : null;
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [newName, setNewName] = useState("");
  const [newAgent, setNewAgent] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [pending, setPending] = useState(false);
  const [errorState, setErrorState] = useState<{
    key: string;
    text: string;
    area: GentleArea;
  } | null>(null);
  const error = errorState?.key === stateKey ? errorState : null;
  const read = useAtomCommand(serverEnvironment.readPiGentle, {
    reportFailure: false,
    reportDefect: false,
  });
  const update = useAtomCommand(serverEnvironment.updatePiGentle, {
    reportFailure: false,
    reportDefect: false,
  });

  useEffect(() => {
    const requestKey = JSON.stringify([
      environmentId,
      instanceId,
      selectedCwd,
      refresh,
      refreshKey,
    ]);
    let liveRequest: string | null = requestKey;
    void read({
      environmentId,
      input: { instanceId, ...(selectedCwd ? { cwd: selectedCwd } : {}) },
    }).then((result) => {
      if (liveRequest !== requestKey) return;
      if (result._tag === "Success") {
        setLoaded({ key: stateKey, state: result.value });
        setErrorState(null);
        const initial =
          result.value.profiles.find((entry) => entry.name === result.value.active) ??
          result.value.profiles.find((entry) => entry.name === result.value.project?.pinned) ??
          result.value.profiles[0];
        setSelectedProfile(initial?.name ?? null);
      } else if (!isAtomCommandInterrupted(result)) {
        setErrorState({
          key: stateKey,
          text: errorText(squashAtomCommandFailure(result)),
          area: "project",
        });
      }
    });
    return () => {
      liveRequest = null;
    };
  }, [environmentId, instanceId, read, refresh, refreshKey, selectedCwd, stateKey]);

  async function runAction(action: GentleAction) {
    if (pending) return;
    const area: GentleArea =
      action.type === "saveSdd"
        ? "sdd"
        : action.type === "setPersona" || action.type === "pin" || action.type === "clearPin"
          ? "project"
          : action.type === "setGlobalPersona" ||
              action.type === "activate" ||
              action.type === "install" ||
              action.type === "update"
            ? "global"
            : "profiles";
    setPending(true);
    setErrorState(null);
    try {
      const result = await update({ environmentId, input: { instanceId, action } });
      if (result._tag === "Success") {
        setLoaded({ key: stateKey, state: result.value });
        if (action.type === "create") {
          setSelectedProfile(action.name);
          setNewName("");
        }
      } else if (!isAtomCommandInterrupted(result)) {
        setErrorState({
          key: stateKey,
          text: errorText(squashAtomCommandFailure(result)),
          area,
        });
      }
    } catch (cause) {
      setErrorState({ key: stateKey, text: errorText(cause), area });
    } finally {
      setPending(false);
    }
  }

  const readOnlyProps = {
    inert: readOnly,
    "aria-disabled": readOnly || undefined,
    className: readOnly ? "opacity-50 select-none" : undefined,
  };
  const canEdit = !readOnly && !pending;
  const cwdInput = selectedCwd ? { cwd: selectedCwd } : {};
  const errorFor = (area: GentleArea) =>
    error?.area === area ? (
      <span role="alert" className="text-destructive">
        {error.text}
      </span>
    ) : null;

  if (state === null) {
    return (
      <SettingsSection title="Gentle AI" {...readOnlyProps}>
        <SettingsRow
          title={error ? "Gentle AI is unavailable" : "Checking Gentle AI"}
          status={errorFor("project")}
          control={
            error ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setErrorState(null);
                  setRefresh((value) => value + 1);
                }}
              >
                Retry
              </Button>
            ) : (
              <Spinner className="size-3.5" />
            )
          }
        />
      </SettingsSection>
    );
  }

  if (!state.available) {
    return (
      <SettingsSection title="Gentle AI" {...readOnlyProps}>
        <SettingsRow
          title="Install for Pi"
          description="Add profiles, personas, and SDD to this Pi environment."
          status={errorFor("global")}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit}
              onClick={() => void runAction({ type: "install", ...cwdInput })}
            >
              {pending ? "Working…" : "Install Gentle AI"}
            </Button>
          }
        />
      </SettingsSection>
    );
  }

  const profile = state.profiles.find((entry) => entry.name === selectedProfile);
  const routing = profile?.routing ?? {};
  const visibleRouting = Object.entries(routing).filter(([agent]) =>
    agent.toLocaleLowerCase().includes(agentFilter.trim().toLocaleLowerCase()),
  );
  const saveRouting = (update: (current: PiGentleRouting) => PiGentleRouting) => {
    if (profile) {
      void runAction({ type: "save", name: profile.name, routing: update(routing), ...cwdInput });
    }
  };
  const profileNames = Object.fromEntries(
    state.profiles.map((entry) => [entry.name, entry.name] as const),
  );
  const newProfileName = newName.trim();
  const newAgentName = newAgent.trim();
  const canCreateProfile =
    canEdit && newProfileName.length > 0 && !Object.hasOwn(profileNames, newProfileName);
  const canAddAgent = canEdit && newAgentName.length > 0 && !Object.hasOwn(routing, newAgentName);
  const createProfile = () => {
    if (canCreateProfile) void runAction({ type: "create", name: newProfileName, ...cwdInput });
  };
  const addAgent = () => {
    if (!canAddAgent) return;
    saveRouting((current) => ({ ...current, [newAgentName]: {} }));
    setNewAgent("");
  };

  const project = selectedCwd ? state.project : null;
  const pinned = project?.pinned ?? null;
  const localPin = project?.pinSource === "local" ? pinned : null;
  const selectedProject = projects.find((entry) => entry.workspaceRoot === selectedCwd);
  const sdd = project?.sdd ?? DEFAULT_SDD;
  const saveSdd = (patch: Partial<PiGentleSddPreferences>) => {
    if (selectedCwd) {
      void runAction({ type: "saveSdd", cwd: selectedCwd, preferences: { ...sdd, ...patch } });
    }
  };

  return (
    <>
      <SettingsSection
        title="Gentle AI"
        headerAction={
          state.version ? (
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">v{state.version}</span>
              <Button
                size="xs"
                variant="ghost"
                disabled={!canEdit}
                onClick={() => void runAction({ type: "update", ...cwdInput })}
              >
                Update
              </Button>
            </div>
          ) : null
        }
        {...readOnlyProps}
      >
        <SettingsRow
          title="Binary path"
          description="Leave blank to use Gentle AI bundled with this Pi installation."
          control={
            <DraftInput
              size="sm"
              className={ROW_CONTROL}
              aria-label="Gentle AI binary path"
              value={binaryPathValue}
              onCommit={onBinaryPathChange}
              placeholder="gentle-ai"
              disabled={!canEdit}
              spellCheck={false}
            />
          }
        />
        <SettingsRow
          title="Persona"
          description="Default persona for every project."
          control={
            <GentleSelect
              label="Global Gentle AI persona"
              value={state.globalPersona ?? "gentleman"}
              labels={PERSONA_LABELS}
              disabled={!canEdit}
              onChange={(mode) => void runAction({ type: "setGlobalPersona", mode, ...cwdInput })}
            />
          }
        />
        <SettingsRow
          title="Active profile"
          description="Subagent routing used by every project without its own profile."
          status={errorFor("global")}
          control={
            <GentleSelect
              label="Active Gentle AI profile"
              value={state.active}
              labels={profileNames}
              placeholder={state.profiles.length ? "None" : "No profiles"}
              disabled={!canEdit || state.profiles.length === 0}
              onChange={(name) => void runAction({ type: "activate", name, ...cwdInput })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Subagent models" {...readOnlyProps}>
        <SettingsRow
          title="Profile"
          description="Model and effort for each subagent. The main model stays in the composer. Changes apply when Pi reloads."
          status={errorFor("profiles")}
          control={
            <GentleSelect
              label="Gentle AI profile to edit"
              value={profile ? profile.name : null}
              labels={Object.fromEntries(
                state.profiles.map((entry) => [
                  entry.name,
                  entry.name === state.active ? `${entry.name} · active` : entry.name,
                ]),
              )}
              placeholder={state.profiles.length ? "Choose profile" : "No profiles"}
              disabled={state.profiles.length === 0}
              onChange={setSelectedProfile}
            />
          }
        >
          {profile ? (
            <div className="@container/gentle-rows mt-3 space-y-2 pb-2">
              {Object.keys(routing).length > 8 ? (
                <Input
                  size="sm"
                  aria-label="Filter subagents"
                  placeholder="Find a subagent"
                  value={agentFilter}
                  onChange={(event) => setAgentFilter(event.target.value)}
                />
              ) : null}
              <div className="max-h-[min(55vh,32rem)] space-y-2 overflow-y-auto pr-1">
                {visibleRouting.map(([agent, entry]) => (
                  <div
                    key={agent}
                    className="grid grid-cols-[minmax(0,1fr)_7rem_auto] gap-x-2 gap-y-1.5 @min-[30rem]/gentle-rows:grid-cols-[minmax(7rem,1fr)_minmax(0,2fr)_minmax(7rem,1fr)_auto] @min-[30rem]/gentle-rows:items-center"
                  >
                    <span className="col-span-3 col-start-1 row-start-1 min-w-0 wrap-anywhere font-mono text-xs @min-[30rem]/gentle-rows:col-span-1">
                      {agent}
                    </span>
                    <GentleModelSelect
                      agent={agent}
                      value={entry.model}
                      models={models}
                      disabled={!canEdit}
                      onChange={(model) =>
                        saveRouting((current) => {
                          const { model: _model, ...rest } = current[agent] ?? {};
                          return { ...current, [agent]: { ...rest, ...(model ? { model } : {}) } };
                        })
                      }
                    />
                    <span className="col-start-1 row-start-3 self-center text-xs text-muted-foreground @min-[30rem]/gentle-rows:hidden">
                      Effort
                    </span>
                    <Select
                      value={entry.thinking ?? "inherit"}
                      onValueChange={(value) => {
                        if (!value || value === (entry.thinking ?? "inherit")) return;
                        const thinking = THINKING.find((level) => level === value);
                        saveRouting((current) => {
                          const { thinking: _thinking, ...rest } = current[agent] ?? {};
                          return {
                            ...current,
                            [agent]: { ...rest, ...(thinking ? { thinking } : {}) },
                          };
                        });
                      }}
                      disabled={!canEdit}
                    >
                      <SelectTrigger
                        size="sm"
                        className="col-start-2 row-start-3 w-full min-w-0 @min-[30rem]/gentle-rows:col-start-3 @min-[30rem]/gentle-rows:row-start-1"
                        aria-label={`${agent} thinking level`}
                      >
                        <SelectValue>
                          {entry.thinking ? THINKING_LABELS[entry.thinking] : "Inherit effort"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="inherit">Inherit effort</SelectItem>
                        {THINKING.map((level) => (
                          <SelectItem key={level} value={level}>
                            {THINKING_LABELS[level]}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="col-start-3 row-start-3 justify-self-end @min-[30rem]/gentle-rows:col-start-4 @min-[30rem]/gentle-rows:row-start-1"
                      aria-label={`Remove ${agent}`}
                      disabled={!canEdit}
                      onClick={() =>
                        saveRouting((current) => {
                          const next = { ...current };
                          delete next[agent];
                          return next;
                        })
                      }
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                ))}
                {visibleRouting.length === 0 ? (
                  <p className="py-3 text-xs text-muted-foreground">
                    {agentFilter.trim()
                      ? "No matching subagents."
                      : "No subagents in this profile."}
                  </p>
                ) : null}
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                <Input
                  size="sm"
                  font="mono"
                  className="w-full min-w-0 sm:w-44"
                  aria-label="New subagent name"
                  placeholder="subagent-name"
                  value={newAgent}
                  disabled={!canEdit}
                  onChange={(event) => setNewAgent(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addAgent();
                  }}
                />
                <Button size="sm" variant="outline" disabled={!canAddAgent} onClick={addAgent}>
                  <PlusIcon className="size-3" />
                  Add subagent
                </Button>
              </div>
            </div>
          ) : null}
        </SettingsRow>
        <SettingsRow
          title="New profile"
          description="Create another routing profile to switch between."
          control={
            <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-auto">
              <Input
                size="sm"
                className="min-w-0 flex-1 @min-[32rem]/settings-row:w-40 @min-[32rem]/settings-row:flex-none"
                aria-label="New profile name"
                placeholder="e.g. review-fast"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") createProfile();
                }}
                disabled={!canEdit}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!canCreateProfile}
                onClick={createProfile}
              >
                <PlusIcon className="size-3" />
                Create
              </Button>
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Project overrides"
        headerAction={
          projects.length > 0 ? (
            <Select
              value={selectedCwd ?? ""}
              onValueChange={(value) => {
                if (value) setSelectedCwdChoice(value);
              }}
            >
              <SelectTrigger
                size="xs"
                variant="ghost"
                className="max-w-56"
                aria-label="Project for Gentle AI settings"
              >
                <SelectValue>{selectedProject?.title}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                {projects.map((entry) => (
                  <SelectItem key={entry.workspaceRoot} value={entry.workspaceRoot}>
                    {entry.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null
        }
        {...readOnlyProps}
      >
        {selectedCwd && project ? (
          <>
            <SettingsRow
              title="Profile"
              description={
                !project.pinAvailable
                  ? "Profile pins require a Git repository."
                  : project.pinSource === "repo"
                    ? "Declared by the repository. Pick a profile to override it for this clone."
                    : "Overrides the active profile for this clone."
              }
              status={errorFor("project")}
              control={
                <GentleSelect
                  label="Gentle AI profile for this project"
                  value={localPin ?? PROJECT_DEFAULT_PROFILE}
                  labels={{
                    ...profileNames,
                    [PROJECT_DEFAULT_PROFILE]:
                      project.pinSource === "repo"
                        ? `Repository (${pinned})`
                        : `Use global (${state.active ?? "none"})`,
                  }}
                  disabled={!canEdit || !project.pinAvailable}
                  onChange={(name) =>
                    void runAction(
                      name === PROJECT_DEFAULT_PROFILE
                        ? { type: "clearPin", cwd: selectedCwd }
                        : { type: "pin", cwd: selectedCwd, name },
                    )
                  }
                />
              }
            />
            <SettingsRow
              title="Persona"
              description="Overrides the default persona for this project."
              control={
                <GentleSelect
                  label="Gentle AI persona for this project"
                  value={project.persona.override ?? "global"}
                  labels={{
                    global: `Use global (${PERSONA_LABELS[project.persona.global]})`,
                    ...PERSONA_LABELS,
                  }}
                  disabled={!canEdit}
                  onChange={(mode) =>
                    void runAction({
                      type: "setPersona",
                      cwd: selectedCwd,
                      mode: mode === "global" ? null : mode,
                    })
                  }
                />
              }
            />
            <SettingsRow
              title="SDD execution"
              description="How Gentle AI moves between spec-driven development phases."
              status={errorFor("sdd")}
              control={
                <GentleSelect
                  label="SDD execution mode"
                  value={sdd.executionMode}
                  labels={SDD_LABELS.executionMode}
                  disabled={!canEdit}
                  onChange={(executionMode) => saveSdd({ executionMode })}
                />
              }
            />
            <SettingsRow
              title="SDD artifacts"
              description="Where proposals, specs, and tasks are saved."
              control={
                <GentleSelect
                  label="SDD artifact store"
                  value={sdd.artifactStore}
                  labels={SDD_LABELS.artifactStore}
                  disabled={!canEdit}
                  onChange={(artifactStore) => saveSdd({ artifactStore })}
                />
              }
            />
            <SettingsRow
              title="SDD delivery"
              description="How large changes are split into pull requests."
              control={
                <GentleSelect
                  label="SDD delivery strategy"
                  value={sdd.chainedPrStrategy}
                  labels={SDD_LABELS.chainedPrStrategy}
                  disabled={!canEdit}
                  onChange={(chainedPrStrategy) => saveSdd({ chainedPrStrategy })}
                />
              }
            />
            <SettingsRow
              title="Review budget"
              description="Changed lines per pull request before delivery applies."
              control={
                <div className="flex w-full items-center gap-2 @min-[32rem]/settings-row:w-auto">
                  <DraftInput
                    type="number"
                    min={1}
                    step={1}
                    size="sm"
                    className="min-w-0 flex-1 @min-[32rem]/settings-row:w-24 @min-[32rem]/settings-row:flex-none"
                    aria-label="SDD review budget in lines"
                    value={String(sdd.reviewBudgetLines)}
                    disabled={!canEdit}
                    onCommit={(next) => {
                      const lines = Number(next);
                      if (Number.isInteger(lines) && lines > 0)
                        saveSdd({ reviewBudgetLines: lines });
                    }}
                  />
                  <span className="text-xs text-muted-foreground">lines</span>
                </div>
              }
            />
          </>
        ) : (
          <SettingsRow
            title="No project selected"
            description="Add a project on this environment to override Gentle AI for it."
          />
        )}
      </SettingsSection>
    </>
  );
}
