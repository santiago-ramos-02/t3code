import type { UsageBucket, UsageDay, UsageSource, UsageSummary } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  hourlyWindows,
  importedUsageForWindow,
  mergeImportedUsage,
  withImportedUsage,
} from "./importedUsage.ts";

const HOUR = 60 * 60 * 1000;
const at = (iso: string) => Date.parse(iso);

function bucket(hourStart: string, overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: hourStart.slice(0, 10) as UsageDay,
    hourStart,
    provider: "claude",
    model: "claude-fable-5",
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: 100,
      cacheCreationTokens: 1,
      outputTokens: 5,
      reasoningTokens: 0,
    },
    costUsd: 1,
    cacheSavingsUsd: 0.5,
    costSource: "modelPriced",
    records: 2,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

function source(provider: UsageSource["fingerprint"]["provider"], home: string): UsageSource {
  return {
    fingerprint: { hostId: "boat-1", provider, resolvedHomePath: home, volumeId: "1:2" },
    status: "ok",
    scannedFiles: 1,
    skippedFiles: 0,
    malformedRecords: 0,
    distinctSessions: 1,
    message: null,
  };
}

function summary(buckets: UsageBucket[], sources: UsageSource[]): UsageSummary {
  return {
    contractVersion: 1,
    readAt: "2026-10-25T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-10-24" as UsageDay,
    untilDay: "2026-10-25" as UsageDay,
    buckets,
    sources,
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
  };
}

const claude = source("claude", "/root/.claude");

describe("hourlyWindows", () => {
  it("splits a span into reads of at most a day", () => {
    expect(hourlyWindows(0, 50 * HOUR)).toEqual([
      { sinceMs: 0, untilMs: 24 * HOUR },
      { sinceMs: 24 * HOUR, untilMs: 48 * HOUR },
      { sinceMs: 48 * HOUR, untilMs: 50 * HOUR },
    ]);
  });
});

describe("mergeImportedUsage", () => {
  it("replaces the hours it read again and keeps older ones", () => {
    const first = mergeImportedUsage(
      null,
      "https://boat-1.example",
      [
        {
          window: { sinceMs: at("2026-10-24T00:00:00Z"), untilMs: at("2026-10-24T03:00:00Z") },
          summary: summary(
            [bucket("2026-10-24T00:00:00.000Z"), bucket("2026-10-24T02:00:00.000Z")],
            [claude],
          ),
        },
      ],
      "2026-10-24T02:30:00.000Z",
      at("2026-10-24T02:00:00Z"),
    );
    // The bucket without a source path takes the provider's only source.
    expect(first.buckets.every((entry) => entry.sourcePath === "/root/.claude")).toBe(true);
    expect(first.capturedUntil).toBe("2026-10-24T02:00:00.000Z");

    const second = mergeImportedUsage(
      first,
      "https://boat-1.example",
      [
        {
          window: { sinceMs: at("2026-10-24T02:00:00Z"), untilMs: at("2026-10-24T04:00:00Z") },
          summary: summary(
            [
              bucket("2026-10-24T02:00:00.000Z", { costUsd: 3 }),
              bucket("2026-10-24T03:00:00.000Z"),
            ],
            [claude],
          ),
        },
      ],
      "2026-10-24T03:30:00.000Z",
      at("2026-10-24T03:00:00Z"),
    );
    expect(second.buckets.map((entry) => [entry.hourStart, entry.costUsd])).toEqual([
      ["2026-10-24T00:00:00.000Z", 1],
      ["2026-10-24T02:00:00.000Z", 3],
      ["2026-10-24T03:00:00.000Z", 1],
    ]);
    expect(second.readAt).toBe("2026-10-24T03:30:00.000Z");
  });
});

describe("importedUsageForWindow", () => {
  const kept = mergeImportedUsage(
    null,
    "https://boat-1.example",
    [
      {
        window: { sinceMs: at("2026-10-24T00:00:00Z"), untilMs: at("2026-10-25T06:00:00Z") },
        summary: summary(
          [
            bucket("2026-10-24T03:00:00.000Z"),
            bucket("2026-10-24T05:00:00.000Z"),
            bucket("2026-10-25T05:00:00.000Z"),
          ],
          [claude],
        ),
      },
    ],
    "2026-10-25T06:00:00.000Z",
    at("2026-10-25T06:00:00Z"),
  );

  it("regroups hours into the client's days in its time zone", () => {
    const result = importedUsageForWindow([kept], {
      sinceDay: "2026-10-23" as UsageDay,
      untilDay: "2026-10-24" as UsageDay,
      timeZone: "America/New_York",
    });
    // 03:00Z is the evening before in New York; 05:00Z on the 25th is the 25th's first hour.
    expect(result.buckets.map((entry) => [entry.day, entry.costUsd, entry.records])).toEqual([
      ["2026-10-23", 1, 2],
      ["2026-10-24", 1, 2],
    ]);
    expect(result.buckets.every((entry) => entry.hourStart === undefined)).toBe(true);
    expect(result.sources).toEqual([
      { ...claude, distinctSessions: 2, readAt: "2026-10-25T06:00:00.000Z" },
    ]);
  });

  it("sums the hours of one day", () => {
    const result = importedUsageForWindow([kept], {
      sinceDay: "2026-10-24" as UsageDay,
      untilDay: "2026-10-24" as UsageDay,
      timeZone: "UTC",
    });
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({ day: "2026-10-24", costUsd: 2, records: 4 });
  });

  it("keeps an hourly read to its window", () => {
    const result = importedUsageForWindow([kept], {
      sinceDay: "2026-10-24" as UsageDay,
      untilDay: "2026-10-25" as UsageDay,
      timeZone: "UTC",
      resolution: "hour",
      sinceTime: "2026-10-24T04:00:00.000Z",
      untilTime: "2026-10-25T04:00:00.000Z",
    });
    expect(result.buckets.map((entry) => entry.hourStart)).toEqual(["2026-10-24T05:00:00.000Z"]);
  });
});

describe("withImportedUsage", () => {
  it("attributes this server's own buckets before adding kept ones", () => {
    const own = source("claude", "C:/Users/me/.claude");
    const ownBucket = { ...bucket("2026-10-24T00:00:00.000Z"), hourStart: undefined };
    const merged = withImportedUsage(summary([ownBucket], [own]), {
      buckets: [bucket("2026-10-24T03:00:00.000Z", { sourcePath: "/root/.claude" })],
      sources: [claude],
    });
    expect(merged.buckets.map((entry) => entry.sourcePath)).toEqual([
      "C:/Users/me/.claude",
      "/root/.claude",
    ]);
    expect(merged.sources).toHaveLength(2);
  });
});
