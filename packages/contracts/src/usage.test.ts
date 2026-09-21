import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  USAGE_CONTRACT_VERSION,
  USAGE_MERGE_COMPATIBLE_SINCE,
  UsageProviderKind,
  UsageSummary,
} from "./usage.ts";

const decodeProvider = Schema.decodeUnknownOption(UsageProviderKind);
const decodeSummary = Schema.decodeUnknownOption(UsageSummary);

function summary(contractVersion: number, provider: "claude" | "pi") {
  return {
    contractVersion,
    readAt: "2026-08-01T10:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-08-01",
    untilDay: "2026-08-01",
    buckets: [
      {
        day: "2026-08-01",
        provider,
        model: provider === "pi" ? "openrouter/meta/llama-4" : "claude-fable-5",
        totals: {
          uncachedInputTokens: 1,
          cachedInputTokens: 2,
          cacheCreationTokens: 3,
          outputTokens: 4,
          reasoningTokens: 1,
        },
        costUsd: 0.1,
        cacheSavingsUsd: 0,
        costSource: "providerReported",
        records: 1,
        unpricedRecords: 0,
        sessions: 1,
      },
    ],
    sources: [],
    pricing: { status: "unavailable", source: "test", fetchedAt: null, knownModels: 0 },
    scanDurationMs: 1,
  };
}

describe("usage contract compatibility", () => {
  it("adds Pi in contract v6 while retaining additive v4 compatibility", () => {
    expect(USAGE_CONTRACT_VERSION).toBe(6);
    expect(USAGE_MERGE_COMPATIBLE_SINCE).toBe(4);
    expect(Option.isSome(decodeProvider("pi"))).toBe(true);
    expect(Option.isSome(decodeSummary(summary(6, "pi")))).toBe(true);
  });

  it("continues decoding older compatible Claude summaries", () => {
    expect(Option.isSome(decodeSummary(summary(5, "claude")))).toBe(true);
  });
});
