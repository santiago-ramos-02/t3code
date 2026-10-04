import { ProviderThreadId, type TurnTokenUsage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  derivePromptCache,
  formatPromptCacheCountdown,
  formatPromptCacheDuration,
  type PromptCacheSnapshot,
  type PromptCacheTurn,
  msUntilPromptCacheLabelChanges,
  promptCacheClockLabel,
  promptCacheLifeLeft,
  promptCacheNextMessage,
  promptCacheState,
  promptCacheTone,
} from "./promptCache";

const PROVIDER_THREAD = ProviderThreadId.make("provider-thread-1");
const at = (minutes: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 3, 12, minutes));
const iso = (minutes: number) => DateTime.formatIso(at(minutes));

const turnUsage = (read: number, fresh: number): TurnTokenUsage => ({
  usageStatus: "complete",
  usageScope: "main_agent",
  hasSubagents: false,
  inputTokens: read + fresh,
  outputTokens: 100,
  cachedInputTokens: read,
});

/** A turn from `start` to `end` minutes, its last request reported at `end`. */
const turn = (input: {
  readonly ordinal: number;
  readonly start: number;
  readonly end: number;
  readonly usage?: TurnTokenUsage;
  readonly ttl?: number;
  readonly running?: boolean;
}): PromptCacheTurn => ({
  providerThreadId: PROVIDER_THREAD,
  ordinal: input.ordinal,
  status: input.running ? "running" : "completed",
  startedAt: at(input.start),
  completedAt: input.running ? null : at(input.end),
  tokenUsage: {
    usedTokens: 40_000,
    ...(input.ttl === undefined ? {} : { cacheTtlSeconds: input.ttl }),
    updatedAt: iso(input.end),
  },
  ...(input.usage === undefined ? {} : { turnTokenUsage: input.usage }),
});

const derive = (turns: ReadonlyArray<PromptCacheTurn>) =>
  derivePromptCache({ providerTurns: turns, providerThreadId: PROVIDER_THREAD });

describe("derivePromptCache", () => {
  it("reads when the cache was last used and how long the provider keeps it", () => {
    const cache = derive([
      turn({ ordinal: 1, start: 0, end: 1, usage: turnUsage(0, 40_000), ttl: 300 }),
      // A request that reported no lifetime keeps the one an earlier request reported.
      turn({ ordinal: 2, start: 2, end: 3, usage: turnUsage(40_000, 30) }),
    ]);
    expect(cache).toEqual({ ttlSeconds: 300, lastUsedAt: Date.parse(iso(3)), working: false });
  });

  it("counts from the latest request, even one of a turn that reported no cache use", () => {
    // As a compaction does: its requests leave a cache the next message reads.
    const cache = derive([
      turn({ ordinal: 1, start: 0, end: 1, usage: turnUsage(0, 40_000), ttl: 3_600 }),
      turn({ ordinal: 2, start: 120, end: 122, usage: turnUsage(0, 0) }),
    ]);
    expect(cache?.lastUsedAt).toBe(Date.parse(iso(122)));
  });

  it("is warm while a turn runs", () => {
    const cache = derive([
      turn({ ordinal: 1, start: 0, end: 1, usage: turnUsage(0, 40_000), ttl: 300 }),
      turn({ ordinal: 2, start: 90, end: 91, running: true }),
    ]);
    expect(cache?.working).toBe(true);
  });

  it("has nothing to say for providers that report no cache use, or another provider thread", () => {
    expect(derive([turn({ ordinal: 1, start: 0, end: 1 })])).toBeNull();
    expect(
      derivePromptCache({
        providerTurns: [turn({ ordinal: 1, start: 0, end: 1, usage: turnUsage(0, 4) })],
        providerThreadId: ProviderThreadId.make("another"),
      }),
    ).toBeNull();
  });
});

describe("promptCacheState", () => {
  const cache = (overrides: Partial<PromptCacheSnapshot>): PromptCacheSnapshot => ({
    ttlSeconds: 300,
    lastUsedAt: 0,
    working: false,
    ...overrides,
  });

  it("counts down to expiry, then up from it", () => {
    expect(promptCacheState(cache({}), 60_000)).toEqual({ kind: "expiresIn", seconds: 240 });
    expect(promptCacheState(cache({}), 420_000)).toEqual({ kind: "expired", secondsAgo: 120 });
    expect(promptCacheState(cache({ working: true }), 420_000)).toEqual({ kind: "working" });
    expect(promptCacheState(cache({ ttlSeconds: null }), 90_000)).toEqual({
      kind: "unknown",
      idleSeconds: 90,
    });
  });

  it("goes from good to warning to critical as the cache runs out", () => {
    const hour = cache({ ttlSeconds: 3_600 });
    const left = (seconds: number) => promptCacheState(hour, (3_600 - seconds) * 1000);
    expect(promptCacheTone(hour, left(3_000))).toBe("good");
    expect(promptCacheTone(hour, left(1_200))).toBe("warning");
    expect(promptCacheTone(hour, left(45))).toBe("critical");
    expect(promptCacheTone(hour, left(0))).toBe("critical");
    expect(promptCacheLifeLeft(hour, left(1_800))).toBe(0.5);
    expect(promptCacheTone(cache({ ttlSeconds: null }), { kind: "unknown", idleSeconds: 5 })).toBe(
      "neutral",
    );
  });

  it("says what the next message gets from the cache", () => {
    expect(promptCacheNextMessage({ kind: "working" }, 50_000)).toBe(
      "Kept warm while the agent works",
    );
    expect(promptCacheNextMessage({ kind: "expiresIn", seconds: 600 }, 50_000)).toBe(
      "Next message reuses 50k tokens",
    );
    expect(promptCacheNextMessage({ kind: "expiresIn", seconds: 30 }, 50_000)).toBe(
      "Send now to reuse 50k tokens",
    );
    expect(promptCacheNextMessage({ kind: "expired", secondsAgo: 5 }, 40_000)).toBe(
      "Next message rebuilds 40k tokens",
    );
    expect(promptCacheNextMessage({ kind: "expired", secondsAgo: 5 }, 151_000)).toBe(
      "Next message rebuilds 151k tokens: compact first",
    );
    expect(promptCacheNextMessage({ kind: "expired", secondsAgo: 5 }, null)).toBe(
      "Next message rebuilds the cache",
    );
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
    expect(msUntilPromptCacheLabelChanges({ kind: "working" })).toBeNull();
  });

  it("says how long ago the cache was used when the provider gives no lifetime", () => {
    expect(promptCacheClockLabel({ kind: "unknown", idleSeconds: 750 })).toBe("used 12m ago");
    // 12:30 idle reads 12m until 13:00.
    expect(msUntilPromptCacheLabelChanges({ kind: "unknown", idleSeconds: 750 })).toBe(30_000);
    expect(promptCacheClockLabel({ kind: "unknown", idleSeconds: 7_300 })).toBe("used 2h ago");
  });
});
