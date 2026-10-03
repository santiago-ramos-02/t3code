import { GENTLE_AI_JOB_LABELS } from "@t3tools/client-runtime/gentle-ai";
import type { GentleAiJob } from "@t3tools/contracts";
import { CheckIcon, ChevronRightIcon, CircleAlertIcon, MinusIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { useLocalStorage } from "../../../hooks/useLocalStorage";

import { Button } from "../../ui/button";

import { cn } from "../../../lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { Spinner } from "../../ui/spinner";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { gentleAiJobResult } from "./useGentleAi";

// Jobs dismissed on this device. The panel remounts on every page change, so this outlives it;
// a few ids are enough because only an environment's latest job is ever shown.
const DISMISSED_JOBS_KEY = "t3code:gentle-ai:dismissed-jobs:v1";
const DismissedJobs = Schema.Array(Schema.String);
const DISMISSED_JOBS_KEPT = 20;

/** What a sync changed: the files it rewrote and anything left to do by hand. */
function syncOutcome(job: GentleAiJob) {
  if (job.method !== "sync" && job.method !== "models.set") return null;
  const result = gentleAiJobResult(job, job.method);
  if (result === null) return null;
  return { files: result.files.length, manualActions: result.manualActions ?? [] };
}

/** gentle-ai's name for a step, or one made from its id for builds that give none. */
function stepName(
  step: { readonly id: string; readonly label?: string },
  names: ReadonlyMap<string, string>,
): string {
  return step.label ?? gentleAiStepLabel(step.id, names);
}

/** Readable names for pipeline steps such as `agent:claude-code` or `component:engram`. */
export function gentleAiStepLabel(id: string, names: ReadonlyMap<string, string>): string {
  const [kind, rest] = id.includes(":")
    ? [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)]
    : ["", id];
  const name = names.get(rest) ?? rest.replaceAll("-", " ");
  if (kind === "prepare") return name.charAt(0).toUpperCase() + name.slice(1);
  return name;
}

function StepIcon({ status }: { readonly status: GentleAiJob["steps"][number]["status"] }) {
  if (status === "running") return <Spinner className="size-3.5" />;
  if (status === "succeeded")
    return <CheckIcon className="size-3.5 text-success" aria-label="Done" />;
  if (status === "failed")
    return <CircleAlertIcon className="size-3.5 text-destructive" aria-label="Failed" />;
  return <MinusIcon className="size-3.5 text-muted-foreground" aria-label="Skipped" />;
}

/** One line on where a job is: its current step while running, else how its steps ended. */
function jobProgress(job: GentleAiJob, names: ReadonlyMap<string, string>): string | null {
  const total = job.steps.length;
  if (total === 0) return null;
  const done = job.steps.filter((step) => step.status !== "running").length;
  if (job.phase === "running") {
    const current = job.steps.findLast((step) => step.status === "running");
    return current === undefined
      ? `${done} of ${total} steps`
      : `Step ${done + 1} of ${total}: ${stepName(current, names)}`;
  }
  const failed = job.steps.filter((step) => step.status === "failed").length;
  const skipped = job.steps.filter((step) => step.status === "skipped").length;
  return [
    `${total - failed - skipped} of ${total} steps done`,
    failed > 0 ? `${failed} failed` : null,
    skipped > 0 ? `${skipped} skipped` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/**
 * The environment's running or last Gentle AI job, as one row: where it is, then how it ended,
 * with its steps and output behind Details. Jobs run on the server, so this reflects work any
 * client started, and survives closing the page. A finished job can be dismissed, and stays
 * dismissed on this device.
 */
export function GentleAiJobPanel({
  job,
  names,
}: {
  readonly job: GentleAiJob | null;
  readonly names: ReadonlyMap<string, string>;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dismissed, setDismissed] = useLocalStorage(DISMISSED_JOBS_KEY, [], DismissedJobs);
  if (job === null || dismissed.includes(job.id)) return null;
  const title = GENTLE_AI_JOB_LABELS[job.method];
  const outcome = syncOutcome(job);
  const failedSteps = job.steps.filter((step) => step.error);
  return (
    <SettingsSection title={job.phase === "running" ? "In progress" : "Last change"}>
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            {job.phase === "running" ? (
              <Spinner className="size-3.5" />
            ) : job.phase === "succeeded" ? (
              <CheckIcon className="size-3.5 text-success" aria-hidden />
            ) : (
              <CircleAlertIcon className="size-3.5 text-destructive" aria-hidden />
            )}
            {job.phase === "running"
              ? title
              : job.phase === "succeeded"
                ? `${title}: done`
                : `${title}: failed`}
          </span>
        }
        description={
          outcome === null
            ? jobProgress(job, names)
            : outcome.files === 0
              ? "No files changed."
              : `${outcome.files} ${outcome.files === 1 ? "file" : "files"} updated.`
        }
        status={
          job.error || failedSteps.length > 0 ? (
            <span role="alert" className="text-destructive">
              {job.error ??
                failedSteps.map((step) => `${stepName(step, names)}: ${step.error}`).join(" · ")}
            </span>
          ) : null
        }
        control={
          job.phase === "running" ? null : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setDismissed((previous) => [job.id, ...previous].slice(0, DISMISSED_JOBS_KEPT))
              }
            >
              Dismiss
            </Button>
          )
        }
      />
      {outcome !== null && outcome.manualActions.length > 0 ? (
        <SettingsRow
          title="Left for you to do"
          description={
            <ul className="list-disc pl-4">
              {outcome.manualActions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          }
        />
      ) : null}
      {job.steps.length > 0 || job.log.length > 0 ? (
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-1 px-4 py-2 text-muted-foreground text-xs hover:text-foreground">
            <ChevronRightIcon className={cn("size-3.5", detailsOpen && "rotate-90")} aria-hidden />
            Details
          </CollapsibleTrigger>
          <CollapsiblePanel>
            {job.steps.length > 0 ? (
              <ul className="grid gap-1 px-4 pb-3 text-sm @min-[40rem]/settings-row:grid-cols-2">
                {job.steps.map((step) => (
                  <li key={step.id} className="flex min-w-0 items-center gap-2">
                    <StepIcon status={step.status} />
                    <span className="truncate">{stepName(step, names)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {job.log.length > 0 ? (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap px-4 pb-3 font-mono text-xs">
                {job.log.join("\n")}
              </pre>
            ) : null}
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </SettingsSection>
  );
}
