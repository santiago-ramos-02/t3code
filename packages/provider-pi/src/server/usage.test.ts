// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";

import {
  initialPiScanState,
  parsePiLine,
  piSourceDiagnostic,
  resolvePiSessionsRoot,
} from "./usage.ts";

describe("parsePiLine", () => {
  const usage = (overrides: Record<string, unknown> = {}) => {
    const input = typeof overrides.input === "number" ? overrides.input : 20;
    const output = typeof overrides.output === "number" ? overrides.output : 10;
    const cacheRead = typeof overrides.cacheRead === "number" ? overrides.cacheRead : 6;
    const cacheWrite = typeof overrides.cacheWrite === "number" ? overrides.cacheWrite : 4;
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning: 3,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
      ...overrides,
    };
  };
  const base = (type: string, id: string, timestamp = "2026-08-01T10:00:00Z") => ({
    type,
    id,
    parentId: null,
    timestamp,
  });

  it("reads ordinary assistant usage with full model identity and authoritative fields", () => {
    const state = initialPiScanState();
    expect(
      parsePiLine(
        JSON.stringify({
          type: "session",
          version: 3,
          id: "pi-session",
          timestamp: "2026-08-01T09:59:00Z",
          cwd: "/private/workspace",
          parentSession: "/private/parent.jsonl",
        }),
        state,
      ),
    ).toBeNull();

    const record = parsePiLine(
      JSON.stringify({
        ...base("message", "assistant-1"),
        message: {
          role: "assistant",
          provider: "openrouter",
          model: "meta/llama-4",
          content: [{ type: "text", text: "private prompt response" }],
          usage: usage(),
          tools: [{ path: "/private/tool" }],
        },
        extensionData: { sessionFile: "/private/session.jsonl" },
      }),
      state,
    );

    expect(record).toMatchObject({
      provider: "pi",
      sessionId: "pi-session",
      model: "openrouter/meta/llama-4",
      totals: {
        uncachedInputTokens: 20,
        cachedInputTokens: 6,
        cacheCreationTokens: 4,
        outputTokens: 10,
        reasoningTokens: 3,
      },
      reportedCostUsd: 0.37,
      speed: "standard",
    });
    expect(Object.keys(record ?? {}).toSorted()).toEqual([
      "dedupeKey",
      "model",
      "provider",
      "reportedCostUsd",
      "sessionId",
      "speed",
      "timestampMs",
      "totals",
    ]);
  });

  it("keeps standalone, compaction, and branch usage as distinct calls", () => {
    const state = initialPiScanState();
    parsePiLine(
      JSON.stringify({
        ...base("model_change", "model-1"),
        provider: "anthropic",
        modelId: "opus",
      }),
      state,
    );
    const standalone = parsePiLine(
      JSON.stringify({
        ...base("usage", "warm-1", "2026-08-01T10:00:01Z"),
        kind: "cache_warm",
        provider: "openai",
        model: "gpt-5",
        usage: usage({ output: 1, reasoning: 0 }),
      }),
      state,
    );
    const compaction = parsePiLine(
      JSON.stringify({
        ...base("compaction", "compact-1", "2026-08-01T10:00:02Z"),
        summary: "private summary",
        details: { sessionFile: "/private/compact.jsonl" },
        usage: usage({ output: 2, reasoning: 1 }),
      }),
      state,
    );
    const branch = parsePiLine(
      JSON.stringify({
        ...base("branch_summary", "branch-1", "2026-08-01T10:00:03Z"),
        summary: "private branch",
        usage: usage({ output: 3, reasoning: 2 }),
      }),
      state,
    );

    expect([standalone, compaction, branch].map((record) => record?.model)).toEqual([
      "openai/gpt-5",
      "anthropic/opus",
      "anthropic/opus",
    ]);
    expect(new Set([standalone?.dedupeKey, compaction?.dedupeKey, branch?.dedupeKey]).size).toBe(3);
  });

  it("uses an honest stable unknown model for summaries before model state exists", () => {
    const record = parsePiLine(
      JSON.stringify({ ...base("compaction", "compact-unknown"), usage: usage() }),
      initialPiScanState(),
    );

    expect(record?.model).toBe("unknown/unknown");
  });

  it("rejects malformed, negative, non-finite, and inconsistent usage", () => {
    for (const line of [
      "not json",
      '{"type":"usage","id":"infinite","parentId":null,"timestamp":"2026-08-01T10:00:00Z","kind":"cache_warm","provider":"openai","model":"gpt-5","usage":{"input":1e999,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}',
      JSON.stringify({ ...base("message", "missing"), message: { role: "assistant" } }),
      JSON.stringify({
        ...base("usage", "negative"),
        kind: "cache_warm",
        provider: "openai",
        model: "gpt-5",
        usage: usage({ input: -1 }),
      }),
      JSON.stringify({
        ...base("usage", "fractional"),
        kind: "cache_warm",
        provider: "openai",
        model: "gpt-5",
        usage: usage({ cacheRead: 1.5 }),
      }),
      JSON.stringify({
        ...base("usage", "reasoning-over-output"),
        kind: "cache_warm",
        provider: "openai",
        model: "gpt-5",
        usage: usage({ output: 2, reasoning: 3, totalTokens: 32 }),
      }),
      JSON.stringify({
        ...base("usage", "inconsistent-total"),
        kind: "cache_warm",
        provider: "openai",
        model: "gpt-5",
        usage: usage({ totalTokens: 41 }),
      }),
    ]) {
      expect(parsePiLine(line, initialPiScanState())).toBeNull();
    }
  });

  it("dedupes fork copies without collapsing independent same-id calls", () => {
    const copiedEntry = {
      ...base("usage", "same-entry"),
      kind: "cache_warm",
      provider: "openai",
      model: "gpt-5",
      usage: usage(),
    };
    const parent = parsePiLine(JSON.stringify(copiedEntry), initialPiScanState());
    const forkCopy = parsePiLine(JSON.stringify(copiedEntry), initialPiScanState());
    const independent = parsePiLine(
      JSON.stringify({ ...copiedEntry, timestamp: "2026-08-01T10:00:01Z" }),
      initialPiScanState(),
    );

    expect(parent?.dedupeKey).toBe(forkCopy?.dedupeKey);
    expect(independent?.dedupeKey).not.toBe(parent?.dedupeKey);
  });
});

