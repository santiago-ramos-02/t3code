import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  BoatSize,
  EnvironmentId,
  ProjectCloneSnapshot,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";
import { create } from "zustand";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjectClonesAtom, silenceProjectCloneToasts } from "../state/projectClones";
import { projectEnvironment } from "../state/projects";
import { environmentServerConfigsAtom } from "../state/server";
import { sourceControlEnvironment } from "../state/sourceControl";
import { startBoatMachine } from "./boatMachine";
import type { MachineStartStep } from "./machineStartSteps";

/** Matches the server's read cap: a larger file would arrive truncated. */
export const COPYABLE_FILE_MAX_BYTES = 1024 * 1024;

const DEFAULT_COPIED_FILE_NAME = /^(?:\.env(?:\..+)?|\.envrc|\.dev\.vars)$/;

/** Env files are the ignored files people almost always want on a new machine. */
export function isDefaultCopiedFile(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  return DEFAULT_COPIED_FILE_NAME.test(name);
}

export interface AddProjectToMachineInput {
  readonly source: { readonly environmentId: EnvironmentId; readonly cwd: string };
  /** Where the source project sits below its repository root, or "". */
  readonly subdirectory: string;
  readonly target: { readonly environmentId: EnvironmentId; readonly label: string };
  readonly projectId: ProjectId;
  readonly title: string;
  readonly remoteUrl: string;
  readonly destinationPath: string;
  readonly files: ReadonlyArray<string>;
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An error occurred.";
}

/**
 * Resolves when the clone finishes, or null once it is removed. A failed or
 * cancelled clone keeps waiting, since the composer offers a retry.
 */
export function waitForClone(environmentId: EnvironmentId, projectId: ProjectId) {
  return new Promise<ProjectCloneSnapshot | null>((resolve) => {
    const atom = environmentProjectClonesAtom(environmentId);
    let seen = false;
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const check = (clones: ReadonlyArray<ProjectCloneSnapshot>) => {
      if (settled) return;
      const clone = clones.find((candidate) => candidate.projectId === projectId);
      if (clone) seen = true;
      const result = clone?.phase === "done" ? clone : !clone && seen ? null : undefined;
      if (result === undefined) return;
      settled = true;
      unsubscribe?.();
      resolve(result);
    };
    unsubscribe = appAtomRegistry.subscribe(atom, check);
    check(appAtomRegistry.get(atom));
  });
}

export type ProjectFileCopy =
  | { readonly phase: "copying" }
  | { readonly phase: "failed"; readonly title: string; readonly failures: ReadonlyArray<string> };

/** Ignored-file copies still owed to a cloned project, keyed by its scoped project key. */
const useFileCopies = create<{ copies: Readonly<Record<string, ProjectFileCopy>> }>(() => ({
  copies: {},
}));

function setFileCopy(key: string, copy: ProjectFileCopy | null) {
  useFileCopies.setState(({ copies }) => {
    const { [key]: _previous, ...rest } = copies;
    return { copies: copy === null ? rest : { ...rest, [key]: copy } };
  });
}

/** The composer holds sends until the copy lands, and shows a failed copy until dismissed. */
export function useProjectFileCopy(ref: ScopedProjectRef | null): ProjectFileCopy | null {
  return useFileCopies((state) => (ref ? (state.copies[scopedProjectKey(ref)] ?? null) : null));
}

export function dismissProjectFileCopy(ref: ScopedProjectRef) {
  setFileCopy(scopedProjectKey(ref), null);
}

/**
 * Clones a project onto another machine, then copies the chosen ignored files
 * from the source. The client relays the files because the two servers never
 * talk to each other. Resolves once the clone starts. The caller opens the new
 * project, whose composer shows the clone and copy progress, so nothing toasts.
 */
export async function addProjectToMachine(input: AddProjectToMachineInput): Promise<void> {
  // Read first, so the copy reflects the files as they were when the user asked.
  const reads = await Promise.all(
    input.files.map(async (relativePath) => {
      const result = await executeAtomQuery(
        appAtomRegistry,
        projectEnvironment.readFile({
          environmentId: input.source.environmentId,
          input: { cwd: input.source.cwd, relativePath },
        }),
        { label: "Read file to copy", reportFailure: false, refresh: true },
      );
      if (result._tag === "Failure") return { relativePath, error: failureMessage(result) };
      if (result.value.truncated) return { relativePath, error: "Too large to copy." };
      return { relativePath, contents: result.value.contents };
    }),
  );

  const targetRef = { environmentId: input.target.environmentId, projectId: input.projectId };
  const copyKey = scopedProjectKey(targetRef);
  // Marked before the start request, since the clone list can arrive before its reply.
  silenceProjectCloneToasts(targetRef);
  if (reads.length > 0) setFileCopy(copyKey, { phase: "copying" });
  const started = await runAtomCommand(
    appAtomRegistry,
    sourceControlEnvironment.startProjectClone,
    {
      environmentId: input.target.environmentId,
      input: {
        projectId: input.projectId,
        title: input.title,
        createdAt: new Date().toISOString(),
        remoteUrl: input.remoteUrl,
        destinationPath: input.destinationPath,
      },
    },
    { label: "Add project to machine", reportFailure: false },
  );
  if (started._tag === "Failure") {
    setFileCopy(copyKey, null);
    throw new Error(failureMessage(started));
  }
  if (reads.length === 0) return;

  void (async () => {
    const clone = await waitForClone(input.target.environmentId, input.projectId);
    if (!clone) {
      setFileCopy(copyKey, null);
      return;
    }
    const failed: Array<string> = [];
    for (const read of reads) {
      if (!("contents" in read)) {
        failed.push(`${read.relativePath}: ${read.error}`);
        continue;
      }
      const written = await runAtomCommand(
        appAtomRegistry,
        projectEnvironment.writeFile,
        {
          environmentId: input.target.environmentId,
          input: {
            cwd: started.value.cwd,
            relativePath: input.subdirectory
              ? `${input.subdirectory}/${read.relativePath}`
              : read.relativePath,
            contents: read.contents,
          },
        },
        { label: "Copy file to machine", reportFailure: false },
      );
      if (written._tag === "Failure")
        failed.push(`${read.relativePath}: ${failureMessage(written)}`);
    }
    setFileCopy(
      copyKey,
      failed.length === 0
        ? null
        : {
            phase: "failed",
            title: `Could not copy ${failed.length} ${failed.length === 1 ? "file" : "files"} to ${input.target.label}`,
            failures: failed,
          },
    );
  })();
}

