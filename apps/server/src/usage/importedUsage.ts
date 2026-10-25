/**
 * Usage this server keeps for other machines, such as Boat machines, so their usage still
 * counts once they stop or are deleted. Each file holds one machine's hourly UTC buckets,
 * which regroup into any window and time zone a client asks for.
 *
 * @module usage/importedUsage
 */
import {
  UsageBucket,
  UsageSource,
  type UsageDay,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { makeDayFormatter } from "./usageAggregation.ts";

export const IMPORTED_USAGE_DIRECTORY = "imported-usage";

const HOUR_MS = 60 * 60 * 1000;

export const ImportedUsage = Schema.Struct({
  /** The machine's T3 Code address, stable across a restore from a snapshot. */
  machineUrl: Schema.String,
  /** When the sources were last read. */
  readAt: Schema.String,
  /** Hours before this are complete; later ones are read again. */
  capturedUntil: Schema.String,
  sources: Schema.Array(UsageSource),
  /** Hourly buckets, keyed by their UTC `hourStart`. */
  buckets: Schema.Array(UsageBucket),
});
export type ImportedUsage = typeof ImportedUsage.Type;

const ImportedUsageJson = Schema.fromJsonString(ImportedUsage);
export const encodeImportedUsage = Schema.encodeSync(ImportedUsageJson);
const decodeImportedUsage = Schema.decodeUnknownOption(ImportedUsageJson);

export function importedUsageFileName(machineUrl: string): string {
  return `${machineUrl.replace(/^https?:\/\//, "").replace(/[^a-z0-9.-]+/gi, "_")}.json`;
}

/** Hourly reads cover at most a day, so a span is read a day at a time. */
export function hourlyWindows(sinceMs: number, untilMs: number) {
  const windows: { readonly sinceMs: number; readonly untilMs: number }[] = [];
  for (let start = sinceMs; start < untilMs; start += 24 * HOUR_MS) {
    windows.push({ sinceMs: start, untilMs: Math.min(start + 24 * HOUR_MS, untilMs) });
  }
  return windows;
}

const isoAt = (timestampMs: number) => DateTime.formatIso(DateTime.makeUnsafe(timestampMs));

export function floorToHour(timestampMs: number): number {
  return Math.floor(timestampMs / HOUR_MS) * HOUR_MS;
}

/**
 * Folds a machine's newly read hourly summaries into what is kept for it. Read hours replace the
 * kept ones; a bucket without a source path takes its provider's only source, so the copy still
 * tells sources apart next to this server's own.
 */
export function mergeImportedUsage(
  previous: ImportedUsage | null,
  machineUrl: string,
  reads: readonly {
    readonly window: { sinceMs: number; untilMs: number };
    summary: UsageSummary;
  }[],
  readAt: string,
  capturedUntilMs: number,
): ImportedUsage {
  const last = reads.at(-1)?.summary;
  const sources = last?.sources ?? previous?.sources ?? [];
  const read = (timestampMs: number) =>
    reads.some(({ window }) => timestampMs >= window.sinceMs && timestampMs < window.untilMs);
  const kept = (previous?.buckets ?? []).filter((bucket) => !read(hourStartMs(bucket)));
  const fresh = reads.flatMap(({ summary }) =>
    summary.buckets.flatMap((bucket) => {
      if (bucket.hourStart === undefined) return [];
      if (bucket.sourcePath !== undefined) return [bucket];
      const owners = summary.sources.filter(
        (source) => source.fingerprint.provider === bucket.provider,
      );
      return owners.length === 1
        ? [{ ...bucket, sourcePath: owners[0]!.fingerprint.resolvedHomePath }]
        : [bucket];
    }),
  );
  return {
    machineUrl,
    readAt,
    capturedUntil: isoAt(capturedUntilMs),
    sources: sources.map(({ refreshing: _refreshing, ...source }) => source),
    buckets: [...kept, ...fresh].sort((a, b) => hourStartMs(a) - hourStartMs(b)),
  };
}

function hourStartMs(bucket: UsageBucket): number {
  return Date.parse(bucket.hourStart ?? "") || 0;
}

/** The kept usage that falls in a client's window, grouped the way it asked. */
export function importedUsageForWindow(
  imports: readonly ImportedUsage[],
  input: UsageSummaryInput,
): Pick<UsageSummary, "buckets" | "sources"> {
  const toDay = makeDayFormatter(input.timeZone);
  const hourly = input.resolution === "hour";
  const sinceTimeMs = Date.parse(input.sinceTime ?? "");
  const untilTimeMs = Date.parse(input.untilTime ?? "");
  const buckets: UsageBucket[] = [];
  const sources: UsageSource[] = [];
  for (const imported of imports) {
    const grouped = new Map<string, UsageBucket>();
    for (const bucket of imported.buckets) {
      const startMs = hourStartMs(bucket);
      const day = toDay(startMs) as UsageDay;
      if (hourly) {
        if (!(startMs >= sinceTimeMs && startMs < untilTimeMs)) continue;
      } else if (day < input.sinceDay || day > input.untilDay) {
        continue;
      }
      // An hourly read keeps each hour on the client's grid, which starts at its sinceTime.
      const hourStart = hourly
        ? isoAt(sinceTimeMs + floorToHour(startMs - sinceTimeMs))
        : undefined;
      const key = [day, hourStart ?? "", bucket.provider, bucket.model, bucket.sourcePath ?? ""];
      const { hourStart: _kept, ...rest } = bucket;
      const regrouped: UsageBucket = {
        ...rest,
        day,
        ...(hourStart === undefined ? {} : { hourStart }),
      };
      const existing = grouped.get(key.join("\u0000"));
      grouped.set(key.join("\u0000"), existing ? addBuckets(existing, regrouped) : regrouped);
    }
    const windowBuckets = [...grouped.values()];
    buckets.push(...windowBuckets);
    for (const source of imported.sources) {
      const sessions = windowBuckets
        .filter(
          (bucket) =>
            bucket.provider === source.fingerprint.provider &&
            bucket.sourcePath === source.fingerprint.resolvedHomePath,
        )
        .reduce((total, bucket) => total + bucket.sessions, 0);
      sources.push({ ...source, distinctSessions: sessions, readAt: imported.readAt });
    }
  }
  return { buckets, sources };
}

function addBuckets(a: UsageBucket, b: UsageBucket): UsageBucket {
  const records = a.records + b.records;
  const unpricedRecords = a.unpricedRecords + b.unpricedRecords;
  const category =
    a.categoryCostUsd && b.categoryCostUsd
      ? {
          input: a.categoryCostUsd.input + b.categoryCostUsd.input,
          cacheRead: a.categoryCostUsd.cacheRead + b.categoryCostUsd.cacheRead,
          cacheWrite: a.categoryCostUsd.cacheWrite + b.categoryCostUsd.cacheWrite,
          output: a.categoryCostUsd.output + b.categoryCostUsd.output,
        }
      : undefined;
  const optionalSum = (key: "fastCostUsd" | "ultrafastCostUsd" | "speedPremiumUsd") => {
    const sum = (a[key] ?? 0) + (b[key] ?? 0);
    return sum === 0 ? {} : { [key]: sum };
  };
  const { categoryCostUsd: _category, ...base } = a;
  return {
    ...base,
    ...(category === undefined ? {} : { categoryCostUsd: category }),
    totals: {
      uncachedInputTokens: a.totals.uncachedInputTokens + b.totals.uncachedInputTokens,
      cachedInputTokens: a.totals.cachedInputTokens + b.totals.cachedInputTokens,
      cacheCreationTokens: a.totals.cacheCreationTokens + b.totals.cacheCreationTokens,
      outputTokens: a.totals.outputTokens + b.totals.outputTokens,
      reasoningTokens: a.totals.reasoningTokens + b.totals.reasoningTokens,
    },
    costUsd: a.costUsd + b.costUsd,
    cacheSavingsUsd: a.cacheSavingsUsd + b.cacheSavingsUsd,
    ...optionalSum("fastCostUsd"),
    ...optionalSum("ultrafastCostUsd"),
    ...optionalSum("speedPremiumUsd"),
    costSource:
      unpricedRecords === records
        ? "unpriced"
        : a.costSource === "providerReported" && b.costSource === "providerReported"
          ? "providerReported"
          : "modelPriced",
    records,
    unpricedRecords,
    sessions: a.sessions + b.sessions,
  };
}

/** Every machine's kept usage under this server's state directory; unreadable files are skipped. */
export const readImportedUsage = Effect.fn("importedUsage.read")(function* (stateDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(stateDir, IMPORTED_USAGE_DIRECTORY);
  const names = yield* fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
  const files = yield* Effect.forEach(names, (name) =>
    name.endsWith(".json")
      ? fileSystem.readFileString(path.join(directory, name)).pipe(
          Effect.map((text) => Option.getOrUndefined(decodeImportedUsage(text))),
          Effect.orElseSucceed(() => undefined),
        )
      : Effect.succeed(undefined),
  );
  return files.filter((file) => file !== undefined);
});

/**
 * Adds kept usage to this server's own summary. Its own buckets without a source path take their
 * provider's only source first, so they stay attributed once kept sources share the provider.
 */
export function withImportedUsage(
  summary: UsageSummary,
  imported: Pick<UsageSummary, "buckets" | "sources">,
): UsageSummary {
  if (imported.sources.length === 0) return summary;
  const own = summary.buckets.map((bucket) => {
    if (bucket.sourcePath !== undefined) return bucket;
    const owners = summary.sources.filter(
      (source) => source.fingerprint.provider === bucket.provider,
    );
    return owners.length === 1
      ? { ...bucket, sourcePath: owners[0]!.fingerprint.resolvedHomePath }
      : bucket;
  });
  return {
    ...summary,
    buckets: [...own, ...imported.buckets],
    sources: [...summary.sources, ...imported.sources],
  };
}
