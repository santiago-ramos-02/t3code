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
import { GentleRoseIcon } from "../GentleRoseIcon";
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
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { SettingsSection } from "./settingsLayout";

type GentleAction = typeof PiGentleActionInput.Type.action;
type GentleArea = "project" | "profile" | "persona" | "sdd";
type ProjectOption = { readonly title: string; readonly workspaceRoot: string };

const DEFAULT_SDD: PiGentleSddPreferences = {
  executionMode: "auto",
  artifactStore: "openspec",
  chainedPrStrategy: "ask-on-risk",
  reviewBudgetLines: 400,
};
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
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

export function PiGentleSettingsSection({
  environmentId,
  instanceId,
  refreshKey,
  models,
  projects,
  initialProjectCwd,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
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
  const [routingDrafts, setRoutingDrafts] = useState<Record<string, PiGentleRouting>>({});
  const [newName, setNewName] = useState("");
  const [newAgent, setNewAgent] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [sddDrafts, setSddDrafts] = useState<Record<string, PiGentleSddPreferences>>({});
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
          result.value.profiles.find((entry) => entry.name === result.value.project?.pinned) ??
          result.value.profiles.find((entry) => entry.name === result.value.active) ??
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
        : action.type === "setPersona"
          ? "persona"
          : action.type === "pin" || action.type === "clearPin"
            ? "project"
            : "profile";
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
        if (action.type === "save") {
          const key = JSON.stringify([stateKey, action.name]);
          setRoutingDrafts((drafts) => {
            const next = { ...drafts };
            delete next[key];
            return next;
          });
        }
        if (action.type === "saveSdd") {
          setSddDrafts((drafts) => {
            const next = { ...drafts };
            delete next[stateKey];
            return next;
          });
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

  if (state?.available === false) return null;

  const profile = state?.profiles.find((entry) => entry.name === selectedProfile);
  const routingDraftKey = JSON.stringify([stateKey, selectedProfile]);
  const routing = routingDrafts[routingDraftKey] ?? profile?.routing ?? {};
  const sdd = sddDrafts[stateKey] ?? state?.project?.sdd ?? DEFAULT_SDD;
  const visibleRouting = Object.entries(routing).filter(([agent]) =>
    agent.toLocaleLowerCase().includes(agentFilter.trim().toLocaleLowerCase()),
  );
  const setRouting = (update: (current: PiGentleRouting) => PiGentleRouting) =>
    setRoutingDrafts((drafts) => ({
      ...drafts,
      [routingDraftKey]: update(drafts[routingDraftKey] ?? profile?.routing ?? {}),
    }));
  const setSdd = (update: (current: PiGentleSddPreferences) => PiGentleSddPreferences) =>
    setSddDrafts((drafts) => ({
      ...drafts,
      [stateKey]: update(drafts[stateKey] ?? state?.project?.sdd ?? DEFAULT_SDD),
    }));
  const pinned = state?.project?.pinned;
  const selectedProject = projects.find((project) => project.workspaceRoot === selectedCwd);
  const canEdit = !readOnly && !pending;
  const routingChanged =
    profile !== undefined &&
    (Object.keys(routing).length !== Object.keys(profile.routing).length ||
      Object.entries(routing).some(
        ([agent, entry]) =>
          entry.model !== profile.routing[agent]?.model ||
          entry.thinking !== profile.routing[agent]?.thinking,
      ));
  const savedSdd = state?.project?.sdd;
  const sddChanged =
    savedSdd === null ||
    savedSdd === undefined ||
    sdd.executionMode !== savedSdd.executionMode ||
    sdd.artifactStore !== savedSdd.artifactStore ||
    sdd.chainedPrStrategy !== savedSdd.chainedPrStrategy ||
    sdd.reviewBudgetLines !== savedSdd.reviewBudgetLines;
  const reviewBudgetValid = Number.isInteger(sdd.reviewBudgetLines) && sdd.reviewBudgetLines > 0;

  return (
    <SettingsSection
      title={`Gentle AI${state?.version ? ` · ${state.version}` : ""}`}
      icon={<GentleRoseIcon className="size-5 text-foreground" />}
    >
      {state === null ? (
        <div className="flex items-center gap-2 px-3 py-3 text-sm sm:px-4">
          {error ? (
            <>
              <span role="alert" className="text-destructive">
                {error.text}
              </span>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setErrorState(null);
                  setRefresh((value) => value + 1);
                }}
              >
                Retry
              </Button>
            </>
          ) : (
            <>
              <Spinner className="size-3.5" /> Checking Gentle AI
            </>
          )}
        </div>
      ) : (
        <>
          <div className="space-y-3 px-3 py-3 sm:px-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">Project</h3>
              </div>
              {projects.length > 0 ? (
                <Select
                  value={selectedCwd ?? ""}
                  onValueChange={(value) => {
                    if (value) setSelectedCwdChoice(value);
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full min-w-0 sm:w-52"
                    aria-label="Project for Gentle AI settings"
                  >
                    <SelectValue>{selectedProject?.title}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {projects.map((project) => (
                      <SelectItem key={project.workspaceRoot} value={project.workspaceRoot}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : null}
            </div>
            {selectedCwd === null ? (
              <p className="text-xs text-muted-foreground">
                Add a project to select its Gentle profile and SDD preferences.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <p>
                  <span className="font-medium">This project: </span>
                  {pinned
                    ? `${pinned}${state.project?.pinSource === "repo" ? " (repository)" : ""}`
                    : `Global (${state.active ?? "none"})`}
                </p>
                {pinned ? (
                  <p className="text-muted-foreground">Global: {state.active ?? "none"}</p>
                ) : null}
                {!state.project?.pinAvailable && !pinned ? (
                  <p className="text-muted-foreground">Profile pins require a Git repository.</p>
                ) : null}
                {pinned && state.project?.pinSource === "local" && canEdit ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void runAction({ type: "clearPin", cwd: selectedCwd })}
                  >
                    Remove pin
                  </Button>
                ) : null}
              </div>
            )}
            {error?.area === "project" ? (
              <p role="alert" className="text-xs text-destructive">
                {error.text}
              </p>
            ) : null}
          </div>

          <div className="space-y-3 px-3 py-3 sm:px-4">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                <label className="mb-1 block text-xs font-medium" htmlFor="gentle-profile-select">
                  Model profiles
                </label>
                <Select
                  value={selectedProfile ?? ""}
                  onValueChange={(value) => {
                    if (!value) return;
                    setSelectedProfile(value);
                  }}
                >
                  <SelectTrigger
                    id="gentle-profile-select"
                    size="sm"
                    className="w-full"
                    aria-label="Gentle AI profile"
                  >
                    <SelectValue
                      placeholder={state.profiles.length ? "Choose profile" : "No profiles"}
                    />
                  </SelectTrigger>
                  <SelectPopup>
                    {state.profiles.map((entry) => (
                      <SelectItem key={entry.name} value={entry.name}>
                        {entry.name}
                        {entry.name === state.active ? " · globally active" : ""}
                        {entry.name === pinned ? " · this project" : ""}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={!canEdit || !profile || state.active === profile.name || routingChanged}
                onClick={() => {
                  if (profile)
                    void runAction({
                      type: "activate",
                      name: profile.name,
                      ...(selectedCwd ? { cwd: selectedCwd } : {}),
                    });
                }}
              >
                Use globally
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !canEdit ||
                  !selectedCwd ||
                  !state.project?.pinAvailable ||
                  !profile ||
                  pinned === profile.name ||
                  routingChanged
                }
                onClick={() => {
                  if (selectedCwd && profile)
                    void runAction({ type: "pin", cwd: selectedCwd, name: profile.name });
                }}
              >
                Use for project
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Subagent routing updates when Pi reloads. The main model stays in the composer.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <label className="mb-1 block text-xs font-medium" htmlFor="gentle-new-profile">
                  New profile name
                </label>
                <Input
                  id="gentle-new-profile"
                  size="sm"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="e.g. review-fast"
                  disabled={!canEdit}
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={!canEdit || !newName.trim()}
                onClick={() => {
                  void runAction({
                    type: "create",
                    name: newName.trim(),
                    ...(selectedCwd ? { cwd: selectedCwd } : {}),
                  });
                }}
              >
                <PlusIcon className="size-3.5" /> Create
              </Button>
            </div>
            {profile ? (
              <div className="@container/gentle-rows space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-xs font-medium">Subagent models</h4>
                  <Button
                    size="xs"
                    disabled={!canEdit || !routingChanged}
                    onClick={() =>
                      void runAction({
                        type: "save",
                        name: profile.name,
                        routing,
                        ...(selectedCwd ? { cwd: selectedCwd } : {}),
                      })
                    }
                  >
                    Save profile
                  </Button>
                </div>
                <Input
                  size="sm"
                  aria-label="Filter subagents"
                  placeholder="Find a subagent"
                  value={agentFilter}
                  onChange={(event) => setAgentFilter(event.target.value)}
                />
                <div className="max-h-[min(55vh,32rem)] space-y-2 overflow-y-auto pr-1">
                  <div className="hidden grid-cols-[minmax(7rem,1fr)_minmax(0,2fr)_minmax(7rem,1fr)_auto] items-center gap-2 text-xs text-muted-foreground @min-[30rem]/gentle-rows:grid">
                    <span>Agent</span>
                    <span>Model</span>
                    <span>Effort</span>
                  </div>
                  {visibleRouting.map(([agent, entry]) => (
                    <div
                      key={agent}
                      className="grid grid-cols-[minmax(0,1fr)_7rem_auto] gap-x-2 gap-y-1.5 @min-[30rem]/gentle-rows:grid-cols-[minmax(7rem,1fr)_minmax(0,2fr)_minmax(7rem,1fr)_auto] @min-[30rem]/gentle-rows:items-center"
                    >
                      <span className="col-span-3 col-start-1 row-start-1 min-w-0 wrap-anywhere text-xs @min-[30rem]/gentle-rows:col-span-1">
                        {agent}
                      </span>
                      <GentleModelSelect
                        agent={agent}
                        value={entry.model}
                        models={models}
                        disabled={!canEdit}
                        onChange={(model) =>
                          setRouting((current) => {
                            const { model: _model, ...rest } = current[agent] ?? {};
                            return {
                              ...current,
                              [agent]: {
                                ...rest,
                                ...(model ? { model } : {}),
                              },
                            };
                          })
                        }
                      />
                      <span className="col-start-1 row-start-3 self-center text-xs text-muted-foreground @min-[30rem]/gentle-rows:hidden">
                        Effort
                      </span>
                      <Select
                        value={entry.thinking ?? "inherit"}
                        onValueChange={(value) => {
                          if (!value) return;
                          const thinking = THINKING.find((level) => level === value);
                          setRouting((current) => {
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
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value="inherit">Inherit effort</SelectItem>
                          {THINKING.map((level) => (
                            <SelectItem key={level} value={level}>
                              {level}
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
                          setRouting((current) => {
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
                    <p className="py-3 text-xs text-muted-foreground">No matching subagents.</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    size="sm"
                    className="max-w-48"
                    aria-label="New subagent name"
                    placeholder="Agent name"
                    value={newAgent}
                    disabled={!canEdit}
                    onChange={(event) => setNewAgent(event.target.value)}
                  />
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={
                      !canEdit || !newAgent.trim() || Object.hasOwn(routing, newAgent.trim())
                    }
                    onClick={() => {
                      setRouting((current) => ({ ...current, [newAgent.trim()]: {} }));
                      setNewAgent("");
                    }}
                  >
                    Add agent
                  </Button>
                </div>
              </div>
            ) : null}
            {error?.area === "profile" ? (
              <p role="alert" className="text-xs text-destructive">
                {error.text}
              </p>
            ) : null}
          </div>

          {selectedCwd && state.project ? (
            <div className="space-y-2 px-3 py-3 sm:px-4">
              <label className="block text-xs font-medium" htmlFor="gentle-persona-select">
                Persona for this project
              </label>
              <Select
                value={state.project.persona.override ?? "global"}
                onValueChange={(value) => {
                  if (value === "global" || value === "gentleman" || value === "neutral") {
                    void runAction({
                      type: "setPersona",
                      cwd: selectedCwd,
                      mode: value === "global" ? null : value,
                    });
                  }
                }}
                disabled={!canEdit}
              >
                <SelectTrigger id="gentle-persona-select" size="sm" className="w-full sm:w-72">
                  <SelectValue>
                    {state.project.persona.override === null
                      ? `Use global (${state.project.persona.global})`
                      : state.project.persona.override === "gentleman"
                        ? "Gentleman"
                        : "Neutral"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="global">
                    Use global ({state.project.persona.global})
                  </SelectItem>
                  <SelectItem value="gentleman">Gentleman</SelectItem>
                  <SelectItem value="neutral">Neutral</SelectItem>
                </SelectPopup>
              </Select>
              <p className="text-xs text-muted-foreground">Applies when a new Pi session starts.</p>
              {error?.area === "persona" ? (
                <p role="alert" className="text-xs text-destructive">
                  {error.text}
                </p>
              ) : null}
            </div>
          ) : null}

          {selectedCwd ? (
            <div className="space-y-3 px-3 py-3 sm:px-4">
              <div>
                <h3 className="text-sm font-medium">SDD preferences</h3>
                <p className="text-xs text-muted-foreground">
                  Used by Gentle AI in interactive Pi sessions. SDD setup is unavailable through Pi
                  RPC.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="space-y-1 text-xs">
                  Execution mode
                  <Select
                    value={sdd.executionMode}
                    onValueChange={(value) => {
                      if (value === "auto" || value === "interactive")
                        setSdd((current) => ({ ...current, executionMode: value }));
                    }}
                    disabled={!canEdit}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue>{SDD_LABELS.executionMode[sdd.executionMode]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="auto">{SDD_LABELS.executionMode.auto}</SelectItem>
                      <SelectItem value="interactive">
                        {SDD_LABELS.executionMode.interactive}
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                </label>
                <label className="space-y-1 text-xs">
                  Artifact store
                  <Select
                    value={sdd.artifactStore}
                    onValueChange={(value) => {
                      if (
                        value === "openspec" ||
                        value === "engram" ||
                        value === "hybrid" ||
                        value === "none"
                      )
                        setSdd((current) => ({ ...current, artifactStore: value }));
                    }}
                    disabled={!canEdit}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue>{SDD_LABELS.artifactStore[sdd.artifactStore]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="openspec">{SDD_LABELS.artifactStore.openspec}</SelectItem>
                      <SelectItem value="engram">{SDD_LABELS.artifactStore.engram}</SelectItem>
                      <SelectItem value="hybrid">{SDD_LABELS.artifactStore.hybrid}</SelectItem>
                      <SelectItem value="none">{SDD_LABELS.artifactStore.none}</SelectItem>
                    </SelectPopup>
                  </Select>
                </label>
                <label className="space-y-1 text-xs">
                  Delivery strategy
                  <Select
                    value={sdd.chainedPrStrategy}
                    onValueChange={(value) => {
                      if (
                        value === "ask-on-risk" ||
                        value === "auto-chain" ||
                        value === "single-pr"
                      )
                        setSdd((current) => ({ ...current, chainedPrStrategy: value }));
                    }}
                    disabled={!canEdit}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue>
                        {SDD_LABELS.chainedPrStrategy[sdd.chainedPrStrategy]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="ask-on-risk">
                        {SDD_LABELS.chainedPrStrategy["ask-on-risk"]}
                      </SelectItem>
                      <SelectItem value="auto-chain">
                        {SDD_LABELS.chainedPrStrategy["auto-chain"]}
                      </SelectItem>
                      <SelectItem value="single-pr">
                        {SDD_LABELS.chainedPrStrategy["single-pr"]}
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                </label>
                <label className="space-y-1 text-xs">
                  Review budget (lines)
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    size="sm"
                    value={sdd.reviewBudgetLines}
                    aria-invalid={!reviewBudgetValid}
                    disabled={!canEdit}
                    onChange={(event) =>
                      setSdd((current) => ({
                        ...current,
                        reviewBudgetLines: Number(event.target.value),
                      }))
                    }
                  />
                  {!reviewBudgetValid ? (
                    <span className="block text-destructive">Enter a positive whole number.</span>
                  ) : null}
                </label>
              </div>
              <div className="flex justify-end">
                <Button
                  size="xs"
                  disabled={!canEdit || !sddChanged || !reviewBudgetValid}
                  onClick={() =>
                    void runAction({ type: "saveSdd", cwd: selectedCwd, preferences: sdd })
                  }
                >
                  Save SDD choices
                </Button>
              </div>
              {error?.area === "sdd" ? (
                <p role="alert" className="text-xs text-destructive">
                  {error.text}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}
