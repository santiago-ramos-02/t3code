import { describe, expect, it } from "vite-plus/test";

import { openAiCacheTtlSeconds, piCallCacheTtlSeconds } from "./promptCacheLifetime.ts";

describe("openAiCacheTtlSeconds", () => {
  it("gives GPT-5.6 and later their fixed 30 minutes", () => {
    expect(openAiCacheTtlSeconds("gpt-6-luna")).toBe(1_800);
    expect(openAiCacheTtlSeconds("gpt-6.1-sol")).toBe(1_800);
    expect(openAiCacheTtlSeconds("openai/gpt-5.6")).toBe(1_800);
  });

  it("says nothing for earlier models, whose lifetime varies", () => {
    expect(openAiCacheTtlSeconds("gpt-5.5")).toBeUndefined();
    expect(openAiCacheTtlSeconds("gpt-5")).toBeUndefined();
    expect(openAiCacheTtlSeconds("o4-mini")).toBeUndefined();
  });
});

describe("piCallCacheTtlSeconds", () => {
  const anthropic = { provider: "anthropic", model: "claude-opus-5-5" };
  const bridge = { provider: "claude-bridge", model: "claude-opus-5-5" };

  it("reads Claude's lifetime from where the call wrote its cache", () => {
    expect(piCallCacheTtlSeconds({ cacheWrite: 900, cacheWrite1h: 900 }, anthropic, 300)).toBe(
      3_600,
    );
    expect(piCallCacheTtlSeconds({ cacheWrite: 900, cacheWrite1h: 0 }, anthropic, 3_600)).toBe(300);
    // A call that wrote nothing leaves the lifetime an earlier write set.
    expect(
      piCallCacheTtlSeconds({ cacheWrite: 0, cacheWrite1h: 0 }, anthropic, 3_600),
    ).toBeUndefined();
  });

  it("gives claude-bridge calls the lifetime Claude Code reports", () => {
    expect(piCallCacheTtlSeconds({ cacheWrite: 900, cacheWrite1h: undefined }, bridge, 3_600)).toBe(
      3_600,
    );
    expect(piCallCacheTtlSeconds({ cacheWrite: 0, cacheWrite1h: undefined }, bridge, 300)).toBe(
      300,
    );
    expect(
      piCallCacheTtlSeconds({ cacheWrite: 900, cacheWrite1h: undefined }, bridge, undefined),
    ).toBeUndefined();
  });

  it("falls back to OpenAI's fixed lifetime, and says nothing when no one reports one", () => {
    expect(
      piCallCacheTtlSeconds(
        { cacheWrite: 0, cacheWrite1h: undefined },
        { provider: "openai-codex", model: "gpt-6-luna" },
        3_600,
      ),
    ).toBe(1_800);
    // Only claude-bridge runs Claude Code, so another provider's Claude call stays unknown.
    expect(
      piCallCacheTtlSeconds({ cacheWrite: 900, cacheWrite1h: undefined }, anthropic, 3_600),
    ).toBeUndefined();
  });
});
