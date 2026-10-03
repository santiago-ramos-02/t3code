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
import { useEffect, useState, type ReactNode } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { GentleRoseIcon } from "../GentleRoseIcon";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { GentleAiProfileList } from "./gentle-ai/GentleAiProfileList";
import { PiRoutingEditor } from "./gentle-ai/PiRoutingEditor";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type GentleAction = typeof PiGentleActionInput.Type.action;
type GentleArea = "global" | "profiles" | "project";

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

/** A row's shape while its first read is in flight. */
function SkeletonRow() {
  return (
    <SettingsRow
      title={<Skeleton className="h-4 w-28" />}
      control={<Skeleton className="h-8 w-56" />}
    />
  );
}

/**
 * gentle-pi's settings for one Pi instance, read for one project folder or none. Every change
 * is written to gentle-pi's config immediately and answers with the state after it.
 */
function usePiGentle({
  environmentId,
  instanceId,
  cwd,
  refreshKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string | null;
  readonly refreshKey: number;
}) {
  const stateKey = `${environmentId}:${instanceId}:${cwd ?? ""}`;
  const [loaded, setLoaded] = useState<{ key: string; state: PiGentleState } | null>(null);
  const state = loaded?.key === stateKey ? loaded.state : null;
  const [retry, setRetry] = useState(0);
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

  // A refresh from the page, or a retry, reads again for the same folder.
  const requestKey = `${stateKey}:${refreshKey}:${retry}`;
  // A re-read (after a Gentle AI job, or Retry) skips the server's kept answer.
  const reread = refreshKey > 0 || retry > 0;
  useEffect(() => {
    let liveRequest: string | null = requestKey;
    void read({
      environmentId,
      input: { instanceId, ...(cwd ? { cwd } : {}), ...(reread ? { refresh: true } : {}) },
    }).then((result) => {
      if (liveRequest !== requestKey) return;
      if (result._tag === "Success") {
        setLoaded({ key: stateKey, state: result.value });
        setErrorState(null);
      } else if (!isAtomCommandInterrupted(result)) {
        setErrorState({
          key: stateKey,
          text: errorText(squashAtomCommandFailure(result)),
          area: cwd ? "project" : "global",
        });
      }
    });
    return () => {
      liveRequest = null;
    };
  }, [cwd, environmentId, instanceId, read, requestKey, reread, stateKey]);

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
        setErrorState({ key: stateKey, text: errorText(squashAtomCommandFailure(result)), area });
      }
    } catch (cause) {
      setErrorState({ key: stateKey, text: errorText(cause), area });
    } finally {
      setPending(null);
    }
    return false;
  }

  const errorFor = (area: GentleArea) =>
    error?.area === area ? (
      <span role="alert" className="text-destructive">
        {error.text}
      </span>
    ) : null;
  const retryRead = () => {
    setErrorState(null);
    setRetry((value) => value + 1);
  };
  return { state, error, pending, runAction, errorFor, retryRead };
}

function readOnlyProps(readOnly: boolean) {
  return {
    inert: readOnly,
    "aria-disabled": readOnly || undefined,
    className: readOnly ? "opacity-50 select-none" : undefined,
  };
}

/**
 * What gentle-pi adds to Gentle AI for one Pi provider instance, on Pi's page: its version,
 * persona, and model profiles. Per-project overrides are in the page's project section.
 */
