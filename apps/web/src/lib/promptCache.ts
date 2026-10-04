import type { OrchestrationV2ProviderTurn, ProviderThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { formatContextWindowTokens } from "./contextWindow";

export type PromptCacheTurn = Pick<
  OrchestrationV2ProviderTurn,
  | "providerThreadId"
  | "ordinal"
  | "status"
  | "startedAt"
  | "completedAt"
  | "tokenUsage"
  | "turnTokenUsage"
>;

/** What decides whether the next message reuses the active provider session's prompt cache. */
export interface PromptCacheSnapshot {
  /** How long the provider keeps the cache after a request, when it says. */
  readonly ttlSeconds: number | null;
  /** When a request last used the cache, in epoch milliseconds. */
  readonly lastUsedAt: number;
  /** A turn is running, so its requests keep the cache warm. */
  readonly working: boolean;
}

/** When a turn's requests last used the cache: its latest usage report, else when it ended. */
function lastUsedAt(turn: PromptCacheTurn) {
  const reported =
    turn.tokenUsage === undefined ? Number.NaN : Date.parse(turn.tokenUsage.updatedAt);
  if (!Number.isNaN(reported)) return reported;
  const ended = turn.completedAt ?? turn.startedAt;
  return ended === null ? null : DateTime.toEpochMillis(ended);
}

/**
 * Whether the active provider session's prompt cache is still there for the next message, read
 * from when its requests last used it and how long the provider keeps it. Null when the provider
 * reports no cache use.
 */
export function derivePromptCache(input: {
  readonly providerTurns: ReadonlyArray<PromptCacheTurn>;
  readonly providerThreadId: ProviderThreadId | null;
}): PromptCacheSnapshot | null {
  // The cache belongs to one provider session.
  const turns = input.providerTurns
    .filter((turn) => turn.providerThreadId === input.providerThreadId)
    .toSorted((left, right) => left.ordinal - right.ordinal);
  const reportsCache = turns.some(
    (turn) =>
      turn.turnTokenUsage?.cachedInputTokens !== undefined &&
      (turn.turnTokenUsage.inputTokens ?? 0) > 0,
  );
  const latest = turns.at(-1);
  if (!reportsCache || latest === undefined) return null;
  const latestUsedAt = lastUsedAt(latest);
  if (latestUsedAt === null) return null;
  return {
    ttlSeconds:
      turns.findLast((turn) => turn.tokenUsage?.cacheTtlSeconds !== undefined)?.tokenUsage
        ?.cacheTtlSeconds ?? null,
    lastUsedAt: latestUsedAt,
    working: latest.status === "running" || latest.status === "pending",
  };
}

export type PromptCacheState =
  | { readonly kind: "working" }
  | { readonly kind: "expiresIn"; readonly seconds: number }
  | { readonly kind: "expired"; readonly secondsAgo: number }
  | { readonly kind: "unknown"; readonly idleSeconds: number };

/** Whether the cache is still there at `nowMs`, and for how long. */
export function promptCacheState(cache: PromptCacheSnapshot, nowMs: number): PromptCacheState {
  if (cache.working) return { kind: "working" };
  if (cache.ttlSeconds === null) {
    return {
      kind: "unknown",
      idleSeconds: Math.max(0, Math.floor((nowMs - cache.lastUsedAt) / 1000)),
    };
  }
  const left = Math.ceil((cache.lastUsedAt + cache.ttlSeconds * 1000 - nowMs) / 1000);
  return left > 0 ? { kind: "expiresIn", seconds: left } : { kind: "expired", secondsAgo: -left };
}

// The last minute is when to send a message.
const SOON_SECONDS = 60;
// From here on the readout counts minutes and seconds.
const CLOSE_SECONDS = 300;
// A context this large is worth compacting before its cache is rebuilt.
const COMPACT_AT_TOKENS = 100_000;

export type PromptCacheTone = "good" | "warning" | "critical" | "neutral";

/**
 * How much life the cache has left, as a colour reads it: good, warning once less than 40% is
 * left, critical in its last minute and once expired, neutral when the provider does not say.
 */
export function promptCacheTone(
  cache: PromptCacheSnapshot,
  state: PromptCacheState,
): PromptCacheTone {
  switch (state.kind) {
    case "working":
      return "good";
    case "expired":
      return "critical";
    case "expiresIn":
      if (state.seconds <= SOON_SECONDS) return "critical";
      return cache.ttlSeconds !== null && state.seconds / cache.ttlSeconds <= 0.4
        ? "warning"
        : "good";
    case "unknown":
      return "neutral";
  }
}

/** The share of the cache's life still left, from 0 to 1, or null when it has no known end. */
export function promptCacheLifeLeft(cache: PromptCacheSnapshot, state: PromptCacheState) {
  if (cache.ttlSeconds === null) return null;
  switch (state.kind) {
    case "working":
      return 1;
    case "expiresIn":
      return Math.min(1, state.seconds / cache.ttlSeconds);
    case "expired":
      return 0;
    case "unknown":
      return null;
  }
}

/** Whether the cache has expired on a context large enough to compact before rebuilding it. */
export function promptCacheSuggestsCompact(state: PromptCacheState, contextTokens: number | null) {
  return state.kind === "expired" && contextTokens !== null && contextTokens >= COMPACT_AT_TOKENS;
}

/**
 * What the next message gets from the cache, in a few words: it reuses the context, should be
 * sent soon to, or rebuilds it.
 */
export function promptCacheNextMessage(state: PromptCacheState, contextTokens: number | null) {
  const tokens =
    contextTokens === null ? null : `${formatContextWindowTokens(contextTokens)} tokens`;
  switch (state.kind) {
    case "working":
      return "Kept warm while the agent works";
    case "expiresIn":
      if (state.seconds <= SOON_SECONDS) {
        return tokens === null ? "Send now to reuse the cache" : `Send now to reuse ${tokens}`;
      }
      return tokens === null ? "Next message reuses the cache" : `Next message reuses ${tokens}`;
    case "expired":
      if (promptCacheSuggestsCompact(state, contextTokens)) {
        return `Next message rebuilds ${tokens}: compact first`;
      }
      return tokens === null
        ? "Next message rebuilds the cache"
        : `Next message rebuilds ${tokens}`;
    case "unknown":
      return "This provider doesn't say how long it keeps the cache";
  }
}

/** A countdown such as `4:05`, or `1:00:00` from an hour up. */
export function formatPromptCacheCountdown(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** A length of time such as `12 min` or `2 h 5 min`, rounded to minutes past the first one. */
export function formatPromptCacheDuration(seconds: number) {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

/** A short span such as `45s`, `12m`, or `3h`, for the composer readout. */
function formatShortSpan(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/**
 * The composer readout's label: `43m`, then `4:12` in the last five minutes, `expired`, `warm`
 * while the agent works, or how long ago it was used when the provider gives no lifetime.
 */
export function promptCacheClockLabel(state: PromptCacheState) {
  switch (state.kind) {
    case "working":
      return "warm";
    case "expiresIn":
      return state.seconds <= CLOSE_SECONDS
        ? formatPromptCacheCountdown(state.seconds)
        : `${Math.ceil(state.seconds / 60)}m`;
    case "expired":
      return "expired";
    case "unknown":
      return `used ${formatShortSpan(state.idleSeconds)} ago`;
  }
}

/** Milliseconds until the label reads differently, or null when only new usage changes it. */
export function msUntilPromptCacheLabelChanges(state: PromptCacheState) {
  switch (state.kind) {
    case "working":
    case "expired":
      return null;
    case "expiresIn":
      if (state.seconds <= CLOSE_SECONDS) return 1000;
      return Math.min(((state.seconds - 1) % 60) + 1, state.seconds - CLOSE_SECONDS) * 1000;
    case "unknown":
      if (state.idleSeconds < 60) return 1000;
      if (state.idleSeconds < 3600) return (60 - (state.idleSeconds % 60)) * 1000;
      return (3600 - (state.idleSeconds % 3600)) * 1000;
  }
}
