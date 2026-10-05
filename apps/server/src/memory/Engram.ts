// @effect-diagnostics nodeBuiltinImport:off -- Engram's server is shared with the agents' own hooks, which start it too, so it runs detached and outlives the server; Effect's scoped ChildProcess cannot start that.
import * as NodeChildProcess from "node:child_process";

import {
  MemoryError,
  type MemoryHealth,
  type MemoryObservation,
  type MemoryObservationDetail,
  type MemoryObsidianExportResult,
  type MemoryOverview,
  type MemorySearchResult,
  type MemoryStatus,
  type MemoryVerdict,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Clock from "effect/Clock";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { hostUserHome } from "../hostUserHome.ts";
import { spawnAndCollect } from "../provider/providerSnapshot.ts";

/**
 * Engram, the agents' persistent memory, as the Memory page reads it: through the HTTP server
 * Engram runs on this machine (`engram serve`, 127.0.0.1:7437). Clients never reach that server
 * themselves, so the page works the same remotely. When Engram is installed but its server is not
 * running, it is started the way the agents' hooks start it.
 */
export class Engram extends Context.Service<
  Engram,
  {
    readonly status: Effect.Effect<MemoryStatus>;
    readonly overview: Effect.Effect<MemoryOverview, MemoryError>;
    readonly search: (input: {
      readonly query: string;
      readonly project?: string | undefined;
      readonly type?: string | undefined;
    }) => Effect.Effect<MemorySearchResult, MemoryError>;
    readonly observation: (id: number) => Effect.Effect<MemoryObservationDetail, MemoryError>;
    readonly health: Effect.Effect<MemoryHealth, MemoryError>;
    readonly judge: (input: {
      readonly relationSyncId: string;
      readonly verdict: MemoryVerdict;
    }) => Effect.Effect<void, MemoryError>;
    readonly exportObsidian: (input: {
      readonly vault: string;
      readonly project?: string | undefined;
    }) => Effect.Effect<MemoryObsidianExportResult, MemoryError>;
  }
>()("t3/memory/Engram") {}

const DEFAULT_PORT = 7437;
// A server that will not come up is not started again for this long.
const START_COOLDOWN_MS = 60_000;
// The newest memories the overview carries; the brain map and activity work from these.
export const OVERVIEW_OBSERVATION_LIMIT = 2000;
const RELATIONS_PAGE = 500;
const RECENT_SESSIONS = 50;
const SNIPPET_CHARS = 240;
// Enough of a session summary for the sessions list; the whole memory opens from there.
const SESSION_SUMMARY_CHARS = 1200;

// Engram leaves empty fields out, so everything past the identity is optional.
const Optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));

const EngramObservation = Schema.Struct({
  id: Schema.Number,
  sync_id: Schema.String,
  session_id: Schema.String,
  type: Schema.String,
  title: Schema.String,
  content: Optional(Schema.String),
  project: Optional(Schema.String),
  scope: Optional(Schema.String),
  topic_key: Optional(Schema.String),
  revision_count: Optional(Schema.Number),
  created_at: Schema.String,
  updated_at: Optional(Schema.String),
});
type EngramObservation = typeof EngramObservation.Type;

const EngramHealth = Schema.Struct({ service: Schema.String, version: Optional(Schema.String) });
const EngramProjects = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      observation_count: Schema.Number,
      session_count: Schema.Number,
    }),
  ),
});
const EngramRelations = Schema.Struct({
  total: Schema.Number,
  relations: Schema.Array(
    Schema.Struct({
      sync_id: Schema.String,
      relation: Schema.String,
      judgment_status: Schema.String,
      source_id: Schema.String,
      target_id: Schema.String,
      source_title: Optional(Schema.String),
      target_title: Optional(Schema.String),
      updated_at: Schema.String,
    }),
  ),
});
const EngramSessions = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    project: Optional(Schema.String),
    started_at: Schema.String,
    ended_at: Optional(Schema.String),
    summary: Optional(Schema.String),
    observation_count: Optional(Schema.Number),
  }),
);
const EngramTimeline = Schema.Struct({
  before: Optional(Schema.Array(EngramObservation)),
  after: Optional(Schema.Array(EngramObservation)),
});
const EngramDoctor = Schema.Struct({
  status: Schema.String,
  checks: Schema.Array(
    Schema.Struct({
      check_id: Schema.String,
      result: Schema.String,
      message: Schema.String,
      safe_next_step: Optional(Schema.String),
    }),
  ),
});

