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
import { Skeleton } from "../../ui/skeleton";
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
import { GentleAiProjectSection, GentleAiReviewSection } from "./GentleAiProjectSection";
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
  /** The project chosen at the top of Settings, as its folder here, for project settings. */
  readonly project: { readonly title: string; readonly cwd: string } | null;
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
 * current, the agents it is set up in and the models they run, the review (or, with a project
 * chosen at the top of Settings, everything set for that project), and then everything set
 * once, folded away under More.
 */
export function GentleAiSettingsPage({
  environmentId,
  readOnly,
  project,
  projectRows,
  flow,
  onFlowChange,
  agentExtras,
  piProvider,
  claudeProfiles,
  advancedRows,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
  readonly project: { readonly title: string; readonly cwd: string } | null;
  /** Rows agents add for one project folder, such as gentle-pi's profile pin and persona. */
  readonly projectRows: (cwd: string) => ReactNode;
  readonly flow: GentleAiFlow | null;
  readonly onFlowChange: (flow: GentleAiFlow | null) => void;
  /** Settings an agent brings along, shown on its own page, such as gentle-pi's for Pi. */
  /** Settings an agent brings along, given rows (such as its plugins) to show with them. */
  readonly agentExtras: Readonly<Record<string, (extraRows: ReactNode) => ReactNode>>;
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

  // The server answers this from what it read at startup, so it is rarely missing for long.
  if (status.data === null) {
    return status.error ? (
      <SettingsSection title="Gentle AI">
        <SettingsRow title="Gentle AI could not be read" description={status.error} />
      </SettingsSection>
    ) : (
      <GentleAiPageSkeleton />
    );
  }

  const sectionProps: GentleAiSectionProps = {
    environmentId,
    status: status.data,
    disabled: readOnly || running,
    readOnly,
    project,
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
      <GentleAiStatusLine {...sectionProps} />
      <GentleAiAgentsSection {...sectionProps} piProvider={piProvider} />
      {project === null ? (
        <GentleAiReviewSection {...sectionProps} />
      ) : (
        <GentleAiProjectSection {...sectionProps} project={project}>
          {projectRows(project.cwd)}
        </GentleAiProjectSection>
      )}
      <GentleAiMoreSection {...sectionProps} advancedRows={advancedRows} />
    </>
  );
}

/**
 * Whether Gentle AI is current, as the page's first line rather than a card of its own: the
 * version and when it last synced, and the one thing to do when there is one, an update to
 * install or agent files to bring up to date.
 */
function GentleAiStatusLine({
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

  const state =
    outdated.length > 0
      ? `Update available: ${outdated
          .map((tool) => `${tool.name} ${tool.installed ?? "?"} → ${tool.latest ?? "?"}`)
          .join(", ")}`
      : syncNeeded
        ? "Your agents' files are out of date"
        : updates.error
          ? `Updates could not be checked: ${updates.error}`
          : updates.data === null || updates.isPending
            ? "Checking for updates…"
            : "Up to date";

  return (
    <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 text-sm text-foreground/70 sm:px-4">
      <p className="min-w-0">
        <span className="font-mono text-xs">v{status.version}</span>
        {" · "}
        <span className={outdated.length > 0 || syncNeeded ? "text-foreground" : undefined}>
          {state}
        </span>
        {lastSynced && outdated.length === 0 && !syncNeeded ? ` · ${lastSynced}` : null}
      </p>
      {outdated.length > 0 ? (
        <Button
          size="sm"
          disabled={disabled}
          // Updating also refreshes the agents' files; when gentle-ai updates itself, it does
          // that on its next run instead.
          onClick={() => run(startJob("upgrade", { sync: true }))}
        >
          Update
        </Button>
      ) : syncNeeded ? (
        <Button size="sm" disabled={disabled} onClick={() => run(startJob("sync", {}))}>
          Sync
        </Button>
      ) : updates.data?.checked === false ? (
        <Button size="xs" variant="ghost" onClick={() => setForceCheck(true)}>
          Check now
        </Button>
      ) : null}
    </div>
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
      headerPlacement="outside"
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

/** The page's shape while gentle-ai's status is first read. */
function GentleAiPageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Reading Gentle AI" className="space-y-6">
      <Skeleton className="mx-3 h-4 w-64 sm:mx-4" />
      <SettingsSection title="Your agents">
        {[0, 1].map((row) => (
          <SettingsRow
            key={row}
            title={<Skeleton className="h-4 w-28" />}
            control={<Skeleton className="h-8 w-56" />}
          />
        ))}
      </SettingsSection>
    </div>
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
