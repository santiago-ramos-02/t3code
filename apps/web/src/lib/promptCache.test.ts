import {
  type ModelSelection,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  derivePromptCache,
  formatPromptCacheCountdown,
  formatPromptCacheDuration,
  type PromptCacheSnapshot,
  type PromptCacheTurn,
  msUntilPromptCacheLabelChanges,
  promptCacheAdvice,
  promptCacheClockLabel,
  promptCacheLifeLeft,
  promptCacheLifeTone,
  promptCacheState,
  promptCacheTone,
} from "./promptCache";

const PROVIDER_THREAD = ProviderThreadId.make("provider-thread-1");
const at = (minutes: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 3, 12, minutes));
const iso = (minutes: number) => DateTime.formatIso(at(minutes));

const selection = (model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claude"),
  model,
});

const turnUsage = (read: number, written: number | undefined, fresh: number): TurnTokenUsage => ({
  usageStatus: "complete",
  usageScope: "main_agent",
  hasSubagents: false,
  inputTokens: read + (written ?? 0) + fresh,
  outputTokens: 100,
  cachedInputTokens: read,
  ...(written === undefined ? {} : { cacheCreationTokens: written }),
});

/** A finished turn from `start` to `end` minutes, its last request sending `context` tokens. */
const turn = (input: {
  readonly ordinal: number;
  readonly start: number;
  readonly end: number;
  readonly context: number;
  readonly usage?: TurnTokenUsage;
  readonly ttl?: number;
  readonly running?: boolean;
}): PromptCacheTurn => ({
  providerThreadId: PROVIDER_THREAD,
  runAttemptId: RunAttemptId.make(`attempt-${input.ordinal}`),
  ordinal: input.ordinal,
  status: input.running ? "running" : "completed",
  startedAt: at(input.start),
  completedAt: input.running ? null : at(input.end),
  tokenUsage: {
    usedTokens: input.context,
    inputTokens: input.context,
    ...(input.ttl === undefined ? {} : { cacheTtlSeconds: input.ttl }),
    updatedAt: iso(input.end),
  },
  ...(input.usage === undefined ? {} : { turnTokenUsage: input.usage }),
});

const runsFor = (models: ReadonlyArray<string>) => ({
  attempts: models.map((_, index) => ({
    id: RunAttemptId.make(`attempt-${index + 1}`),
    runId: RunId.make(`run-${index + 1}`),
  })),
  runs: models.map((model, index) => ({
    id: RunId.make(`run-${index + 1}`),
    modelSelection: selection(model),
  })),
});

const derive = (turns: ReadonlyArray<PromptCacheTurn>, models: ReadonlyArray<string>) =>
  derivePromptCache({
    providerTurns: turns,
    providerThreadId: PROVIDER_THREAD,
    ...runsFor(models),
  });