const toObservation = (observation: EngramObservation): MemoryObservation => ({
  id: observation.id,
  syncId: observation.sync_id,
  sessionId: observation.session_id,
  type: observation.type,
  title: observation.title,
  project: observation.project ?? null,
  scope: observation.scope ?? "project",
  topicKey: observation.topic_key ?? null,
  revisionCount: observation.revision_count ?? 1,
  createdAt: observation.created_at,
  updatedAt: observation.updated_at ?? observation.created_at,
});

/** The start of a memory's content on one line, to show why a search matched it. */
/**
 * Reads the summary `engram obsidian-export` prints when it finishes: `Obsidian export complete`,
 * then `Created: N`, `Updated: N`, `Deleted: N`, and `Errors: N` followed by one `- …` line per
 * note it could not write. Null when the export did not get that far.
 */
export function obsidianExportSummary(output: string): MemoryObsidianExportResult | null {
  if (!output.includes("Obsidian export complete")) return null;
  const count = (label: string) =>
    Number(new RegExp(`^\\s*${label}:\\s*(\\d+)`, "m").exec(output)?.[1] ?? 0);
  const errors = output.split(/^\s*Errors:.*$/m)[1] ?? "";
  const problems = errors
    .split("\n")
    .flatMap((line) => (/^\s*- /.test(line) ? [line.replace(/^\s*- /, "").trim()] : []));
  return {
    created: count("Created"),
    updated: count("Updated"),
    deleted: count("Deleted"),
    problems,
  };
}

export function memorySnippet(content: string | null | undefined): string {
  const flat = (content ?? "").replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat;
}

/** Where gentle-ai's installer puts the engram binary, after PATH. */
export function engramInstallCandidates(
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const home = hostUserHome(environment, platform);
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local");
    return [path.join(localAppData, "engram", "bin", "engram.exe")];
  }
  return ["/usr/local/bin/engram", path.join(home, ".local", "bin", "engram")];
}

/** Starts `engram serve` detached, as the agents' hooks do, so it outlives this server. */
export type StartEngramServer = (
  binary: string,
  environment: NodeJS.ProcessEnv,
) => Effect.Effect<void>;

