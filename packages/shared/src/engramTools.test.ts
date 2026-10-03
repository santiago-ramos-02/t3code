import { describe, expect, it } from "vite-plus/test";

import {
  compactEngramToolCall,
  engramToolCall,
  engramToolName,
  engramToolResult,
  engramToolTitle,
} from "./engramTools.ts";
import { dynamicToolTitle } from "./toolActivity.ts";

describe("engramToolName", () => {
  it("reads Engram's tools however a provider names them", () => {
    expect(
      [
        "mcp__engram__mem_save",
        "mcp__plugin_engram_engram__mem_search",
        "engram.mem_context",
        "engram/mem_get_observation",
        "mem_update",
      ].map(engramToolName),
    ).toEqual(["mem_save", "mem_search", "mem_context", "mem_get_observation", "mem_update"]);
  });

  it("leaves other servers' and unknown tools alone", () => {
    expect(engramToolName("mcp__notes__mem_save")).toBeUndefined();
    expect(engramToolName("mcp__engram__mem_unknown")).toBeUndefined();
    expect(engramToolName("Read")).toBeUndefined();
    expect(engramToolName(null)).toBeUndefined();
  });
});

describe("engramToolTitle", () => {
  it("names what was saved, searched for, or read", () => {
    expect(engramToolTitle("mcp__engram__mem_save", { title: "  Switched to\nJWT " })).toBe(
      "Save memory: Switched to JWT",
    );
    expect(engramToolTitle("mcp__engram__mem_search", { query: "auth model" })).toBe(
      "Search memory: “auth model”",
    );
    expect(engramToolTitle("mcp__engram__mem_get_observation", { id: "42" })).toBe(
      "Read memory #42",
    );
    expect(engramToolTitle("mcp__engram__mem_update", { id: 7 })).toBe("Update memory #7");
    expect(engramToolTitle("mcp__engram__mem_session_summary", {})).toBe(
      "Save session summary to memory",
    );
  });

  it("falls back to the tool's name when the input says nothing useful", () => {
    expect(engramToolTitle("mcp__engram__mem_save", { title: "   " })).toBe("Save memory");
    expect(engramToolCall("mem_get_observation", { id: -1 })).toEqual({
      kind: "read",
      id: undefined,
    });
  });

  it("is the dynamic tool heading every client and adapter uses", () => {
    expect(dynamicToolTitle("mcp__engram__mem_save", { title: "A" })).toBe("Save memory: A");
  });
});

describe("engramToolResult", () => {
  it("reads the saved memory's id and a search's count from Engram's JSON", () => {
    expect(engramToolResult('{"id":261,"project":"t3code"}')).toEqual({
      id: 261,
      found: undefined,
    });
    expect(
      engramToolResult({
        content: [{ type: "text", text: '{"result":"Found 2","results":[{"id":1},{"id":2}]}' }],
      }),
    ).toEqual({ id: undefined, found: 2 });
    expect(engramToolResult([{ type: "text", text: '{"results":[]}' }]).found).toBe(0);
  });

  it("knows nothing from output that is not JSON", () => {
    expect(engramToolResult("Memory saved")).toEqual({ id: undefined, found: undefined });
    expect(engramToolResult(undefined)).toEqual({ id: undefined, found: undefined });
  });
});

describe("compactEngramToolCall", () => {
  it("keeps what clients read and leaves the memory's content on the server", () => {
    const compact = compactEngramToolCall(
      "mcp__engram__mem_save",
      { title: "Switched to JWT", type: "decision", content: "x".repeat(50_000) },
      [{ type: "text", text: '{"id":230,"candidates":[{"id":1}]}' }],
    );
    expect(compact).toEqual({
      input: { title: "Switched to JWT", type: "decision" },
      output: { memoryId: 230 },
    });
    // The client reads the compact form the same way it reads Engram's answer.
    expect(engramToolResult(compact?.output)).toEqual({ id: 230, found: undefined });
    expect(engramToolCall("mcp__engram__mem_save", compact?.input)).toEqual({
      kind: "save",
      title: "Switched to JWT",
      type: "decision",
    });
  });

  it("carries a search's count, and nothing for other tools", () => {
    expect(
      compactEngramToolCall("mcp__engram__mem_search", { query: "auth" }, '{"results":[{},{}]}'),
    ).toEqual({ input: { query: "auth" }, output: { found: 2 } });
    expect(engramToolResult({ found: 0 }).found).toBe(0);
    expect(compactEngramToolCall("mcp__github__fetch_pr", {}, "")).toBeUndefined();
  });
});
