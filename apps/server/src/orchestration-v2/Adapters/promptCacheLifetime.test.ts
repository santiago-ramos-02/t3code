import { describe, expect, it } from "vite-plus/test";

import { openAiCacheTtlSeconds, piCacheTtlSeconds } from "./promptCacheLifetime.ts";

describe("openAiCacheTtlSeconds", () => {
  it("gives GPT-5.6 and later their fixed 30 minutes", () => {
    expect(openAiCacheTtlSeconds("gpt-6-luna")).toBe(1_800);
    expect(openAiCacheTtlSeconds("gpt-6.1-sol")).toBe(1_800);
    expect(openAiCacheTtlSeconds("gpt-5.6")).toBe(1_800);
  });

  it("says nothing for earlier models, whose lifetime varies", () => {
    expect(openAiCacheTtlSeconds("gpt-5.5")).toBeUndefined();
    expect(openAiCacheTtlSeconds("gpt-5")).toBeUndefined();
    expect(openAiCacheTtlSeconds("o4-mini")).toBeUndefined();
  });
});

describe("piCacheTtlSeconds", () => {
  it("reads the lifetime from the provider and model Pi names", () => {
    expect(piCacheTtlSeconds("claude-bridge", "claude-opus-5-5")).toBe(3_600);
    expect(piCacheTtlSeconds("openai-codex", "gpt-6-luna")).toBe(1_800);
    expect(piCacheTtlSeconds("openrouter", "openai/gpt-6.1-sol")).toBe(1_800);
    expect(piCacheTtlSeconds("anthropic", "claude-sonnet-5-5")).toBeUndefined();
  });
});