describe("derivePromptCache", () => {
  it("reads the last turn's cache use and when the cache was last used", () => {
    const cache = derive(
      [
        turn({ ordinal: 1, start: 0, end: 1, context: 40_000, usage: turnUsage(0, 40_000, 10) }),
        turn({
          ordinal: 2,
          start: 2,
          end: 3,
          context: 42_000,
          usage: turnUsage(120_000, 2_000, 30),
          ttl: 3_600,
        }),
      ],
      ["opus", "opus"],
    );
    expect(cache).toMatchObject({
      readTokens: 120_000,
      writtenTokens: 2_000,
      uncachedTokens: 30,
      ttlSeconds: 3_600,
      lastUsedAt: Date.parse(iso(3)),
      working: false,
      miss: null,
    });
    expect(cache?.hitRate).toBeCloseTo(120_000 / 122_030);
    // One row per finished turn, for the table.
    expect(cache?.turns.map((row) => [row.number, row.readTokens, row.writtenTokens])).toEqual([
      [1, 0, 40_000],
      [2, 120_000, 2_000],
    ]);
  });

  it("says the cache had expired when the turn came after its lifetime", () => {
    const cache = derive(
      [
        turn({
          ordinal: 1,
          start: 0,
          end: 1,
          context: 40_000,
          usage: turnUsage(0, 40_000, 10),
          ttl: 300,
        }),
        turn({ ordinal: 2, start: 11, end: 12, context: 41_000, usage: turnUsage(0, 41_000, 5) }),
      ],
      ["opus", "opus"],
    );
    expect(cache?.miss).toEqual({ kind: "expired", idleSeconds: 600 });
    // A request that wrote nothing new keeps the lifetime an earlier one reported.
    expect(cache?.ttlSeconds).toBe(300);
  });

  it("blames a model change when the cache was still alive", () => {
    const cache = derive(
      [
        turn({ ordinal: 1, start: 0, end: 1, context: 40_000, usage: turnUsage(0, 40_000, 10) }),
        turn({
          ordinal: 2,
          start: 2,
          end: 3,
          context: 41_000,
          usage: turnUsage(0, 41_000, 5),
          ttl: 3_600,
        }),
      ],
      ["opus", "sonnet"],
    );
    expect(cache?.miss).toEqual({ kind: "model" });
  });

  it("blames a changed context otherwise, and nothing when most of it was reused", () => {
    const rewritten = derive(
      [
        turn({ ordinal: 1, start: 0, end: 1, context: 40_000, usage: turnUsage(0, 40_000, 10) }),
        turn({ ordinal: 2, start: 2, end: 3, context: 41_000, usage: turnUsage(0, 30_000, 5) }),
      ],
      ["opus", "opus"],
    );
    expect(rewritten?.miss).toEqual({ kind: "context" });
  });

  it("reports reads alone for a provider that does not report writes", () => {
    const cache = derive(
      [
        turn({
          ordinal: 1,
          start: 0,
          end: 1,
          context: 40_000,
          usage: turnUsage(30_000, undefined, 10_000),
        }),
      ],
      ["gpt"],
    );
    expect(cache).toMatchObject({
      readTokens: 30_000,
      writtenTokens: null,
      uncachedTokens: 10_000,
      ttlSeconds: null,
      miss: null,
    });
  });

  it("is warm while a turn runs, last used at its latest request", () => {
    const cache = derive(
      [
        turn({ ordinal: 1, start: 0, end: 1, context: 40_000, usage: turnUsage(0, 40_000, 10) }),
        turn({ ordinal: 2, start: 5, end: 6, context: 41_000, running: true }),
      ],
      ["opus", "opus"],
    );
    expect(cache).toMatchObject({ working: true, lastUsedAt: Date.parse(iso(6)) });
  });

  it("has nothing to say for providers that report no cache use, or another provider thread", () => {
    const plain = turn({ ordinal: 1, start: 0, end: 1, context: 40_000 });
    expect(derive([plain], ["opus"])).toBeNull();
    expect(
      derivePromptCache({
        providerTurns: [
          turn({ ordinal: 1, start: 0, end: 1, context: 4, usage: turnUsage(0, 4, 0) }),
        ],
        providerThreadId: ProviderThreadId.make("another"),
        ...runsFor(["opus"]),
      }),
    ).toBeNull();
  });
});

