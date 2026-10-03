import { describe, expect, it } from "vite-plus/test";

import {
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
