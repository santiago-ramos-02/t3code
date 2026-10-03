import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  makeEngram,
  memorySnippet,
  obsidianExportSummary,
  OVERVIEW_OBSERVATION_LIMIT,
} from "./Engram.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const observation = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  sync_id: `obs-${id}`,
  session_id: "session-1",
  type: "decision",
  title: `Memory ${id}`,
  content: `The content of memory ${id}`,
  project: "t3code",
  scope: "project",
  revision_count: 1,
  created_at: "2026-10-01 10:00:00",
  updated_at: "2026-10-01 10:00:00",
  ...extra,
});

interface FakeEngram {
  /** Whether /health answers; flips when the server is started. */
  running: boolean;
  routes: Record<string, unknown>;
  requests: Array<{ readonly method: string; readonly url: string; readonly body?: unknown }>;
}

const httpClient = (fake: FakeEngram) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const body =
        request.body._tag === "Uint8Array"
          ? decodeJson(new TextDecoder().decode(request.body.body))
          : undefined;
      fake.requests.push({ method: request.method, url: `${url.pathname}${url.search}`, body });
      const respond = (status: number, value: unknown) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(encodeJson(value), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
      // A server that is not running answers nothing the service accepts.
      if (!fake.running) return respond(503, { error: "unavailable" });
      if (url.pathname === "/health") return respond(200, { service: "engram", version: "3.0.0" });
      const route = fake.routes[url.pathname];
      return route === undefined ? respond(404, { error: "not found" }) : respond(200, route);
    }),
  );

/** Runs one Engram service against a fake server, with a home that may hold an engram binary. */
const withEngram = <A, E>(
  fake: FakeEngram,
  use: (service: Effect.Success<ReturnType<typeof makeEngram>>) => Effect.Effect<A, E>,
  options: { readonly installed?: boolean; readonly onStart?: () => void } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-engram-" });
      if (options.installed) {
        const bin = path.join(home, ".local", "bin");
        yield* fileSystem.makeDirectory(bin, { recursive: true });
        yield* fileSystem.writeFileString(path.join(bin, "engram"), "");
      }
      const service = yield* makeEngram({
        startServer: () =>
          Effect.sync(() => {
            options.onStart?.();
            fake.running = true;
          }),
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient(fake)),
        // No PATH, so only the install folders are looked in.
        Effect.provideService(HostProcessEnvironment, { HOME: home, PATH: "" }),
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      return yield* use(service);
    }),
  );

const fake = (routes: Record<string, unknown> = {}, running = true): FakeEngram => ({
  running,
  routes,
  requests: [],
});

