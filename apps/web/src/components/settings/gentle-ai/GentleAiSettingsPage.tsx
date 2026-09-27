import type {
  EnvironmentId,
  GentleAiApiStatus,
  GentleAiJobMethod,
  GentleAiParams,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { GentleAiBackupsSection } from "./GentleAiBackupsSection";
import { GentleAiBuilderFlow, GentleAiBuilderSection } from "./GentleAiBuilderSection";
import { GentleAiFlowHeader, GentleAiFlowPanel } from "./GentleAiFlow";
import type { GentleAiFlow } from "./gentleAiFlow.logic";
import { GentleAiJobPanel } from "./GentleAiJobPanel";
import { GentleAiModelsFlow, GentleAiModelsSection } from "./GentleAiModelsSection";
import { GentleAiOpenCodeSection } from "./GentleAiOpenCodeSection";
import { GentleAiReviewSection } from "./GentleAiReviewSection";
import { GentleAiSetupFlow, GentleAiSetupSection } from "./GentleAiSetupSection";
import { GentleAiToolsSection } from "./GentleAiToolsSection";
import { GentleAiUninstallFlow, GentleAiUninstallSection } from "./GentleAiUninstallSection";
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
  /** Opens a flow in place of the page; null returns to the page. */
  readonly openFlow: (flow: GentleAiFlow | null) => void;
}

/**
 * Gentle AI's full GUI, for a gentle-ai with the headless API: everything its TUI offers,
 * run on the environment so it works the same from any client.
 */
export function GentleAiSettingsPage({
  environmentId,
  readOnly,
  projects,
  flow,
  onFlowChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
  readonly projects: ReadonlyArray<{ readonly title: string; readonly cwd: string }>;
  readonly flow: GentleAiFlow | null;
  readonly onFlowChange: (flow: GentleAiFlow | null) => void;
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
        {flow.kind === "setup" ? (
          <GentleAiSetupFlow {...sectionProps} onClose={close} />
        ) : flow.kind === "builder" ? (
          <GentleAiBuilderFlow {...sectionProps} onClose={close} />
        ) : flow.kind === "uninstall" ? (
          <GentleAiUninstallFlow {...sectionProps} onClose={close} />
        ) : flow.kind === "doctor" ? (
          <GentleAiDoctorFlow environmentId={environmentId} onClose={close} />
        ) : (
          <GentleAiModelsFlow {...sectionProps} agent={flow.agent} onClose={close} />
        )}
      </>
    );
  }

  return (
    <>
      {errorBanner}
      <GentleAiJobPanel job={job} names={names} />
      <GentleAiOverviewSection {...sectionProps} />
      <GentleAiSetupSection {...sectionProps} />
      <GentleAiModelsSection {...sectionProps} />
      <GentleAiOpenCodeSection {...sectionProps} />
      <GentleAiToolsSection {...sectionProps} />
      <GentleAiBuilderSection {...sectionProps} />
      <GentleAiReviewSection {...sectionProps} />
      <GentleAiBackupsSection {...sectionProps} />
      <GentleAiUninstallSection {...sectionProps} />
    </>
  );
}

/** Updates, sync, and health for the tools Gentle AI manages. */
function GentleAiOverviewSection({
  environmentId,
  status,
  disabled,
  startJob,
  onError,
  openFlow,
}: GentleAiSectionProps) {
  // gentle-ai skips checks it ran recently; "Check now" forces one.
  const [forceCheck, setForceCheck] = useState(false);
  const updates = useGentleAiQuery(environmentId, "updates", forceCheck ? { force: true } : {});
  const tools = updates.data?.tools ?? [];
  const outdated = tools.filter((tool) => tool.updateAvailable);
  const run = (promise: Promise<string | null>) =>
    void promise.then((error) => (error ? onError(error) : undefined));

  return (
    <SettingsSection
      title="Gentle AI"
      headerAction={
        <span className="font-mono text-xs text-muted-foreground">v{status.version}</span>
      }
    >
      <SettingsRow
        title="Updates"
        description={
          updates.error
            ? updates.error
            : updates.data === null || updates.isPending
              ? "Checking for updates…"
              : updates.data.checked === false
                ? "Checked recently."
                : outdated.length === 0
                  ? "Everything Gentle AI manages is up to date."
                  : outdated
                      .map(
                        (tool) => `${tool.name} ${tool.installed ?? "?"} → ${tool.latest ?? "?"}`,
                      )
                      .join(" · ")
        }
        control={
          <div className="flex flex-wrap gap-2">
            {updates.data?.checked === false ? (
              <Button size="sm" variant="outline" onClick={() => setForceCheck(true)}>
                Check now
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || outdated.length === 0}
              onClick={() => run(startJob("upgrade", {}))}
            >
              Upgrade
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || outdated.length === 0}
              // When gentle-ai upgrades itself, gentle-ai defers the sync to its next run.
              onClick={() => run(startJob("upgrade", { sync: true }))}
            >
              Upgrade and sync
            </Button>
          </div>
        }
      />
      <SettingsRow
        title="Agent files"
        description={
          status.state.pendingSync
            ? "gentle-ai changed since it last updated the agents it set up. Sync brings them up to date."
            : status.state.lastSyncedAt
              ? `Last synced ${new Date(status.state.lastSyncedAt).toLocaleString()}.`
              : "Sync rewrites Gentle AI's files in every agent it set up."
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => run(startJob("sync", {}))}
          >
            Sync
          </Button>
        }
      />
      <SettingsRow
        title="Health"
        description="Run gentle-ai's diagnostics for this environment."
        control={
          <Button size="sm" variant="outline" onClick={() => openFlow({ kind: "doctor" })}>
            Run doctor
          </Button>
        }
      />
    </SettingsSection>
  );
}

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
        title="Gentle AI doctor"
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
                      ? "text-success"
                      : check.status === "fail"
                        ? "text-destructive"
                        : "text-warning"
                  }
                >
                  {check.status}
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
