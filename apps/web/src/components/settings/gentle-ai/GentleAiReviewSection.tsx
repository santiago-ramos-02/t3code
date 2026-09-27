import { useState } from "react";

import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Label } from "../../ui/label";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { GentleAiConfirm } from "./GentleAiConfirm";
import { GentleAiProjectPicker, useGentleAiProject } from "./GentleAiProjectPicker";
import {
  gentleAiReviewCloneDisabled,
  gentleAiReviewGlobalEnabled,
  gentleAiReviewStoreSummary,
  formatGentleAiBytes,
} from "./gentleAiSections.logic";
import type { GentleAiSectionProps } from "./GentleAiSettingsPage";
import { gentleAiJobResult, useGentleAiJob, useGentleAiQuery } from "./useGentleAi";

const SOURCE_LABELS: Record<string, string> = {
  default: "the default",
  global: "the global setting",
  clone_local: "this clone's override",
};

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

/**
 * Receipt-driven development: agents' code changes get an independent review before delivery.
 * gentle-ai reads the switch through a project, so every part here needs one.
 */
export function GentleAiReviewSection({
  environmentId,
  disabled,
  projects,
  startJob,
  onError,
}: GentleAiSectionProps) {
  const { cwd, setCwd } = useGentleAiProject(projects);
  const enabled = cwd !== null;
  const params = { cwd: cwd ?? "" };
  const mode = useGentleAiQuery(environmentId, "review.status", params, { enabled });
  const store = useGentleAiQuery(environmentId, "reviewStore.survey", params, { enabled });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [includeInFlight, setIncludeInFlight] = useState(false);

  const run = (promise: Promise<string | null>) =>
    void promise.then((error) => (error ? onError(error) : undefined));

  const counts = store.data === null ? null : gentleAiReviewStoreSummary(store.data);
  // The environment's latest job, when it was a reset, reports what it removed.
  const { job } = useGentleAiJob(environmentId);
  const lastReset = gentleAiJobResult(job, "reviewStore.reset");
  const storeStatus = store.error
    ? store.error
    : counts === null
      ? "Reading the review store…"
      : [
          counts.removable === 0 && counts.inFlight === 0
            ? "Nothing to remove"
            : `${count(counts.removable, "entry", "entries")} removable (${formatGentleAiBytes(counts.removableBytes)})`,
          counts.inFlight > 0 ? `${count(counts.inFlight, "review", "reviews")} in flight` : null,
          lastReset === null
            ? null
            : `Last reset removed ${count(lastReset.report.removed_files, "file", "files")}`,
        ]
          .filter((part) => part !== null)
          .join(" · ");

  return (
    <SettingsSection
      title="Receipt-driven development"
      headerAction={
        <div className="flex items-center gap-2">
          {mode.isPending && mode.data === null ? <Spinner className="size-3.5" /> : null}
          <GentleAiProjectPicker
            projects={projects}
            cwd={cwd}
            onChange={setCwd}
            label="Project for RDD"
          />
        </div>
      }
    >
      {cwd === null ? (
        <SettingsRow
          title="Add a project first"
          description="gentle-ai reads RDD through a project folder. Add a project to this environment to manage it."
        />
      ) : (
        <>
          {mode.error ? (
            <SettingsRow title="RDD unavailable" description={mode.error} />
          ) : mode.data === null ? null : (
            <>
              <SettingsRow
                title="Review changes before delivery"
                description="Agents get an independent review of their code changes before handing them off. Applies to every project."
                status={`${mode.data.status.effective === "on" ? "On" : "Off"} in this project, from ${SOURCE_LABELS[mode.data.status.source] ?? mode.data.status.source}.`}
                control={
                  <Switch
                    aria-label="Receipt-driven development"
                    checked={gentleAiReviewGlobalEnabled(mode.data)}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      run(startJob("review.set", { cwd, enabled: checked, scope: "global" }))
                    }
                  />
                }
              />
              <SettingsRow
                title="Turn off for this clone"
                description="Only this checkout, on this machine. Other clones keep the global setting."
                control={
                  <Switch
                    aria-label="Turn off RDD for this clone"
                    checked={gentleAiReviewCloneDisabled(mode.data)}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      run(startJob("review.set", { cwd, enabled: !checked, scope: "clone" }))
                    }
                  />
                }
              />
            </>
          )}
          <SettingsRow
            title="Review store"
            description="Review history this clone keeps for RDD."
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
                Reset
              </Button>
            }
          />
          <GentleAiConfirm
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            title="Reset the review store?"
            description={
              counts !== null && counts.inFlight > 0
                ? `Removes this clone's review history. Reviews still in flight (${counts.inFlight}) block the reset unless you remove them too. Nothing is copied aside, and it cannot be undone.`
                : "Removes this clone's review history. Nothing is copied aside, and it cannot be undone."
            }
            confirmLabel="Reset"
            destructive
            onConfirm={() =>
              run(
                startJob("reviewStore.reset", {
                  cwd,
                  ...(includeInFlight ? { includeInFlight } : {}),
                }),
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
                  Also remove reviews in flight
                </Label>
              </div>
            ) : null}
          </GentleAiConfirm>
        </>
      )}
    </SettingsSection>
  );
}
