import { assert, describe, it } from "@effect/vitest";

import { piProviderLimitsToUpdate } from "./piGentleUsageLimits.ts";

const CHECKED_AT = Date.parse("2026-11-01T12:00:00.000Z");
const RESET = Date.parse("2026-11-01T15:00:00.000Z") / 1000;

describe("piProviderLimitsToUpdate", () => {
  it("reads Claude's unified headers as session and weekly rows labelled by provider", () => {
    assert.deepStrictEqual(
      piProviderLimitsToUpdate({
        provider: "anthropic",
        checkedAt: CHECKED_AT,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": "0.42",
          "anthropic-ratelimit-unified-5h-reset": String(RESET),
          "anthropic-ratelimit-unified-7d-utilization": "0.9",
          "anthropic-ratelimit-unified-7d-status": "allowed_warning",
          "anthropic-ratelimit-unified-overage-utilization": "0.1",
        },
      }),
      {
        checkedAt: "2026-11-01T12:00:00.000Z",
        windows: [
          {
            id: "anthropic:five_hour",
            kind: "session",
            label: "Session · Claude",
            windowDurationMins: 300,
            usedPercent: 42,
            resetsAt: "2026-11-01T15:00:00.000Z",
          },
          {
            id: "anthropic:seven_day",
            kind: "weekly",
            label: "Weekly · Claude",
            windowDurationMins: 10_080,
            usedPercent: 90,
          },
        ],
      },
    );
  });

  it("reads Codex's primary and secondary headers, including a relative reset", () => {
    assert.deepStrictEqual(
      piProviderLimitsToUpdate({
        provider: "codex",
        checkedAt: CHECKED_AT,
        headers: {
          "x-codex-primary-used-percent": "12.5",
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-after-seconds": "10800",
          "x-codex-secondary-used-percent": "64",
          "x-codex-secondary-window-minutes": "10080",
          "x-codex-secondary-reset-at": String(RESET),
        },
      })?.windows,
      [
        {
          id: "codex:primary",
          kind: "session",
          label: "Session · Codex",
          usedPercent: 12.5,
          windowDurationMins: 300,
          resetsAt: "2026-11-01T15:00:00.000Z",
        },
        {
          id: "codex:secondary",
          kind: "weekly",
          label: "Weekly · Codex",
          usedPercent: 64,
          windowDurationMins: 10_080,
          resetsAt: "2026-11-01T15:00:00.000Z",
        },
      ],
    );
  });

  it("ignores a provider it does not know and headers without a usable window", () => {
    const headers = { "x-codex-primary-used-percent": "10" };
    assert.strictEqual(
      piProviderLimitsToUpdate({ provider: "google", checkedAt: CHECKED_AT, headers }),
      undefined,
    );
    assert.strictEqual(
      piProviderLimitsToUpdate({
        provider: "anthropic",
        checkedAt: CHECKED_AT,
        headers: { "anthropic-ratelimit-unified-status": "allowed" },
      }),
      undefined,
    );
    assert.strictEqual(
      piProviderLimitsToUpdate({
        provider: "codex",
        checkedAt: CHECKED_AT,
        headers: { "x-codex-primary-used-percent": "n/a" },
      }),
      undefined,
    );
  });
});
