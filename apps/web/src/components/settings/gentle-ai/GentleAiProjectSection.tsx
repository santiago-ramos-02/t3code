import { useMemo, useState, type ReactNode } from "react";

import { Button, InlineButton } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Label } from "../../ui/label";
import { Skeleton } from "../../ui/skeleton";
import { Switch } from "../../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settingsLayout";
import { GentleAiConfirm } from "./GentleAiConfirm";
import {
  gentleAiProjectReview,
  gentleAiReviewGlobalEnabled,
  gentleAiReviewHistoryLabel,
  gentleAiReviewStoreSummary,
} from "@t3tools/client-runtime/gentle-ai";
import {
  gentleAiNames,
  gentleAiToolInstalled,
  gentleAiToolSummary,
} from "./gentleAiSections.logic";
import type { GentleAiSectionProps } from "./GentleAiSettingsPage";
import { gentleAiJobResult, useGentleAiJob, useGentleAiQuery } from "./useGentleAi";

type Project = { readonly title: string; readonly cwd: string };

const controlSkeleton = <Skeleton shape="pill" className="h-5 w-9" />;

/** The switch for reviewing agents' changes before delivery, for every project. */
function GentleAiReviewRow({ environmentId, disabled, startJob, onError }: GentleAiSectionProps) {
  const mode = useGentleAiQuery(environmentId, "review.status", {});
  return (
    <SettingsRow
      title="Review before delivery"
      description={
        mode.error ?? "Checks agents' changes before they deliver them, in every project."
      }
      control={
        mode.data === null ? (
          mode.error ? null : (
            controlSkeleton
          )
        ) : (
          <Switch
            aria-label="Review before delivery"
            checked={gentleAiReviewGlobalEnabled(mode.data)}
            disabled={disabled}
            onCheckedChange={(checked) =>
              void startJob("review.set", { enabled: checked, scope: "global" }).then((error) =>
                error ? onError(error) : undefined,
              )
            }
          />
        )
      }
    />
  );
}

/**
 * Settings for every project: the review switch, and where to set one project's own. A project
 * is chosen at the top of Settings, like every other project setting in T3 Code.
 */
export function GentleAiReviewSection(props: GentleAiSectionProps) {
  return (
    <SettingsSection title="Review">
      <GentleAiReviewRow {...props} />
      <SettingsRow
        title="One project's settings"
        description="Choose a project at the top of this page for its review, Pi profile, and tools such as CodeGraph."
      />
    </SettingsSection>
  );
}

/**
 * Everything Gentle AI keeps for the project chosen at the top of Settings, in one place: its
 * review, review history, what agents add for it (such as gentle-pi's profile pin), and the
 * community tools wired into it.
 */
export function GentleAiProjectSection({
  children,
  ...props
}: GentleAiSectionProps & { readonly project: Project; readonly children?: ReactNode }) {
  const { project } = props;
  return (
    <SettingsSection title={project.title}>
      <ProjectReviewRows {...props} cwd={project.cwd} />
      {children}
      <ToolRows {...props} cwd={project.cwd} />
    </SettingsSection>
  );
}

