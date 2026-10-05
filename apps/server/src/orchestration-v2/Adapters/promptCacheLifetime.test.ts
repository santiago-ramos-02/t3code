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
  it("reads Claude's lifetime from where the call wrote its cache", () => {
    expect(piCallCacheTtlSeconds({ cacheWrite: 900, cacheWrite1h: 900 }, "claude-opus-5-5")).toBe(
      3_600,
    );
    expect(piCallCacheTtlSeconds({ cacheWrite: 900, cacheWrite1h: 0 }, "claude-opus-5-5")).toBe(
      300,
    );
    // A call that wrote nothing leaves the lifetime an earlier write set.
    expect(
      piCallCacheTtlSeconds({ cacheWrite: 0, cacheWrite1h: 0 }, "claude-opus-5-5"),
    ).toBeUndefined();
  });

  it("falls back to OpenAI's fixed lifetime, and says nothing when no one reports one", () => {
    expect(piCallCacheTtlSeconds({ cacheWrite: 0, cacheWrite1h: undefined }, "gpt-6-luna")).toBe(
      1_800,
    );
    expect(
      piCallCacheTtlSeconds({ cacheWrite: 900, cacheWrite1h: undefined }, "claude-opus-5-5"),
    ).toBeUndefined();
  });
});
