import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderUsageLimitsUpdate, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { claudeRateLimitEventToUpdate } from "./claudeUsageLimits.ts";
import { codexRateLimitsToUpdate } from "./codexUsageLimits.ts";

/** One provider response's subscription rate-limit headers, as gentle-pi reports them. */
export interface PiProviderLimits {
  readonly provider: string;
  /** Epoch milliseconds. */
  readonly checkedAt: number;
  readonly headers: Readonly<Record<string, string>>;
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Claude",
  codex: "Codex",
};

// The SDK's rate_limit_event is built from these same headers, one event per window.
const CLAUDE_WINDOWS = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
] as const;
const CLAUDE_STATUSES: ReadonlyArray<SDKRateLimitInfo["status"]> = [
  "allowed",
  "allowed_warning",
  "rejected",
];

function headerNumber(headers: PiProviderLimits["headers"], name: string): number | undefined {
  const value = headers[name];
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function claudeWindows(headers: PiProviderLimits["headers"]): ServerProviderUsageWindow[] {
  return CLAUDE_WINDOWS.flatMap(([rateLimitType, header]) => {
    const prefix = `anthropic-ratelimit-unified-${header}`;
    const utilization = headerNumber(headers, `${prefix}-utilization`);
    if (utilization === undefined) return [];
    const resetsAt = headerNumber(headers, `${prefix}-reset`);
    const status =
      CLAUDE_STATUSES.find((candidate) => candidate === headers[`${prefix}-status`]) ?? "allowed";
    const update = claudeRateLimitEventToUpdate(
      { status, rateLimitType, utilization, ...(resetsAt === undefined ? {} : { resetsAt }) },
      { overageIncluded: undefined },
    );
    return update?.windows ?? [];
  });
}

function codexWindows(limits: PiProviderLimits): ReadonlyArray<ServerProviderUsageWindow> {
  const window = (position: "primary" | "secondary") => {
    const header = (name: string) => headerNumber(limits.headers, `x-codex-${position}-${name}`);
    const usedPercent = header("used-percent");
    if (usedPercent === undefined) return null;
    const resetAfterSeconds = header("reset-after-seconds");
    const resetsAt =
      header("reset-at") ??
      (resetAfterSeconds === undefined
        ? null
        : Math.round(limits.checkedAt / 1000 + resetAfterSeconds));
    return { usedPercent, resetsAt, windowDurationMins: header("window-minutes") ?? null };
  };
  const update = codexRateLimitsToUpdate({
    limitId: "codex",
    primary: window("primary"),
    secondary: window("secondary"),
  });
  return update?.windows ?? [];
}

/**
 * The Pi instance's limit rows for one provider gentle-pi used. Pi can run on several providers at
 * once, so each row is keyed and labelled by its provider ("Weekly · Codex").
 */
export function piProviderLimitsToUpdate(
  limits: PiProviderLimits,
): (ProviderUsageLimitsUpdate & { readonly checkedAt: string }) | undefined {
  const label = PROVIDER_LABELS[limits.provider];
  if (label === undefined) return undefined;
  const windows =
    limits.provider === "anthropic" ? claudeWindows(limits.headers) : codexWindows(limits);
  if (windows.length === 0) return undefined;
  return {
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(limits.checkedAt)),
    windows: windows.map((window) => ({
      ...window,
      id: `${limits.provider}:${window.id}`,
      label: `${window.label} · ${label}`,
    })),
  };
}
