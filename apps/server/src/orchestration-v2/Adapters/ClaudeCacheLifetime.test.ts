import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ClaudeCacheLifetime from "./ClaudeCacheLifetime.ts";

const storeTurn = (input: {
  readonly driver: string;
  readonly ordinal: number;
  readonly cacheTtlSeconds: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const providerThreadId = `provider-thread:${input.driver}`;
    yield* sql`
      INSERT OR IGNORE INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, provider, driver, status, updated_at, payload_json)
      VALUES (${providerThreadId}, 'thread-1', ${input.driver}, ${input.driver}, 'active',
        '2026-10-07T00:00:00.000Z', '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_turns
        (provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, payload_json)
      VALUES (${`${providerThreadId}:turn-${input.ordinal}`}, 'thread-1', ${providerThreadId},
        'node-1', ${input.ordinal}, 'completed',
        ${JSON.stringify({ tokenUsage: { cacheTtlSeconds: input.cacheTtlSeconds } })})
    `;
  });

const readLifetime = Effect.gen(function* () {
  return yield* ClaudeCacheLifetime.ClaudeCacheLifetime;
}).pipe(Effect.provide(ClaudeCacheLifetime.layer));

it.effect("starts from the lifetime Claude Code last stored, then follows what it reports", () =>
  Effect.gen(function* () {
    yield* storeTurn({ driver: "claudeAgent", ordinal: 1, cacheTtlSeconds: 300 });
    yield* storeTurn({ driver: "claudeAgent", ordinal: 2, cacheTtlSeconds: 3_600 });
    // Another provider's lifetime says nothing about Claude's.
    yield* storeTurn({ driver: "codex", ordinal: 3, cacheTtlSeconds: 1_800 });

    const lifetime = yield* readLifetime;
    assert.strictEqual(yield* lifetime.latest, 3_600);
    yield* lifetime.observe(300);
    assert.strictEqual(yield* lifetime.latest, 300);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("knows no lifetime before Claude Code reports one", () =>
  Effect.gen(function* () {
    const lifetime = yield* readLifetime;
    assert.strictEqual(yield* lifetime.latest, undefined);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
