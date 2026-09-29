import { describe, expect, it } from "vite-plus/test";

import {
  cliProxyAccountState,
  cliProxyCredentials,
  cliProxyGroups,
  cliProxyModels,
  cliProxyPools,
  cliProxyRetryAt,
  cliProxyUsageWindows,
  cliProxyWithPools,
} from "./cliProxy.ts";

describe("CLIProxyAPI accounts", () => {
  it("reads usage windows from Claude's and Codex's limit headers", () => {
    expect(
      cliProxyUsageWindows({
        quota: {
          signals: {
            "Anthropic-Ratelimit-Unified-5h-Utilization": "0.15",
            "Anthropic-Ratelimit-Unified-5h-Reset": "1790659200",
            "Anthropic-Ratelimit-Unified-7d-Utilization": "0.21",
          },
        },
      }),
    ).toEqual([
      { label: "5-hour", usedPercent: 15, resetsAt: 1790659200000 },
      { label: "Weekly", usedPercent: 21, resetsAt: null },
    ]);
    expect(
      cliProxyUsageWindows({
        quota: {
          signals: {
            "X-Codex-Primary-Used-Percent": "100",
            "X-Codex-Primary-Reset-At": "1791047049",
          },
        },
      }),
    ).toEqual([{ label: "Primary", usedPercent: 100, resetsAt: 1791047049000 }]);
    expect(cliProxyUsageWindows({})).toEqual([]);
  });

  it("tells a limited account from a disabled or active one, and when it returns", () => {
    const [disabled, limited, active] = cliProxyCredentials({
      files: [
        { id: "a", name: "a", provider: "claude", disabled: true },
        {
          id: "b",
          name: "b",
          provider: "codex",
          unavailable: true,
          next_retry_after: "2026-10-03T17:04:09Z",
          cooldowns: [{ retry_at: "2026-10-03T12:00:00Z" }],
        },
        { id: "c", name: "c", provider: "claude", status: "active" },
      ],
    });
    expect([disabled, limited, active].map((c) => c && cliProxyAccountState(c))).toEqual([
      "disabled",
      "limited",
      "active",
    ]);
    expect(limited && cliProxyRetryAt(limited)).toBe(Date.parse("2026-10-03T12:00:00Z"));
    expect(cliProxyCredentials("nope")).toEqual([]);
  });
});

describe("CLIProxyAPI models", () => {
  it("lists models by name", () => {
    expect(
      cliProxyModels({
        data: [
          { id: "claude-fable-5-dd-anul-6-tpg", display_name: "GPT 6.0 Luna" },
          { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
        ],
      }).map((model) => model.label),
    ).toEqual(["Claude Opus 5.5", "GPT 6.0 Luna"]);
  });
});

describe("failover pools", () => {
  const config = {
    "api-keys": {
      "openai-compatibility": [
        {
          name: "openrouter",
          "base-url": "https://openrouter.ai/api/v1",
          models: [{ name: "kimi" }],
        },
        {
          name: "luna-then-muse-2",
          priority: 1,
          "base-url": "http://127.0.0.1:8317/v1",
          models: [{ name: "muse-spark-1.3", alias: "luna-then-muse" }],
        },
        {
          name: "luna-then-muse-1",
          priority: 10,
          "base-url": "http://127.0.0.1:8317/v1",
          models: [
            { name: "gpt-6-luna", alias: "luna-then-muse", "display-name": "Luna, else Muse" },
          ],
        },
      ],
    },
  };

  it("reads pools from the groups that call the proxy itself, first choice first", () => {
    expect(cliProxyPools(cliProxyGroups(config))).toEqual([
      {
        alias: "luna-then-muse",
        label: "Luna, else Muse",
        members: ["gpt-6-luna", "muse-spark-1.3"],
      },
    ]);
  });

  it("writes pools back as prioritized groups and keeps outside providers", () => {
    const groups = cliProxyWithPools(
      cliProxyGroups(config),
      [{ alias: "smart", label: "Sonnet, else Luna", members: ["claude-sonnet-5", "gpt-6-luna"] }],
      { proxyUrl: "http://127.0.0.1:8317", clientKey: "sk-x" },
    );
    expect(groups.map((group) => [group.name, group.priority])).toEqual([
      ["openrouter", undefined],
      ["pool-smart-1", 2],
      ["pool-smart-2", 1],
    ]);
    expect(cliProxyPools({ "openai-compatibility": groups })).toEqual([
      { alias: "smart", label: "Sonnet, else Luna", members: ["claude-sonnet-5", "gpt-6-luna"] },
    ]);
  });
});