/** A project being added to another machine, from the confirmed dialog until its clone is done. */
export interface MachineStartJob {
  readonly id: string;
  readonly source: ScopedProjectRef;
  /** Set once the clone started on the machine, which is where the user lands. */
  readonly destination: ScopedProjectRef | null;
  readonly title: string;
  readonly targetLabel: string;
  readonly steps: ReadonlyArray<MachineStartStep>;
  readonly phase: "machine" | "clone";
  readonly error: string | null;
}

export interface MachineStartRun {
  readonly source: ScopedProjectRef;
  readonly title: string;
  readonly targetLabel: string;
  /** A new Boat machine started for the project, or a machine that is already connected. */
  readonly destination:
    | {
        readonly kind: "boat";
        readonly hostEnvironmentId: EnvironmentId;
        readonly size: BoatSize;
        readonly projectId: ProjectId | null;
      }
    | { readonly kind: "machine"; readonly environmentId: EnvironmentId; readonly label: string };
  readonly add: Omit<AddProjectToMachineInput, "target">;
  /** Called once the clone started, to take the user to the new project. */
  readonly onStarted: (target: ScopedProjectRef) => void;
}

const useMachineStarts = create<{ jobs: Readonly<Record<string, MachineStartJob>> }>(() => ({
  jobs: {},
}));

function patchJob(id: string, changes: Partial<MachineStartJob> | null) {
  useMachineStarts.setState(({ jobs }) => {
    const { [id]: job, ...rest } = jobs;
    if (!job) return { jobs };
    return { jobs: changes === null ? rest : { ...rest, [id]: { ...job, ...changes } } };
  });
}

/** The job whose rows this project's composer shows: on the source until the user lands. */
export function useMachineStartJob(ref: ScopedProjectRef | null): MachineStartJob | null {
  return useMachineStarts((state) => {
    if (!ref) return null;
    const key = scopedProjectKey(ref);
    return (
      Object.values(state.jobs).find(
        (job) =>
          scopedProjectKey(job.source) === key ||
          (job.destination !== null && scopedProjectKey(job.destination) === key),
      ) ?? null
    );
  });
}

// What a retry needs. A machine that already started is kept, so a retry never starts a second.
const runs = new Map<
  string,
  { readonly run: MachineStartRun; machine: { environmentId: EnvironmentId; label: string } | null }
>();
let jobCount = 0;

async function execute(id: string) {
  const entry = runs.get(id);
  if (!entry) return;
  const { run } = entry;
  patchJob(id, { error: null });
  try {
    if (run.destination.kind === "boat" && entry.machine === null) {
      patchJob(id, { phase: "machine", steps: [] });
      entry.machine = await startBoatMachine({
        hostEnvironmentId: run.destination.hostEnvironmentId,
        size: run.destination.size,
        projectId: run.destination.projectId,
        onSteps: (steps) => patchJob(id, { steps }),
      });
    }
    const target =
      run.destination.kind === "machine"
        ? { environmentId: run.destination.environmentId, label: run.destination.label }
        : entry.machine;
    if (!target) return;
    patchJob(id, { phase: "clone" });
    await addProjectToMachine({ ...run.add, target });
    const destination = scopeProjectRef(target.environmentId, run.add.projectId);
    patchJob(id, { destination });
    run.onStarted(destination);
    const tracked =
      appAtomRegistry.get(environmentServerConfigsAtom).get(target.environmentId)?.environment
        .capabilities.projectCloneTracking === true;
    if (!tracked) return dismissMachineStart(id);
    void waitForClone(target.environmentId, run.add.projectId).then(() => dismissMachineStart(id));
  } catch (cause) {
    patchJob(id, { error: cause instanceof Error ? cause.message : "Could not add the project." });
  }
}

/**
 * Adds a project to another machine after the dialog closes: starts the Boat machine when asked,
 * then clones. Progress is the job's rows in the composer, and a failure there offers a retry.
 */
export function startAddProjectToMachine(run: MachineStartRun) {
  const id = `machine-start-${++jobCount}`;
  runs.set(id, { run, machine: null });
  useMachineStarts.setState(({ jobs }) => ({
    jobs: {
      ...jobs,
      [id]: {
        id,
        source: run.source,
        destination: null,
        title: run.title,
        targetLabel: run.targetLabel,
        steps: [],
        phase: run.destination.kind === "boat" ? "machine" : "clone",
        error: null,
      },
    },
  }));
  void execute(id);
}

export function retryMachineStart(id: string) {
  void execute(id);
}

export function dismissMachineStart(id: string) {
  runs.delete(id);
  patchJob(id, null);
}
