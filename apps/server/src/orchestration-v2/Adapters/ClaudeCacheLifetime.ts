import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

export interface ClaudeCacheLifetimeShape {
  readonly latest: Effect.Effect<number | undefined>;
  readonly observe: (ttlSeconds: number) => Effect.Effect<void>;
}

/**
 * How long Claude keeps the prompt cache for this machine's Claude login, as Claude Code last
 * reported it. Providers that run Claude Code without passing its cache split on, such as Pi's
 * claude-bridge, read it here. Claude Code reports the lifetime on every turn that writes the
 * cache; the layer starts from the last one stored, so the value survives a restart.
 */
export class ClaudeCacheLifetime extends Context.Reference<ClaudeCacheLifetimeShape>(
  "t3/orchestration-v2/Adapters/ClaudeCacheLifetime",
  { defaultValue: () => ({ latest: Effect.succeed(undefined), observe: () => Effect.void }) },
) {}

export const layer = Layer.effect(
  ClaudeCacheLifetime,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const stored = yield* sql<{ readonly ttl: number | null }>`
      SELECT json_extract(turn.payload_json, '$.tokenUsage.cacheTtlSeconds') AS ttl
      FROM orchestration_v2_projection_provider_turns AS turn
      JOIN orchestration_v2_projection_provider_threads AS thread
        ON thread.provider_thread_id = turn.provider_thread_id
      WHERE thread.driver = 'claudeAgent' AND ttl IS NOT NULL
      ORDER BY turn.rowid DESC
      LIMIT 1
    `.pipe(Effect.orElseSucceed(() => []));
    const latest = yield* Ref.make(stored[0]?.ttl ?? undefined);
    return {
      latest: Ref.get(latest),
      observe: (ttlSeconds: number) => Ref.set(latest, ttlSeconds),
    };
  }),
);
