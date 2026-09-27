import type { GentleAiJob, GentleAiJobMethod } from "@t3tools/contracts";
import { CheckIcon, ChevronRightIcon, CircleAlertIcon, MinusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../../lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { Spinner } from "../../ui/spinner";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { gentleAiJobResult } from "./useGentleAi";

/** What each job is called while it runs and after. */
export const GENTLE_AI_JOB_LABELS = {
  install: "Setting up Gentle AI",
  sync: "Syncing agent files",
  upgrade: "Upgrading tools",
  "models.set": "Applying models",
  "backups.restore": "Restoring backup",
  "backups.delete": "Deleting backup",
  "backups.rename": "Renaming backup",
  "backups.pin": "Updating backup",
  "plugins.install": "Installing OpenCode plugins",
  "plugins.uninstall": "Removing OpenCode plugin",
  "tools.install": "Installing community tools",
  "builder.generate": "Generating agent",
  "builder.install": "Installing agent",
  "review.set": "Changing RDD",
  "reviewStore.reset": "Resetting review store",
  "uninstall.run": "Uninstalling",
} satisfies Record<GentleAiJobMethod, string>;

/** What a sync changed: the files it rewrote and anything left to do by hand. */
function syncOutcome(job: GentleAiJob) {
  if (job.method !== "sync" && job.method !== "models.set") return null;
  const result = gentleAiJobResult(job, job.method);
  if (result === null) return null;
  return { files: result.files.length, manualActions: result.manualActions ?? [] };
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

/**
 * The environment's running or last Gentle AI job: its steps, output, and outcome. Jobs run on
 * the server, so this reflects work any client started, and survives closing the page.
 */
export function GentleAiJobPanel({
  job,
  names,
}: {
  readonly job: GentleAiJob | null;
  readonly names: ReadonlyMap<string, string>;
}) {
  const [logOpen, setLogOpen] = useState(false);
  if (job === null) return null;
  const title = GENTLE_AI_JOB_LABELS[job.method];
  const outcome = syncOutcome(job);
  return (
    <SettingsSection
      title={
        job.phase === "running"
          ? title
          : job.phase === "succeeded"
            ? `${title}: done`
            : `${title}: failed`
      }
      headerAction={job.phase === "running" ? <Spinner className="size-3.5" /> : null}
    >
      {job.error ? (
        <SettingsRow
          title="What went wrong"
          status={
            <span role="alert" className="text-destructive">
              {job.error}
            </span>
          }
        />
      ) : null}
      {outcome !== null ? (
        <SettingsRow
          title={
            outcome.files === 0
              ? "No files changed"
              : `${outcome.files} ${outcome.files === 1 ? "file" : "files"} updated`
          }
        />
      ) : null}
      {outcome !== null && outcome.manualActions.length > 0 ? (
        <SettingsRow
          title="Still to do by hand"
          description={
            <ul className="list-disc pl-4">
              {outcome.manualActions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          }
        />
      ) : null}
      {job.steps.length > 0 ? (
        <ul className="grid gap-1 px-4 py-3 text-sm @min-[40rem]/settings-row:grid-cols-2">
          {job.steps.map((step) => (
            <li key={step.id} className="flex min-w-0 items-center gap-2">
              <StepIcon status={step.status} />
              <span className="truncate">{gentleAiStepLabel(step.id, names)}</span>
              {step.error ? (
                <span className="truncate text-destructive text-xs">{step.error}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {job.log.length > 0 ? (
        <Collapsible open={logOpen} onOpenChange={setLogOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-1 px-4 py-2 text-muted-foreground text-xs hover:text-foreground">
            <ChevronRightIcon className={cn("size-3.5", logOpen && "rotate-90")} aria-hidden />
            Output ({job.log.length} lines)
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap px-4 pb-3 font-mono text-xs">
              {job.log.join("\n")}
            </pre>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </SettingsSection>
  );
}