describe("promptCacheState", () => {
  const cache = (overrides: Partial<PromptCacheSnapshot>): PromptCacheSnapshot => ({
    readTokens: 1,
    writtenTokens: 0,
    uncachedTokens: 0,
    hitRate: 1,
    ttlSeconds: 300,
    lastUsedAt: 0,
    working: false,
    miss: null,
    turns: [],
    ...overrides,
  });

  it("counts down to expiry, then up from it", () => {
    expect(promptCacheState(cache({}), 60_000)).toEqual({ kind: "expiresIn", seconds: 240 });
    expect(promptCacheState(cache({}), 420_000)).toEqual({ kind: "expired", secondsAgo: 120 });
    expect(promptCacheState(cache({ working: true }), 420_000)).toEqual({ kind: "working" });
    expect(promptCacheState(cache({ ttlSeconds: null }), 0)).toEqual({ kind: "unknown" });
  });

  it("goes from good to warning to critical as the cache runs out", () => {
    const hour = cache({ ttlSeconds: 3_600 });
    const at = (seconds: number) => promptCacheState(hour, (3_600 - seconds) * 1000);
    expect(promptCacheTone(hour, at(3_000))).toBe("good");
    expect(promptCacheTone(hour, at(1_200))).toBe("warning");
    expect(promptCacheTone(hour, at(45))).toBe("critical");
    expect(promptCacheTone(hour, at(0))).toBe("critical");
    expect(promptCacheLifeLeft(hour, at(1_800))).toBe(0.5);
    // A miss reads as critical while the new cache lives, and a provider without a lifetime by
    // its hit rate.
    const missed = cache({ ttlSeconds: 3_600, miss: { kind: "model" } });
    expect(promptCacheTone(missed, at(3_000))).toBe("critical");
    // The new cache it wrote is fresh, which its life reads as.
    expect(promptCacheLifeTone(missed, at(3_000))).toBe("good");
    expect(promptCacheTone(cache({ ttlSeconds: null, hitRate: 0.5 }), { kind: "unknown" })).toBe(
      "warning",
    );
  });

  it("says what to do in a few words: keep going, send something soon, or compact first", () => {
    const hour = cache({ ttlSeconds: 3_600 });
    expect(promptCacheAdvice(hour, { kind: "expiresIn", seconds: 600 }, 50_000)).toBe("Keep going");
    expect(promptCacheAdvice(hour, { kind: "expiresIn", seconds: 30 }, 50_000)).toBe(
      "Send a message to keep it",
    );
    expect(promptCacheAdvice(hour, { kind: "expired", secondsAgo: 5 }, 151_000)).toBe(
      "Expired: compact first",
    );
    expect(promptCacheAdvice(hour, { kind: "expired", secondsAgo: 5 }, 40_000)).toBe(
      "Expired: rebuilds 40k tokens",
    );
    expect(
      promptCacheAdvice(
        cache({ miss: { kind: "expired", idleSeconds: 600 } }),
        { kind: "expiresIn", seconds: 290 },
        null,
      ),
    ).toBe("Missed: expired after 10 min idle");
    expect(promptCacheAdvice(cache({ ttlSeconds: null }), { kind: "unknown" }, null)).toBeNull();
  });

  it("formats countdowns and durations", () => {
    expect(formatPromptCacheCountdown(245)).toBe("4:05");
    expect(formatPromptCacheCountdown(3_600)).toBe("1:00:00");
    expect(formatPromptCacheDuration(45)).toBe("45 s");
    expect(formatPromptCacheDuration(600)).toBe("10 min");
    expect(formatPromptCacheDuration(7_500)).toBe("2 h 5 min");
  });

  it("shows minutes, then seconds in the last five minutes", () => {
    const counting = promptCacheState(cache({ ttlSeconds: 3_600 }), 5 * 60_000 + 4_000);
    expect(promptCacheClockLabel(counting)).toBe("55m");
    // 54:56 left reads 55m until 54:00, 56 seconds from now.
    expect(msUntilPromptCacheLabelChanges(counting)).toBe(56_000);
    // 5:30 left changes to the seconds count in 30 seconds, then every second.
    expect(msUntilPromptCacheLabelChanges({ kind: "expiresIn", seconds: 330 })).toBe(30_000);
    expect(promptCacheClockLabel({ kind: "expiresIn", seconds: 252 })).toBe("4:12");
    expect(msUntilPromptCacheLabelChanges({ kind: "expiresIn", seconds: 252 })).toBe(1_000);
    expect(promptCacheClockLabel({ kind: "expired", secondsAgo: 1 })).toBe("expired");
    expect(promptCacheClockLabel({ kind: "unknown" })).toBeNull();
    expect(msUntilPromptCacheLabelChanges({ kind: "working" })).toBeNull();
  });
});