const startDetached: StartEngramServer = (binary, environment) =>
  Effect.sync(() => {
    const child = NodeChildProcess.spawn(binary, ["serve"], {
      detached: true,
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => undefined);
    child.unref();
  });

export const makeEngram = Effect.fn("makeEngram")(function* (
  options: { readonly startServer?: StartEngramServer } = {},
) {
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const startServer = options.startServer ?? startDetached;
  const port = Number(environment.ENGRAM_PORT?.trim()) || DEFAULT_PORT;
  const baseUrl = `http://127.0.0.1:${port}`;
  const fail = (detail: string) => new MemoryError({ detail });
  // One start at a time, and none again soon after one that did not come up.
  const startLock = yield* Semaphore.make(1);
  const lastStartAt = yield* Ref.make<number | null>(null);

  const binary = Effect.gen(function* () {
    const onPath = yield* resolveCommandPath("engram", { env: environment }).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (onPath) return onPath;
    for (const candidate of engramInstallCandidates(path, platform, environment)) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return candidate;
      }
    }
    return null;
  }).pipe(
    Effect.provideService(HostProcessEnvironment, environment),
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  const get = <A, I>(
    route: string,
    schema: Schema.Codec<A, I>,
    timeout: "2 seconds" | "15 seconds" = "15 seconds",
  ) =>
    httpClient.get(`${baseUrl}${route}`).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.timeout(timeout),
      Effect.mapError(() => fail("Engram did not answer. Check that its server is running.")),
    );

  const health = get("/health", EngramHealth, "2 seconds");

  const running = (version: string | null | undefined): MemoryStatus => ({
    state: "running",
    version: version ?? null,
  });
  const unreachable: MemoryStatus = {
    state: "unreachable",
    version: null,
    problem: `Engram is installed, but its server is not running on port ${port}.`,
  };

  const status: Effect.Effect<MemoryStatus> = Effect.gen(function* () {
    const answered = yield* health.pipe(Effect.option);
    if (answered._tag === "Some") return running(answered.value.version);
    const found = yield* binary;
    if (found === null) return { state: "not-installed", version: null } satisfies MemoryStatus;
    return yield* startLock.withPermits(1)(
      Effect.gen(function* () {
        // Another caller may have started it while this one waited.
        const again = yield* health.pipe(Effect.option);
        if (again._tag === "Some") return running(again.value.version);
        const now = yield* Clock.currentTimeMillis;
        const last = yield* Ref.get(lastStartAt);
        if (last !== null && now - last < START_COOLDOWN_MS) return unreachable;
        yield* Ref.set(lastStartAt, now);
        yield* startServer(found, environment);
        const started = yield* health.pipe(
          Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 20 }),
          Effect.option,
        );
        return started._tag === "Some" ? running(started.value.version) : unreachable;
      }),
    );
  });

  const relations = Effect.gen(function* () {
    const all: Array<(typeof EngramRelations.Type)["relations"][number]> = [];
    for (let offset = 0; ; offset += RELATIONS_PAGE) {
      const page = yield* get(
        `/conflicts?all_projects=true&limit=${RELATIONS_PAGE}&offset=${offset}`,
        EngramRelations,
      );
      all.push(...page.relations);
      if (page.relations.length < RELATIONS_PAGE || all.length >= page.total) return all;
    }
  });

  const overview = Effect.gen(function* () {
    const current = yield* status;
    if (current.state !== "running") {
      return {
        status: current,
        projects: [],
        observations: [],
        observationsTruncated: false,
        relations: [],
        sessions: [],
      } satisfies MemoryOverview;
    }
    const [projects, observations, edges, sessions] = yield* Effect.all(
      [
        get("/projects", EngramProjects),
        // One more than the overview keeps, to tell whether there were more.
        get(
          `/observations?all_projects=true&sort=created_at:desc&limit=${OVERVIEW_OBSERVATION_LIMIT + 1}`,
          Schema.Array(EngramObservation),
        ),
        relations,
        get(`/sessions/recent?all_projects=true&limit=${RECENT_SESSIONS}`, EngramSessions),
      ],
      { concurrency: "unbounded" },
    );
    // Agents save a session's summary as a memory of its own; Engram's session rows carry none.
    const summaries = new Map<string, EngramObservation>();
    for (const observation of observations) {
      if (observation.type === "session_summary" && !summaries.has(observation.session_id)) {
        summaries.set(observation.session_id, observation);
      }
    }
    return {
      status: current,
      projects: projects.projects.map((project) => ({
        name: project.name,
        observationCount: project.observation_count,
        sessionCount: project.session_count,
      })),
      observations: observations.slice(0, OVERVIEW_OBSERVATION_LIMIT).map(toObservation),
      observationsTruncated: observations.length > OVERVIEW_OBSERVATION_LIMIT,
      relations: edges.map((relation) => ({
        syncId: relation.sync_id,
        relation: relation.relation,
        judgmentStatus: relation.judgment_status,
        sourceId: relation.source_id,
        targetId: relation.target_id,
        sourceTitle: relation.source_title ?? "",
        targetTitle: relation.target_title ?? "",
        updatedAt: relation.updated_at,
      })),
      sessions: sessions.map((session) => ({
        id: session.id,
        project: session.project ?? null,
        startedAt: session.started_at,
        endedAt: session.ended_at ?? null,
        summary:
          session.summary?.trim() ||
          summaries.get(session.id)?.content?.trim().slice(0, SESSION_SUMMARY_CHARS) ||
          null,
        summaryMemoryId: summaries.get(session.id)?.id ?? null,
        observationCount: session.observation_count ?? 0,
      })),
    } satisfies MemoryOverview;
  });

  // Every read but the overview needs the server, which the overview starts.
  const requireRunning = Effect.gen(function* () {
    const current = yield* status;
    if (current.state !== "running") {
      return yield* fail(current.problem ?? "Engram is not running on this environment.");
    }
  });

  const query = (params: Record<string, string | undefined>) =>
    new URLSearchParams(
      Object.entries(params).flatMap(([key, value]): Array<[string, string]> =>
        value === undefined ? [] : [[key, value]],
      ),
    ).toString();

  const scopeParams = (project: string | undefined) =>
    project === undefined ? { all_projects: "true" } : { project };

  return Engram.of({
    status,
    overview,
    search: ({ query: text, project, type }) =>
      Effect.gen(function* () {
        yield* requireRunning;
        if (text.trim().length === 0) return { results: [] };
        const found = yield* get(
          `/search?${query({ q: text.trim(), type, limit: "40", ...scopeParams(project) })}`,
          Schema.Array(EngramObservation),
        );
        return {
          results: found.map((observation) => ({
            observation: toObservation(observation),
            snippet: memorySnippet(observation.content),
          })),
        };
      }),
    observation: (id) =>
      Effect.gen(function* () {
        yield* requireRunning;
        const [found, around] = yield* Effect.all(
          [
            get(`/observations/${id}`, EngramObservation),
            get(
              `/timeline?${query({ observation_id: String(id), before: "5", after: "5", all_projects: "true" })}`,
              EngramTimeline,
            ).pipe(Effect.orElseSucceed(() => ({ before: [], after: [] }))),
          ],
          { concurrency: "unbounded" },
        );
        return {
          observation: toObservation(found),
          content: found.content ?? "",
          before: (around.before ?? []).map(toObservation),
          after: (around.after ?? []).map(toObservation),
        };
      }),
    health: Effect.gen(function* () {
      yield* requireRunning;
      const doctor = yield* get("/doctor", EngramDoctor);
      return {
        status: doctor.status,
        checks: doctor.checks.map((check) => ({
          id: check.check_id,
          result: check.result,
          message: check.message,
          nextStep: check.safe_next_step?.trim() || null,
        })),
      };
    }),
    judge: ({ relationSyncId, verdict }) =>
      Effect.gen(function* () {
        yield* requireRunning;
        yield* HttpClientRequest.post(`${baseUrl}/conflicts/judge`).pipe(
          HttpClientRequest.bodyJson({ judgment_id: relationSyncId, relation: verdict }),
          Effect.flatMap(httpClient.execute),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.timeout("15 seconds"),
          Effect.mapError(() => fail("Engram could not record that.")),
        );
      }),
    exportObsidian: ({ vault, project }) =>
      Effect.gen(function* () {
        const folder = vault.trim();
        if (!path.isAbsolute(folder)) return yield* fail("Choose the vault's full folder path.");
        const info = yield* fileSystem.stat(folder).pipe(Effect.option);
        if (info._tag === "None" || info.value.type !== "Directory") {
          return yield* fail(`There is no folder at ${folder}.`);
        }
        const found = yield* binary;
        if (found === null) return yield* fail("Engram is not installed on this environment.");
        const args = [
          "obsidian-export",
          "--vault",
          folder,
          ...(project === undefined ? ["--all"] : ["--project", project]),
        ];
        const result = yield* spawnAndCollect(
          found,
          ChildProcess.make(found, args, { env: environment, extendEnv: false, stdin: "ignore" }),
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.timeout("5 minutes"),
          Effect.mapError(() => fail("Engram could not export to Obsidian.")),
        );
        const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
        // Engram exits 1 when any note failed, after writing the others; its summary says which.
        const summary = obsidianExportSummary(output);
        if (summary !== null) return summary;
        if (result.code !== 0) {
          return yield* fail(
            `Engram could not export to Obsidian. ${output.split("\n").slice(-3).join(" ")}`.trim(),
          );
        }
        return { created: 0, updated: 0, deleted: 0, problems: [] };
      }),
  });
});

export const layer = Layer.effect(Engram, makeEngram());