describe("Pi sessions root", () => {
  it("resolves Pi roots with absolute and tilde environment/global precedence", () => {
    const pathOps = {
      sep: NodePath.sep,
      isAbsolute: NodePath.isAbsolute,
      join: NodePath.join,
      resolve: NodePath.resolve,
    };
    assert.deepStrictEqual(resolvePiSessionsRoot({}, undefined, "/home/test", pathOps), {
      directory: NodePath.resolve("/home/test/.pi/agent/sessions"),
      ignoredRelativePaths: [],
    });
    assert.deepStrictEqual(
      resolvePiSessionsRoot(
        { PI_CODING_AGENT_DIR: "/custom/agent" },
        "/global/sessions",
        "/home/test",
        pathOps,
      ),
      {
        directory: NodePath.resolve("/global/sessions"),
        ignoredRelativePaths: [],
      },
    );
    assert.deepStrictEqual(
      resolvePiSessionsRoot(
        {
          PI_CODING_AGENT_DIR: "/ignored/agent",
          PI_CODING_AGENT_SESSION_DIR: "/environment/sessions",
        },
        "/ignored/global-sessions",
        "/home/test",
        pathOps,
      ),
      {
        directory: NodePath.resolve("/environment/sessions"),
        ignoredRelativePaths: [],
      },
    );
    assert.deepStrictEqual(
      resolvePiSessionsRoot(
        { PI_CODING_AGENT_SESSION_DIR: "~/environment-sessions" },
        "/ignored/global-sessions",
        "/home/test",
        pathOps,
      ),
      {
        directory: NodePath.resolve("/home/test/environment-sessions"),
        ignoredRelativePaths: [],
      },
    );
    assert.deepStrictEqual(resolvePiSessionsRoot({}, "~/pi-sessions", "/home/test", pathOps), {
      directory: NodePath.resolve("/home/test/pi-sessions"),
      ignoredRelativePaths: [],
    });
    assert.deepStrictEqual(
      resolvePiSessionsRoot(
        { PI_CODING_AGENT_DIR: "~/custom-agent" },
        undefined,
        "/home/test",
        pathOps,
      ),
      {
        directory: NodePath.resolve("/home/test/custom-agent/sessions"),
        ignoredRelativePaths: [],
      },
    );
    assert.deepStrictEqual(
      resolvePiSessionsRoot(
        { PI_CODING_AGENT_DIR: "/custom/agent" },
        "relative-sessions",
        "/home/test",
        pathOps,
      ),
      {
        directory: NodePath.resolve("/custom/agent/sessions"),
        ignoredRelativePaths: ["settings.json sessionDir"],
      },
    );
  });

  it("never resolves relative Pi environment paths against the server cwd", () => {
    const serverCwd = "/server-cwd-that-is-not-a-thread-cwd";
    const pathOps = {
      sep: NodePath.sep,
      isAbsolute: NodePath.isAbsolute,
      join: NodePath.join,
      resolve: (...parts: ReadonlyArray<string>) => NodePath.resolve(serverCwd, ...parts),
    };

    assert.deepStrictEqual(
      resolvePiSessionsRoot(
        {
          PI_CODING_AGENT_SESSION_DIR: "thread-relative-sessions",
          PI_CODING_AGENT_DIR: "/absolute/agent",
        },
        "/absolute/global-sessions",
        "/home/test",
        pathOps,
      ),
      {
        directory: NodePath.resolve("/absolute/global-sessions"),
        ignoredRelativePaths: ["PI_CODING_AGENT_SESSION_DIR"],
      },
    );
    assert.deepStrictEqual(
      resolvePiSessionsRoot(
        {
          PI_CODING_AGENT_SESSION_DIR: "thread-relative-sessions",
          PI_CODING_AGENT_DIR: "/absolute/agent",
        },
        undefined,
        "/home/test",
        pathOps,
      ),
      {
        directory: NodePath.resolve("/absolute/agent/sessions"),
        ignoredRelativePaths: ["PI_CODING_AGENT_SESSION_DIR"],
      },
    );
    const relativeAgent = resolvePiSessionsRoot(
      { PI_CODING_AGENT_DIR: "thread-relative-agent" },
      "/unusable-global-settings-because-agent-location-is-relative",
      "/home/test",
      pathOps,
    );
    assert.deepStrictEqual(relativeAgent, {
      directory: NodePath.resolve("/home/test/.pi/agent/sessions"),
      ignoredRelativePaths: ["PI_CODING_AGENT_DIR"],
    });
    const diagnostic = piSourceDiagnostic(false, relativeAgent.ignoredRelativePaths);
    assert.include(diagnostic, "PI_CODING_AGENT_DIR");
    assert.include(diagnostic, "each invocation cwd");
    assert.notInclude(diagnostic, serverCwd);
  });
});
