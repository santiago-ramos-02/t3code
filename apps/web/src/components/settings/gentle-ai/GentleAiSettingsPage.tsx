import { gentleAiSyncNeeded } from "@t3tools/client-runtime/gentle-ai";
import type {
  EnvironmentId,
  GentleAiApiStatus,
  GentleAiJobMethod,
  GentleAiParams,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { FoldedSettingsSection } from "../FoldedSettingsSection";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import {
  GentleAiAgentFlow,
  GentleAiAgentsSection,
  type GentleAiPiProvider,
} from "./GentleAiAgentsSection";
import { GentleAiBackupsFlow } from "./GentleAiBackupsFlow";
import { GentleAiBuilderFlow } from "./GentleAiBuilderFlow";
import { GentleAiFlowHeader, GentleAiFlowPanel } from "./GentleAiFlow";
import type { GentleAiFlow } from "./gentleAiFlow.logic";
import { GentleAiJobPanel } from "./GentleAiJobPanel";
import { GentleAiModelsFlow } from "./GentleAiModels";
import { GentleAiProjectToolRows, GentleAiReviewSection } from "./GentleAiProjectSection";
import { GentleAiSetupFlow } from "./GentleAiSetupFlow";
import { GentleAiUninstallFlow } from "./GentleAiUninstallFlow";
import { useGentleAiJob, useGentleAiQuery } from "./useGentleAi";

/** What every Gentle AI settings section gets from the page. */
export interface GentleAiSectionProps {
  readonly environmentId: EnvironmentId;
  readonly status: GentleAiApiStatus;
  /** True while the environment runs a Gentle AI job or the page is read-only. */
  readonly disabled: boolean;
  readonly readOnly: boolean;
  /** Project folders on this environment, for project-scoped actions. */
  readonly projects: ReadonlyArray<{ readonly title: string; readonly cwd: string }>;
  readonly startJob: <M extends GentleAiJobMethod>(
    method: M,
    params: GentleAiParams<M>,
  ) => Promise<string | null>;
  readonly onError: (message: string) => void;
  /** Whether this gentle-ai keeps Claude Code profiles. */
  readonly claudeProfiles: boolean;
  /** Opens a flow in place of the page; null returns to the page. */
  readonly openFlow: (flow: GentleAiFlow | null) => void;
}

/**
 * Gentle AI's GUI, for a gentle-ai with the headless API, run on the environment so it works
 * the same from any client. It is ordered by how often each thing changes: whether Gentle AI is
 * current, the agents it is set up in and the models they run, the review, and then everything
 * set once, folded away under More.
 */
export function GentleAiSettingsPage({
  environmentId,
  readOnly,
  projects,
  flow,
  onFlowChange,
  agentExtras,
  piProvider,
  claudeProfiles,
  advancedRows,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
  readonly projects: ReadonlyArray<{ readonly title: string; readonly cwd: string }>;
  readonly flow: GentleAiFlow | null;
  readonly onFlowChange: (flow: GentleAiFlow | null) => void;
  /** Settings an agent brings along, shown on its own page, such as gentle-pi's for Pi. */
  readonly agentExtras: Readonly<Record<string, ReactNode>>;
  /** The Pi provider whose gentle-pi profiles the agent list switches, when one is on. */
  readonly piProvider: GentleAiPiProvider | null;
  /** Whether this gentle-ai keeps Claude Code profiles. */
  readonly claudeProfiles: boolean;
  /** Rows the caller owns, such as the binary path, shown at the end of More. */
  readonly advancedRows: ReactNode;
}) {
  const status = useGentleAiQuery(environmentId, "status", {});
  const { job, running, startJob } = useGentleAiJob(environmentId);
  const [error, setError] = useState<string | null>(null);
  const names = useMemo(() => {
    const entries = new Map<string, string>();
    for (const agent of status.data?.agents ?? []) entries.set(agent.id, agent.name);
    for (const component of status.data?.components ?? [])
      entries.set(component.id, component.name);
    return entries;
  }, [status.data]);

  if (status.data === null) {
    return (
      <SettingsSection title="Gentle AI">
        {status.error ? (
          <SettingsRow title="Gentle AI could not be read" description={status.error} />
        ) : (
          <SettingsRow title="Reading Gentle AI" control={<Spinner className="size-3.5" />} />
        )}
      </SettingsSection>
    );
  }

  const sectionProps: GentleAiSectionProps = {
    environmentId,
    status: status.data,
    disabled: readOnly || running,
    readOnly,
    projects,
    startJob: async (method, params) => {
      setError(null);
      const started = await startJob(method, params);
      return started !== null && "error" in started ? started.error : null;
    },
    onError: setError,
    openFlow: onFlowChange,
    claudeProfiles,
  };
  const close = () => onFlowChange(null);
  const errorBanner = error ? (
    <SettingsSection title="Gentle AI could not do that">
      <SettingsRow
        title={<span className="text-destructive">{error}</span>}
        control={
          <Button size="sm" variant="ghost" onClick={() => setError(null)}>
            Dismiss
          </Button>
        }
      />
    </SettingsSection>
  ) : null;

  if (flow !== null) {
    return (
      <>
        {errorBanner}
        {flow.kind === "agent" ? (
          <>
            <GentleAiJobPanel job={job} names={names} />
            <GentleAiAgentFlow
              {...sectionProps}
              agentId={flow.agent}
              extras={agentExtras[flow.agent]}
              onClose={close}
            />
          </>
        ) : flow.kind === "setup" ? (
          <GentleAiSetupFlow
            {...sectionProps}
            {...(flow.agent === undefined ? {} : { agent: flow.agent })}
            onClose={close}
          />
        ) : flow.kind === "uninstall" ? (
          <GentleAiUninstallFlow
            {...sectionProps}
            {...(flow.agent === undefined ? {} : { agent: flow.agent })}
            onClose={close}
          />
        ) : flow.kind === "models" ? (
          <GentleAiModelsFlow {...sectionProps} agent={flow.agent} onClose={close} />
        ) : flow.kind === "builder" ? (
          <GentleAiBuilderFlow {...sectionProps} onClose={close} />
        ) : flow.kind === "backups" ? (
          <GentleAiBackupsFlow {...sectionProps} onClose={close} />
        ) : (
          <GentleAiDoctorFlow environmentId={environmentId} onClose={close} />
        )}
      </>
    );
  }

  return (
    <>
      {errorBanner}
      <GentleAiJobPanel job={job} names={names} />
      <GentleAiStatusSection {...sectionProps} />
      <GentleAiAgentsSection {...sectionProps} piProvider={piProvider} />
      <GentleAiReviewSection {...sectionProps} />
      <GentleAiMoreSection {...sectionProps} advancedRows={advancedRows} />
    </>
  );
}

/**
 * Whether Gentle AI is current: one row while it is, and a row per thing to do when it is not,
 * an update to install or agent files to bring up to date.
 */
function GentleAiStatusSection({
  environmentId,
  status,
  disabled,
  startJob,
  onError,
}: GentleAiSectionProps) {
  // gentle-ai skips checks it ran recently; "Check now" forces one.
  const [forceCheck, setForceCheck] = useState(false);
  const updates = useGentleAiQuery(environmentId, "updates", forceCheck ? { force: true } : {});
  const outdated = (updates.data?.tools ?? []).filter((tool) => tool.updateAvailable);
  const syncNeeded = gentleAiSyncNeeded(status);
  const run = (promise: Promise<string | null>) =>
    void promise.then((error) => (error ? onError(error) : undefined));
  const lastSynced = status.state.lastSyncedAt
    ? `Synced ${new Date(status.state.lastSyncedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
    : null;

  return (
    <SettingsSection
      title="Gentle AI"
      headerAction={
        <span className="font-mono text-xs text-muted-foreground">v{status.version}</span>
      }
    >
      {outdated.length > 0 ? (
        <SettingsRow
          title="Update available"
          description={outdated
            .map((tool) => `${tool.name} ${tool.installed ?? "?"} → ${tool.latest ?? "?"}`)
            .join(" · ")}
          control={
            <Button
              size="sm"
              disabled={disabled}
              // Updating also refreshes the agents' files; when gentle-ai updates itself, it
              // does that on its next run instead.
              onClick={() => run(startJob("upgrade", { sync: true }))}
            >
              Update
            </Button>
          }
        />
      ) : null}
      {syncNeeded ? (
        <SettingsRow
          title="Agent files are out of date"
          description="Gentle AI changed since it last updated your agents. Sync brings them up to date."
          control={
            <Button size="sm" disabled={disabled} onClick={() => run(startJob("sync", {}))}>
              Sync
            </Button>
          }
        />
      ) : null}
      {outdated.length > 0 || syncNeeded ? null : (
        <SettingsRow
          title={
            updates.error
              ? "Updates could not be checked"
              : updates.data === null || updates.isPending
                ? "Checking for updates…"
                : "Up to date"
          }
          description={updates.error ?? lastSynced}
          control={
            updates.data?.checked === false ? (
              <Button size="sm" variant="outline" onClick={() => setForceCheck(true)}>
                Check now
              </Button>
            ) : null
          }
        />
      )}
    </SettingsSection>
  );
}

/**
 * Everything set once or rarely, folded closed: the setup every agent shares, custom agents,
 * project tools, backups, the health check, re-syncing, removing Gentle AI, and the binary.
 */
function GentleAiMoreSection({
  advancedRows,
  ...props
}: GentleAiSectionProps & { readonly advancedRows: ReactNode }) {
  const { status, disabled, readOnly, openFlow, startJob, onError } = props;
  const installed = status.components.filter((component) => component.installed);
  const preset = status.presets.find((entry) => entry.id === status.state.preset);
  const persona = status.personas.find((entry) => entry.id === status.state.persona);
  const anySetUp = status.agents.some((agent) => agent.installed);
  const canCreate = anySetUp && status.builderEngines.length > 0;
  const summary = [preset?.label, persona ? `${persona.label} persona` : null]
    .filter((part) => part !== null && part !== undefined)
    .join(" · ");

  return (
    <FoldedSettingsSection
      id="gentle-ai-more"
      title="More"
      summary="Setup, tools, backups, removal"
    >
      <SettingsRow
        title="Setup for every agent"
        description={
          anySetUp
            ? installed.map((component) => component.name).join(", ") || "No components."
            : "Gentle AI isn't set up in any agent yet."
        }
        status={anySetUp ? summary : null}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => openFlow({ kind: "setup" })}
          >
            {anySetUp ? "Change" : "Set up"}
          </Button>
        }
      />
      <SettingsRow
        title="Custom agents"
        description={
          !anySetUp
            ? "Set up Gentle AI in an agent first."
            : status.builderEngines.length === 0
              ? "Creating one needs Claude Code, OpenCode, Gemini CLI, or Codex installed here."
              : "Describe an agent, and Gentle AI adds it to every agent it set up."
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={readOnly || !canCreate}
            onClick={() => openFlow({ kind: "builder" })}
          >
            Create
          </Button>
        }
      />
      <GentleAiProjectToolRows {...props} />
      <SettingsRow
        title="Sync agent files"
        description="Rewrites Gentle AI's files in every agent it set up, such as after editing them by hand."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || !anySetUp}
            onClick={() =>
              void startJob("sync", {}).then((error) => (error ? onError(error) : undefined))
            }
          >
            Sync
          </Button>
        }
      />
      <SettingsRow
        title="Backups"
        description="Restore agent files from before an install, sync, update, or removal."
        control={
          <Button size="sm" variant="outline" onClick={() => openFlow({ kind: "backups" })}>
            Open
            <ChevronRightIcon aria-hidden />
          </Button>
        }
      />
      <SettingsRow
        title="Health check"
        description="Checks the tools and files Gentle AI manages here."
        control={
          <Button size="sm" variant="outline" onClick={() => openFlow({ kind: "doctor" })}>
            Run
            <ChevronRightIcon aria-hidden />
          </Button>
        }
      />
      <SettingsRow
        title="Remove Gentle AI"
        description="Remove it from some or all agents, or start over with a clean setup."
        control={
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={disabled}
            onClick={() => openFlow({ kind: "uninstall" })}
          >
            Remove
          </Button>
        }
      />
      {advancedRows}
    </FoldedSettingsSection>
  );
}

const CHECK_LABELS: Readonly<Record<string, string>> = {
  pass: "OK",
  warn: "Warning",
  fail: "Problem",
};

/** gentle-ai's diagnostics for this environment, run each time the flow opens. */
function GentleAiDoctorFlow({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const doctor = useGentleAiQuery(environmentId, "doctor", {});
  return (
    <section className="space-y-4">
      <GentleAiFlowHeader
        title="Health check"
        description="Checks the tools and files Gentle AI manages on this environment."
        onBack={onClose}
      />
      <GentleAiFlowPanel>
        {doctor.data === null ? (
          doctor.error ? (
            <p className="text-destructive text-sm">{doctor.error}</p>
          ) : (
            <p className="flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner className="size-3.5" /> Running checks
            </p>
          )
        ) : (
          <ul className="space-y-1.5 text-sm">
            {doctor.data.checks.map((check) => (
              <li key={check.id} className="flex gap-2">
                <span
                  className={
                    check.status === "pass"
                      ? "w-16 shrink-0 text-success"
                      : check.status === "fail"
                        ? "w-16 shrink-0 text-destructive"
                        : "w-16 shrink-0 text-warning"
                  }
                >
                  {CHECK_LABELS[check.status] ?? check.status}
                </span>
                <span className="min-w-0">
                  {check.message}
                  {check.remedy ? (
                    <span className="block text-muted-foreground">{check.remedy}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </GentleAiFlowPanel>
    </section>
  );
}
