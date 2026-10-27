import { useStableCallback } from "../../hooks/useStableCallback";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { DownloadIcon } from "lucide-react";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useRemoveClonedProject } from "../../hooks/useRemoveClonedProject";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useProjectClone } from "../../state/projectClones";
import {
  projectCloneDisplayName,
  projectCloneProgressSummary,
  type ProjectCloneSnapshot,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import {
  dismissMachineStart,
  dismissProjectFileCopy,
  retryMachineStart,
  useMachineStartJob,
  useProjectFileCopy,
  type MachineStartJob,
} from "../../lib/addProjectToMachine";
import { machineStartRows } from "../../lib/machineStartSteps";
import { BoatMachineStartSteps } from "./BoatMachineStartSteps";
import { type ComposerBannerStackItem } from "./ComposerBannerStack";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
/**
 * A project still being cloned or copied into place: the composer banner with its cancel,
 * retry, and remove actions, and the reason sending waits until it is done.
 */
export function useProjectCloneBanner(activeProjectRef: ScopedProjectRef | null) {
  const activeProjectClone = useProjectClone(activeProjectRef);
  const cancelProjectClone = useAtomCommand(sourceControlEnvironment.cancelProjectClone, {
    reportFailure: false,
  });
  const retryProjectClone = useAtomCommand(sourceControlEnvironment.retryProjectClone, {
    reportFailure: false,
  });
  const removeClonedProject = useRemoveClonedProject();
  const runProjectCloneAction = async (
    title: string,
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
  ): Promise<void> => {
    const result = await action();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };
  const runProjectCloneActionStable = useStableCallback(runProjectCloneAction);
  const activeProjectFileCopy = useProjectFileCopy(activeProjectRef);
  const projectCloneSendBlockReason =
    activeProjectClone?.phase === "running"
      ? "Cloning repository"
      : activeProjectClone !== null && activeProjectClone.phase !== "done"
        ? "Repository not cloned"
        : activeProjectFileCopy?.phase === "copying"
          ? "Copying files"
          : null;
  const startJob = useMachineStartJob(activeProjectRef);
  const startJobClone = useProjectClone(startJob?.destination ?? null);
  const cloneBannerItem = (() => {
    if (activeProjectFileCopy?.phase === "failed" && activeProjectRef) {
      return {
        id: `project-file-copy:${activeProjectRef.projectId}`,
        variant: "error",
        icon: <DownloadIcon />,
        title: activeProjectFileCopy.title,
        description: activeProjectFileCopy.failures.join("\n"),
        onDismiss: () => dismissProjectFileCopy(activeProjectRef),
      };
    }
    if (!activeProjectClone || !activeProjectRef || activeProjectClone.phase === "done") {
      return null;
    }
    const name = projectCloneDisplayName(activeProjectClone);
    const { environmentId, projectId } = activeProjectRef;
    if (activeProjectClone.phase === "running") {
      return {
        id: `project-clone:${projectId}`,
        variant: "info",
        icon: <DownloadIcon />,
        title: `Cloning ${name}`,
        description: projectCloneProgressSummary(activeProjectClone),
        actions: (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void runProjectCloneActionStable("Failed to cancel clone", () =>
                cancelProjectClone({ environmentId, input: { projectId } }),
              )
            }
          >
            Cancel
          </Button>
        ),
      };
    }
    const cancelled = activeProjectClone.phase === "cancelled";
    return {
      id: `project-clone:${projectId}`,
      variant: cancelled ? "warning" : "error",
      icon: <DownloadIcon />,
      title: cancelled ? `Cancelled cloning ${name}` : `Failed to clone ${name}`,
      description: cancelled ? "Retry to bring in the repository." : activeProjectClone.error,
      actions: (
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void removeClonedProject({ environmentId, projectId })}
          >
            Remove project
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void runProjectCloneActionStable("Failed to retry clone", () =>
                retryProjectClone({ environmentId, input: { projectId } }),
              )
            }
          >
            Retry
          </Button>
        </>
      ),
    };
  })() as ComposerBannerStackItem | null;
  // A project being added to another machine shows the machine's start steps ahead of the clone,
  // in the clone's own banner once the user is on the new project.
  const projectCloneBannerItem = startJob
    ? machineStartBannerItem(startJob, startJobClone, cloneBannerItem)
    : cloneBannerItem;
  return {
    projectCloneBannerItem,
    projectCloneSendBlockReason,
  };
}

function machineStartBannerItem(
  job: MachineStartJob,
  clone: ProjectCloneSnapshot | null,
  cloneItem: ComposerBannerStackItem | null,
): ComposerBannerStackItem {
  const rows = machineStartRows({
    steps: job.steps,
    phase: job.phase,
    failed: job.error !== null,
    clone,
  });
  const children = <BoatMachineStartSteps rows={rows} />;
  if (cloneItem) {
    return {
      ...cloneItem,
      description: cloneItem.variant === "info" ? undefined : cloneItem.description,
      children,
    };
  }
  if (job.error === null) {
    return {
      id: `machine-start:${job.id}`,
      variant: "info",
      icon: <DownloadIcon />,
      title: `Adding ${job.title} to ${job.targetLabel}`,
      children,
    };
  }
  return {
    id: `machine-start:${job.id}`,
    variant: "error",
    icon: <DownloadIcon />,
    title: `Could not add ${job.title} to ${job.targetLabel}`,
    description: job.error,
    children,
    actions: (
      <>
        <Button size="xs" variant="ghost" onClick={() => dismissMachineStart(job.id)}>
          Dismiss
        </Button>
        <Button size="xs" variant="ghost" onClick={() => retryMachineStart(job.id)}>
          Retry
        </Button>
      </>
    ),
  };
}