it.layer(NodeServices.layer)("Engram", (it) => {
  it.effect("says Engram is not installed when there is no server and no binary", () =>
    Effect.gen(function* () {
      const overview = yield* withEngram(fake({}, false), (engram) => engram.overview);
      expect(overview.status).toEqual({ state: "not-installed", version: null });
      expect(overview.observations).toEqual([]);
    }),
  );

  it.effect("starts an installed Engram's server once, then not again while it stays down", () =>
    Effect.gen(function* () {
      let starts = 0;
      const server = fake({}, false);
      const first = yield* withEngram(server, (engram) => engram.status, {
        installed: true,
        onStart: () => (starts += 1),
      });
      expect(first).toEqual({ state: "running", version: "3.0.0" });
      expect(starts).toBe(1);

      // A server that dies right after starting is reported, not restarted on every read.
      const down = fake({}, false);
      let downStarts = 0;
      const reads = yield* withEngram(
        down,
        (engram) =>
          Effect.gen(function* () {
            const once = yield* engram.status;
            down.running = false;
            const twice = yield* engram.status;
            return [once, twice] as const;
          }),
        { installed: true, onStart: () => (downStarts += 1) },
      );
      expect(reads[0].state).toBe("running");
      expect(reads[1].state).toBe("unreachable");
      expect(downStarts).toBe(1);
    }),
  );

  it.effect("carries memories without their content, every relation page, and sessions", () =>
    Effect.gen(function* () {
      const relations = Array.from({ length: 500 }, (_, index) => ({
        sync_id: `rel-${index}`,
        relation: "related",
        judgment_status: "judged",
        source_id: "obs-1",
        target_id: "obs-2",
        updated_at: "2026-10-01 10:00:00",
      }));
      const server = fake({
        "/projects": {
          projects: [{ name: "t3code", observation_count: 2, session_count: 1, prompt_count: 0 }],
        },
        "/observations": [observation(2), observation(1, { topic_key: "odd/feature" })],
        "/sessions/recent": [
          { id: "session-1", started_at: "2026-10-01 09:00:00", summary: "  Learned things  " },
        ],
      });
      // Two pages of relations: a full one, then one more.
      let page = 0;
      Object.defineProperty(server.routes, "/conflicts", {
        enumerable: true,
        get: () =>
          page++ === 0
            ? { total: 501, relations }
            : {
                total: 501,
                relations: [{ ...relations[0], sync_id: "rel-last", relation: "pending" }],
              },
      });
      const overview = yield* withEngram(server, (engram) => engram.overview);

      expect(overview.status.state).toBe("running");
      expect(overview.observations.map((entry) => entry.title)).toEqual(["Memory 2", "Memory 1"]);
      expect(overview.observations[1]?.topicKey).toBe("odd/feature");
      expect(Object.keys(overview.observations[0] ?? {})).not.toContain("content");
      expect(overview.observationsTruncated).toBe(false);
      expect(overview.relations).toHaveLength(501);
      expect(overview.relations.at(-1)?.relation).toBe("pending");
      expect(overview.sessions[0]).toMatchObject({ summary: "Learned things", project: null });
      // Every read covers every project, not the one Engram's server happened to start in.
      expect(
        server.requests.find((request) => request.url.startsWith("/observations"))?.url,
      ).toContain("all_projects=true");
    }),
  );

  it.effect("says when there are more memories than the overview carries", () =>
    Effect.gen(function* () {
      const many = Array.from({ length: OVERVIEW_OBSERVATION_LIMIT + 1 }, (_, index) =>
        observation(index + 1),
      );
      const overview = yield* withEngram(
        fake({
          "/projects": { projects: [] },
          "/observations": many,
          "/conflicts": { total: 0, relations: [] },
          "/sessions/recent": [],
        }),
        (engram) => engram.overview,
      );
      expect(overview.observations).toHaveLength(OVERVIEW_OBSERVATION_LIMIT);
      expect(overview.observationsTruncated).toBe(true);
    }),
  );

  it.effect("searches every project with a snippet, and records a verdict", () =>
    Effect.gen(function* () {
      const server = fake({
        "/search": [observation(3, { content: "line one\n\n   line two" })],
        "/conflicts/judge": { relation: {} },
      });
      const { found, empty } = yield* withEngram(server, (engram) =>
        Effect.gen(function* () {
          const empty = yield* engram.search({ query: "   " });
          const found = yield* engram.search({ query: "profiles", type: "decision" });
          yield* engram.judge({ relationSyncId: "rel-1", verdict: "supersedes" });
          return { found, empty };
        }),
      );
      expect(empty.results).toEqual([]);
      expect(found.results[0]?.snippet).toBe("line one line two");
      const search = server.requests.find((request) => request.url.startsWith("/search"));
      expect(search?.url).toContain("q=profiles");
      expect(search?.url).toContain("type=decision");
      expect(search?.url).toContain("all_projects=true");
      expect(server.requests.find((request) => request.method === "POST")?.body).toEqual({
        judgment_id: "rel-1",
        relation: "supersedes",
      });
    }),
  );

  it.effect("exports to Obsidian only into a folder that exists", () =>
    Effect.gen(function* () {
      const error = yield* withEngram(fake(), (engram) =>
        engram.exportObsidian({ vault: "relative/vault" }).pipe(Effect.flip),
      );
      expect(error.detail).toContain("full folder path");
    }),
  );
});

it("keeps a snippet to one short line", () => {
  expect(memorySnippet("a\n b")).toBe("a b");
  expect(memorySnippet("x".repeat(500))).toHaveLength(240);
  expect(memorySnippet(null)).toBe("");
});

it("reads Engram's export summary, including notes it could not write", () => {
  const output = [
    "Obsidian export complete",
    "  Created: 180",
    "  Updated: 2",
    "  Deleted: 1",
    "  Skipped: 0",
    "  Hubs:    15",
    "  Errors: 2",
    "    - write session hub /vault/engram/_sessions/a:resume:2.md: path escapes from parent",
    "    - write session hub /vault/engram/_sessions/b:resume:2.md: path escapes from parent",
  ].join("\n");
  expect(obsidianExportSummary(output)).toEqual({
    created: 180,
    updated: 2,
    deleted: 1,
    problems: [
      "write session hub /vault/engram/_sessions/a:resume:2.md: path escapes from parent",
      "write session hub /vault/engram/_sessions/b:resume:2.md: path escapes from parent",
    ],
  });
  expect(obsidianExportSummary("Obsidian export complete\n  Created: 3\n  Errors: 0")).toEqual({
    created: 3,
    updated: 0,
    deleted: 0,
    problems: [],
  });
  expect(obsidianExportSummary("error: vault not found")).toBeNull();
});