export function PiGentleSettingsSection({
  environmentId,
  instanceId,
  title,
  refreshKey,
  models,
  readOnly,
  extraRows,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  // Names the Pi instance, since an environment can run several.
  readonly title: string;
  readonly refreshKey: number;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly readOnly: boolean;
  /** Rows Gentle AI adds for Pi, such as its plugins, shown with the persona. */
  readonly extraRows?: ReactNode;
}) {
  const { state, error, pending, runAction, errorFor, retryRead } = usePiGentle({
    environmentId,
    instanceId,
    cwd: null,
    refreshKey,
  });
  const sectionIcon = <GentleRoseIcon className="size-5 shrink-0" />;
  const canEdit = !readOnly && pending === null;

  // Gentle AI is an optional Pi package: nothing about it shows until the server confirms Pi
  // loads it. The server only fails a read once gentle-pi is installed, so a failure is shown.
  if (state === null) {
    return (
      <SettingsSection title={title} icon={sectionIcon} {...readOnlyProps(readOnly)}>
        {error ? (
          <SettingsRow
            title="Could not load Gentle AI settings"
            status={errorFor("global")}
            control={
              <Button size="sm" variant="outline" onClick={retryRead}>
                Retry
              </Button>
            }
          />
        ) : (
          <SkeletonRow />
        )}
      </SettingsSection>
    );
  }

  if (!state.available) {
    return state.version === null ? null : (
      <SettingsSection title={title} icon={sectionIcon} {...readOnlyProps(readOnly)}>
        <SettingsRow
          title="Update for Pi"
          description={`T3 Code needs Gentle AI 3.5 or newer, and ${state.version} is installed.`}
          status={errorFor("global")}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit}
              onClick={() => void runAction({ type: "update" })}
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
    if (!(await runAction({ type: "create", name }))) return false;
    // A new profile starts as a copy of the active one, not empty.
    const copy = state.profiles.find((entry) => entry.name === state.active)?.routing;
    return copy === undefined ? true : runAction({ type: "save", name, routing: copy });
  };

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
                  onClick={() => void runAction({ type: "update" })}
                >
                  {pending === "update" ? "Updating…" : "Update"}
                </Button>
              ) : null}
            </div>
          ) : null
        }
        {...readOnlyProps(readOnly)}
      >
        {state.compatibilityWarning ? (
          <SettingsRow title="Untested version" description={state.compatibilityWarning} />
        ) : null}
        <SettingsRow
          title="Persona"
          description="Used in every project that doesn't choose its own."
          status={errorFor("global")}
          control={
            <GentleSelect
              label="Global Gentle AI persona"
              value={state.globalPersona ?? "gentleman"}
              labels={PERSONA_LABELS}
              disabled={!canEdit}
              onChange={(mode) => void runAction({ type: "setGlobalPersona", mode })}
            />
          }
        />
        {extraRows}
      </SettingsSection>

      <div {...readOnlyProps(readOnly)}>
        <GentleAiProfileList
          title="Profiles"
          profiles={state.profiles.map((entry) => ({
            name: entry.name,
            summary: gentlePiProfileSummary(entry.routing, nameOf),
          }))}
          active={state.active}
          loading={false}
          error={error?.area === "profiles" ? error.text : null}
          emptyText="A profile sets the model and effort for each of Pi's roles."
          disabled={!canEdit}
          onUse={(name) => void runAction({ type: "activate", name })}
          onCreate={createProfile}
          renderEditor={(name) => (
            <PiRoutingEditor
              routing={state.profiles.find((entry) => entry.name === name)?.routing ?? {}}
              models={models}
              disabled={!canEdit}
              onChange={(routing) => void runAction({ type: "save", name, routing })}
            />
          )}
        />
      </div>
    </>
  );
}

/**
 * gentle-pi's overrides for one project folder, as rows for the page's project section: the
 * profile pinned for this checkout and the project's persona. Nothing shows without gentle-pi.
 */
export function PiGentleProjectRows({
  environmentId,
  instanceId,
  instanceLabel,
  cwd,
  refreshKey,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  /** Names the Pi instance when an environment runs several. */
  readonly instanceLabel: string | null;
  readonly cwd: string;
  readonly refreshKey: number;
  readonly readOnly: boolean;
}) {
  const { state, error, pending, runAction, errorFor, retryRead } = usePiGentle({
    environmentId,
    instanceId,
    cwd,
    refreshKey,
  });
  const canEdit = !readOnly && pending === null;
  const prefix = instanceLabel === null ? "Pi" : `Pi (${instanceLabel})`;
  if (state === null) {
    return error ? (
      <SettingsRow
        title={`Could not load ${prefix} settings`}
        status={errorFor("project")}
        control={
          <Button size="sm" variant="outline" onClick={retryRead}>
            Retry
          </Button>
        }
      />
    ) : (
      <SkeletonRow />
    );
  }
  const project = state.available ? state.project : null;
  if (project === null) return null;
  const pinned = project.pinned;
  const localPin = project.pinSource === "local" ? pinned : null;
  return (
    <>
      <SettingsRow
        title={instanceLabel === null ? "Profile" : `Profile (${instanceLabel})`}
        description={
          !project.pinAvailable
            ? "Pinning a profile needs a Git repository."
            : project.pinSource === "repo"
              ? "The repository declares one. Pick a profile to override it on this machine."
              : "Overrides the active profile for this checkout, on this machine only."
        }
        status={errorFor("project")}
        control={
          <GentleSelect
            label={`${prefix} profile for this project`}
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
                  ? { type: "clearPin", cwd }
                  : { type: "pin", cwd, name },
              )
            }
          />
        }
      />
      <SettingsRow
        title={instanceLabel === null ? "Persona" : `Persona (${instanceLabel})`}
        description="Saved in the project's .pi folder, so committing it applies to your team."
        control={
          <GentleSelect
            label={`${prefix} persona for this project`}
            value={project.persona.override ?? "global"}
            labels={{
              global: `Use global (${PERSONA_LABELS[project.persona.global]})`,
              ...PERSONA_LABELS,
            }}
            disabled={!canEdit}
            onChange={(mode) =>
              void runAction({ type: "setPersona", cwd, mode: mode === "global" ? null : mode })
            }
          />
        }
      />
    </>
  );
}
