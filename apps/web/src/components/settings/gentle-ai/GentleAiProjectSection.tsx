import { useMemo, useState } from "react";

import { Button, InlineButton } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Label } from "../../ui/label";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { GentleAiConfirm } from "./GentleAiConfirm";
import { GentleAiProjectPicker, useGentleAiProject } from "./GentleAiProjectPicker";
import {
  formatGentleAiBytes,
  gentleAiNames,
  gentleAiReviewCloneDisabled,
  gentleAiReviewGlobalEnabled,
  gentleAiReviewStoreSummary,
  gentleAiToolInstalled,
  gentleAiToolSummary,
} from "./gentleAiSections.logic";
import type { GentleAiSectionProps } from "./GentleAiSettingsPage";
import { gentleAiJobResult, useGentleAiJob, useGentleAiQuery } from "./useGentleAi";

const SOURCE_LABELS: Record<string, string> = {
  default: "the default",
  global: "the setting for every agent",
  clone_local: "this project's override",
};

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

/**
 * The switch for reviewing agents' changes before delivery, everywhere. gentle-ai reads it through
 * a project folder, so it uses the first project; each project can still opt out below.
 */
export function GentleAiReviewRow({
  environmentId,
  disabled,
  projects,
  startJob,
  onError,
}: GentleAiSectionProps) {
  const cwd = projects[0]?.cwd ?? null;
  const mode = useGentleAiQuery(
    environmentId,
    "review.status",
    { cwd: cwd ?? "" },
    {
      enabled: cwd !== null,
    },
  );
  const description =
    "An independent review checks agents' code changes before they hand them off.";
  if (cwd === null)
    return (
      <SettingsRow
        title="Review before delivery"
        description={`${description} Add a project to this environment to change it.`}
      />
    );
  return (
    <SettingsRow
      title="Review before delivery"
      description={mode.error ?? description}
      control={
        mode.data === null ? (
          mode.error ? null : (
            <Spinner className="size-3.5" />
          )
        ) : (
          <Switch
            aria-label="Review before delivery"
            checked={gentleAiReviewGlobalEnabled(mode.data)}
            disabled={disabled}
            onCheckedChange={(checked) =>
              void startJob("review.set", { cwd, enabled: checked, scope: "global" }).then(
                (error) => (error ? onError(error) : undefined),
              )
            }
          />
        )
      }
    />
  );
}

/**
 * What gentle-ai reads through a project folder: whether this project skips the review, its
 * review history, and the community tools wired into its agents. One picker scopes all of it.
 */
export function GentleAiProjectSection(props: GentleAiSectionProps) {
  const { projects } = props;
  const { cwd, setCwd } = useGentleAiProject(projects);
  return (
    <SettingsSection
      title="Project"
      headerAction={
        <GentleAiProjectPicker projects={projects} cwd={cwd} onChange={setCwd} label="Project" />
      }
    >
      {cwd === null ? (
        <SettingsRow
          title="Add a project first"
          description="Reviews and community tools are set up per project. Add a project to this environment to manage them."
        />
      ) : (
        <>
          <ReviewRows {...props} cwd={cwd} />
          <ToolRows {...props} cwd={cwd} />
        </>
      )}
    </SettingsSection>
  );
}

function ReviewRows({
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

  const counts = store.data === null ? null : gentleAiReviewStoreSummary(store.data);
  const storeStatus = store.error
    ? store.error
    : counts === null
      ? "Reading review history…"
      : [
          counts.removable === 0 && counts.inFlight === 0
            ? "Nothing to clear"
            : `${count(counts.removable, "entry", "entries")} (${formatGentleAiBytes(counts.removableBytes)})`,
          counts.inFlight > 0 ? `${count(counts.inFlight, "review", "reviews")} in progress` : null,
          lastReset === null
            ? null
            : `Last clear removed ${count(lastReset.report.removed_files, "file", "files")}`,
        ]
          .filter((part) => part !== null)
          .join(" · ");

  return (
    <>
      {mode.error ? (
        <SettingsRow title="Review unavailable" description={mode.error} />
      ) : mode.data === null ? null : (
        <SettingsRow
          title="Turn off review for this project"
          description="Only this checkout, on this machine."
          status={`Review is ${mode.data.status.effective === "on" ? "on" : "off"} here, from ${SOURCE_LABELS[mode.data.status.source] ?? mode.data.status.source}.`}
          control={
            <Switch
              aria-label="Turn off review for this project"
              checked={gentleAiReviewCloneDisabled(mode.data)}
              disabled={disabled}
              onCheckedChange={(checked) =>
                run(startJob("review.set", { cwd, enabled: !checked, scope: "clone" }))
              }
            />
          }
        />
      )}
      <SettingsRow
        title="Review history"
        description="What this clone keeps from past reviews."
        status={storeStatus}
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
            ? `Removes this clone's review history. Reviews still in progress (${counts.inFlight}) block it unless you remove them too. This cannot be undone.`
            : "Removes this clone's review history. This cannot be undone."
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
    return <SettingsRow title="Community tools" control={<Spinner className="size-3.5" />} />;
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
