/**
 * Makes sure a Boat machine has a project for a repository, with the branch a task starts from.
 * The machine's own T3 Code server clones and owns the checkout, as when a user adds a project to
 * a machine; this server only asks.
 *
 * @module boat/machineProject
 */
import {
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  BoatError,
  EnvironmentAuthorizationError,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2RpcSchemas,
  ProjectCloneListEvent,
  ProjectCloneStartInput,
  ProjectCloneStartResult,
  ProjectCloneSubscribeInput,
  ProjectId,
  SourceControlRepositoryError,
  WS_METHODS,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl, parseGitRemoteRepository } from "@t3tools/shared/git";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Rpc from "effect/rpc/Rpc";
import type * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export const MachineProjectRpcs = RpcGroup.make(
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {
    payload: OrchestrationV2RpcSchemas.subscribeShell.input,
    success: OrchestrationV2RpcSchemas.subscribeShell.output,
    error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
    stream: true,
  }),
  Rpc.make(WS_METHODS.projectCloneStart, {
    payload: ProjectCloneStartInput,
    success: ProjectCloneStartResult,
    error: Schema.Union([
      SourceControlRepositoryError,
      OrchestrationDispatchCommandError,
      EnvironmentAuthorizationError,
    ]),
  }),
  Rpc.make(WS_METHODS.subscribeProjectClones, {
    payload: ProjectCloneSubscribeInput,
    success: ProjectCloneListEvent,
    error: EnvironmentAuthorizationError,
    stream: true,
  }),
);

/** Reading the machine's projects and cloning a new one. */
export const MACHINE_PROJECT_SCOPES = [
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
] as const;

type MachineProjectClient = RpcClient.FromGroup<typeof MachineProjectRpcs, RpcClientError>;

export interface MachineProject {
  readonly projectId: ProjectId;
  /** The checkout's path on the machine. */
  readonly workspaceRoot: string;
}

const isBoatError = Schema.is(BoatError);
const isRepositoryError = Schema.is(SourceControlRepositoryError);
const isDispatchError = Schema.is(OrchestrationDispatchCommandError);

// What the machine says about its own failures is for the caller; anything else could carry the
// connection's details, so it is not passed on.
const boatErrorFrom = (error: unknown) =>
  isBoatError(error)
    ? error
    : new BoatError({
        detail: isRepositoryError(error)
          ? error.detail
          : isDispatchError(error)
            ? error.message
            : "The Boat machine did not answer.",
      });

// A directory name for the checkout, from the last segment of the repository's path.
const checkoutName = (remoteUrl: string) => {
  const name = parseGitRemoteRepository(remoteUrl)?.path.split("/").at(-1) ?? "";
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  return safe.length === 0 ? "project" : safe;
};

const cloneProject = Effect.fn("MachineProject.clone")(function* (
  client: MachineProjectClient,
  remoteUrl: string,
) {
  const name = checkoutName(remoteUrl);
  const projectId = ProjectId.make(yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.orDie));
  const started = yield* client[WS_METHODS.projectCloneStart]({
    projectId,
    title: name,
    createdAt: DateTime.formatIso(yield* DateTime.now),
    remoteUrl,
    destinationPath: `~/${name}`,
  });

  // The machine keeps a finished clone listed for a while, so the first list already has it.
  const finished = yield* client[WS_METHODS.subscribeProjectClones]({}).pipe(
    Stream.filterMap((clones) => {
      const clone = clones.find((candidate) => candidate.projectId === projectId);
      return clone?.phase === "running" ? Result.failVoid : Result.succeed(clone);
    }),
    Stream.runHead,
  );
  const clone = finished._tag === "Some" ? finished.value : undefined;
  if (clone?.phase !== "done") {
    return yield* new BoatError({
      detail:
        clone?.error ??
        (clone === undefined
          ? "The Boat machine lost track of the clone."
          : `The clone on the Boat machine was ${clone.phase}.`),
    });
  }
  return { projectId, workspaceRoot: started.cwd } satisfies MachineProject;
});

/**
 * The machine's project for `remoteUrl`, found by its origin remote or cloned into the machine's
 * home, with `branch` known to exist on its origin. `syncBranch` brings the checkout's view of
 * that branch up to date and says whether origin has it.
 */
export const ensureMachineProject = Effect.fn("MachineProject.ensure")(function* (input: {
  readonly client: MachineProjectClient;
  readonly remoteUrl: string;
  readonly branch: string;
  readonly syncBranch: (workspaceRoot: string) => Effect.Effect<boolean, BoatError>;
}) {
  const { client, remoteUrl } = input;
  const wanted = normalizeGitRemoteUrl(remoteUrl);

  const snapshot = yield* client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
    omitIdleSubagents: true,
    omitOlderSettled: true,
  }).pipe(
    Stream.filterMap((item) => (item.kind === "snapshot" ? Result.succeed(item) : Result.failVoid)),
    Stream.runHead,
  );
  const known =
    snapshot._tag === "None"
      ? undefined
      : snapshot.value.snapshot.projects.find((project) => {
          const identity = project.repositoryIdentity;
          return [identity?.locator.remoteUrl, identity?.origin?.remoteUrl].some(
            (url) => url !== undefined && normalizeGitRemoteUrl(url) === wanted,
          );
        });

  const project: MachineProject = known
    ? { projectId: known.id, workspaceRoot: known.workspaceRoot }
    : yield* cloneProject(client, remoteUrl);

  if (!(yield* input.syncBranch(project.workspaceRoot))) {
    return yield* new BoatError({
      detail: `The branch "${input.branch}" is not on origin, so the Boat machine cannot work from it. Push it with \`git push -u origin ${input.branch}\` first, then delegate again.`,
    });
  }
  return project;
}, Effect.mapError(boatErrorFrom));
