import {
  PiGentleActionInput,
  type EnvironmentId,
  type PiGentleState,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { gentlePiProfileSummary } from "@t3tools/client-runtime/gentle-ai";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { GentleRoseIcon } from "../GentleRoseIcon";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { GentleAiProfileList } from "./gentle-ai/GentleAiProfileList";
import { PiRoutingEditor } from "./gentle-ai/PiRoutingEditor";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type GentleAction = typeof PiGentleActionInput.Type.action;
type GentleArea = "global" | "profiles" | "project";
type ProjectOption = { readonly title: string; readonly workspaceRoot: string };

const PERSONA_LABELS = { gentleman: "Gentleman", neutral: "Neutral" } as const;
// Select value for "no local pin": the repository declaration or global profile applies.
const PROJECT_DEFAULT_PROFILE = "__default__";
// Matches the control width of the shared provider settings rows.
const ROW_CONTROL = "w-full max-w-full @min-[32rem]/settings-row:w-56";

function errorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : "Gentle AI settings could not be updated.";
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
 * What gentle-pi adds to Gentle AI for one Pi provider instance: model profiles, persona, and
 * per-project overrides. Rendered on the Gentle AI settings page. Every change is written to
 * gentle-pi's config immediately, like other settings.
 */
export function PiGentleSettingsSection({
  environmentId,
  instanceId,
  title,
  refreshKey,
  models,
  projects,
  initialProjectCwd,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  // Names the Pi instance, since an environment can run several.
  readonly title: string;
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
  const [refresh, setRefresh] = useState(0);
  // The action in flight, so its own control can say what is happening.
  const [pending, setPending] = useState<GentleAction["type"] | null>(null);
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

  async function runAction(action: GentleAction): Promise<boolean> {
    if (pending) return false;
    const area: GentleArea =
      action.type === "setPersona" || action.type === "pin" || action.type === "clearPin"
        ? "project"
        : action.type === "setGlobalPersona" ||
            action.type === "activate" ||
            action.type === "update"
          ? "global"
          : "profiles";
    setPending(action.type);
    setErrorState(null);
    try {
      const result = await update({ environmentId, input: { instanceId, action } });
      if (result._tag === "Success") {
        setLoaded({ key: stateKey, state: result.value });
        return true;
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
      setPending(null);
    }
    return false;
  }

  const readOnlyProps = {
    inert: readOnly,
    "aria-disabled": readOnly || undefined,
    className: readOnly ? "opacity-50 select-none" : undefined,
  };
  const sectionIcon = <GentleRoseIcon className="size-5 shrink-0" />;
  const canEdit = !readOnly && pending === null;
  const cwdInput = selectedCwd ? { cwd: selectedCwd } : {};
  const errorFor = (area: GentleArea) =>
    error?.area === area ? (
      <span role="alert" className="text-destructive">
        {error.text}
      </span>
    ) : null;

  // Gentle AI is an optional Pi package: nothing about it shows until the server confirms Pi
  // loads it. The server only fails a read once gentle-pi is installed, so a failure is shown.
  if (state === null) {
    return error ? (
      <SettingsSection title={title} icon={sectionIcon} {...readOnlyProps}>
        <SettingsRow
          title="Gentle AI settings could not be read"
          status={errorFor("project")}
          control={
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
          }
        />
      </SettingsSection>
    ) : null;
  }

  if (!state.available) {
    return state.version === null ? null : (
      <SettingsSection title={title} icon={sectionIcon} {...readOnlyProps}>
        <SettingsRow
          title="Update for Pi"
          description={`Gentle AI ${state.version} is installed. T3 Code supports 3.5 or newer.`}
          status={errorFor("global")}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit}
              onClick={() => void runAction({ type: "update", ...cwdInput })}
            >
              {pending === "update" ? "Updating…" : "Update Gentle AI"}
            </Button>
          }
        />
      </SettingsSection>
    );
  }

  const nameOf = (slug: string) => models.find((model) => model.slug === slug)?.name;
  const createProfile = async (name: string) => {
    if (!(await runAction({ type: "create", name, ...cwdInput }))) return false;
    // A new profile starts as a copy of the active one, not empty.
    const copy = state.profiles.find((entry) => entry.name === state.active)?.routing;
    return copy === undefined
      ? true
      : runAction({ type: "save", name, routing: copy, ...cwdInput });
  };

  const project = selectedCwd ? state.project : null;
  const pinned = project?.pinned ?? null;
  const localPin = project?.pinSource === "local" ? pinned : null;
  const selectedProject = projects.find((entry) => entry.workspaceRoot === selectedCwd);
  return (
    <>
      <SettingsSection
        title={title}
        icon={sectionIcon}
        headerAction={
          state.version ? (
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                v{state.version}
                {state.commit ? ` · ${state.commit}` : ""}
              </span>
              {state.updateAvailable || pending === "update" ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canEdit}
                  onClick={() => void runAction({ type: "update", ...cwdInput })}
                >
                  {pending === "update" ? "Updating…" : "Update"}
                </Button>
              ) : null}
            </div>
          ) : null
        }
        {...readOnlyProps}
      >
        {state.compatibilityWarning ? (
          <SettingsRow title="Untested version" description={state.compatibilityWarning} />
        ) : null}
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
      </SettingsSection>

      <div {...readOnlyProps}>
        <GentleAiProfileList
          title="Profiles"
          profiles={state.profiles.map((entry) => ({
            name: entry.name,
            summary: gentlePiProfileSummary(entry.routing, nameOf),
          }))}
          active={state.active}
          loading={false}
          error={error?.area === "profiles" || error?.area === "global" ? error.text : null}
          emptyText="A profile sets the model and effort each of gentle-pi's roles runs."
          disabled={!canEdit}
          onUse={(name) => void runAction({ type: "activate", name, ...cwdInput })}
          onCreate={createProfile}
          renderEditor={(name) => (
            <PiRoutingEditor
              routing={state.profiles.find((entry) => entry.name === name)?.routing ?? {}}
              models={models}
              disabled={!canEdit}
              onChange={(routing) => void runAction({ type: "save", name, routing, ...cwdInput })}
            />
          )}
        />
      </div>

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
                    : "Overrides the active profile for this clone. Saved only on this machine."
              }
              status={errorFor("project")}
              control={
                <GentleSelect
                  label="Gentle AI profile for this project"
                  value={localPin ?? PROJECT_DEFAULT_PROFILE}
                  labels={{
                    ...Object.fromEntries(state.profiles.map((entry) => [entry.name, entry.name])),
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
              description="Overrides the default persona for this project. Saved in the project's .pi folder, so committing it applies to your team."
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