/** Review in this project: it follows the switch for every project unless turned off here. */
function ProjectReviewRows({
  environmentId,
  disabled,
  startJob,
  onError,
  cwd,
}: GentleAiSectionProps & { readonly cwd: string }) {
  const mode = useGentleAiQuery(environmentId, "review.status", { cwd });
  const store = useGentleAiQuery(environmentId, "reviewStore.survey", { cwd });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [includeInFlight, setIncludeInFlight] = useState(false);
  // The environment's latest job, when it was a reset, reports what it removed.
  const { job } = useGentleAiJob(environmentId);
  const lastReset = gentleAiJobResult(job, "reviewStore.reset");
  const run = (promise: Promise<string | null>) =>
    void promise.then((error) => (error ? onError(error) : undefined));
  const setHere = (enabled: boolean) =>
    run(startJob("review.set", { cwd, enabled, scope: "clone" }));

  const review = mode.data === null ? null : gentleAiProjectReview(mode.data);
  const counts = store.data === null ? null : gentleAiReviewStoreSummary(store.data);
  const storeStatus = store.error
    ? store.error
    : counts === null
      ? null
      : gentleAiReviewHistoryLabel(counts, lastReset?.report.removed_files ?? null);

  return (
    <>
      <SettingsRow
        title="Review before delivery"
        description={
          mode.error ??
          (review === null
            ? "Checks agents' changes before they deliver them."
            : review.overridden
              ? "Off in this project only."
              : review.canTurnOn
                ? "Follows the setting for every project."
                : "Off for every project. Turn it on under All projects at the top.")
        }
        resetAction={
          review?.overridden ? (
            <SettingResetButton
              label="review before delivery"
              tooltip="Use the setting for all projects"
              disabled={disabled}
              onClick={() => setHere(true)}
            />
          ) : null
        }
        control={
          review === null ? (
            mode.error ? null : (
              controlSkeleton
            )
          ) : (
            <Switch
              aria-label="Review before delivery in this project"
              checked={review.checked}
              disabled={disabled || (!review.checked && !review.canTurnOn)}
              onCheckedChange={setHere}
            />
          )
        }
      />
      <SettingsRow
        title="Review history"
        description={storeStatus}
        control={
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={
              disabled || counts === null || (counts.removable === 0 && counts.inFlight === 0)
            }
            onClick={() => {
              setIncludeInFlight(false);
              setConfirmOpen(true);
            }}
          >
            Clear
          </Button>
        }
      />
      <GentleAiConfirm
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Clear review history?"
        description={
          counts !== null && counts.inFlight > 0
            ? `Removes this checkout's review history. Reviews still in progress (${counts.inFlight}) block it unless you remove them too. This cannot be undone.`
            : "Removes this checkout's review history. This cannot be undone."
        }
        confirmLabel="Clear"
        destructive
        onConfirm={() =>
          run(
            startJob("reviewStore.reset", { cwd, ...(includeInFlight ? { includeInFlight } : {}) }),
          )
        }
      >
        {counts !== null && counts.inFlight > 0 ? (
          <div className="px-6">
            <Label>
              <Checkbox
                checked={includeInFlight}
                onCheckedChange={(checked) => setIncludeInFlight(checked === true)}
              />
              Also remove reviews in progress
            </Label>
          </div>
        ) : null}
      </GentleAiConfirm>
    </>
  );
}

/** Community tools Gentle AI can install and wire into this project's agents, such as CodeGraph. */
function ToolRows({
  environmentId,
  status,
  disabled,
  startJob,
  onError,
  cwd,
}: GentleAiSectionProps & { readonly cwd: string }) {
  const tools = useGentleAiQuery(environmentId, "tools.list", { cwd });
  const names = useMemo(() => gentleAiNames(status), [status]);
  if (tools.error)
    return <SettingsRow title="Community tools unavailable" description={tools.error} />;
  if (tools.data === null)
    return (
      <SettingsRow
        title={<Skeleton className="h-4 w-24" />}
        control={<Skeleton className="h-8 w-20" />}
      />
    );
  return tools.data.tools.map((tool) => (
    <SettingsRow
      key={tool.id}
      title={tool.name}
      description={
        <>
          {tool.description}{" "}
          <InlineButton
            tone="muted"
            render={<a href={tool.repoUrl} rel="noreferrer noopener" target="_blank" />}
          >
            Repository
          </InlineButton>
        </>
      }
      status={gentleAiToolSummary(tool, names)}
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() =>
            void startJob("tools.install", { ids: [tool.id], cwd }).then((error) =>
              error ? onError(error) : undefined,
            )
          }
        >
          {gentleAiToolInstalled(tool) ? "Reinstall" : "Install"}
        </Button>
      }
    />
  ));
}
