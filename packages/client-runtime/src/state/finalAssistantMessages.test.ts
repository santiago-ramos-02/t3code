import { describe, expect, it } from "vite-plus/test";
import { finalAssistantMessageIds } from "./finalAssistantMessages.ts";

describe("finalAssistantMessageIds", () => {
  it("keeps a promptless continuation in one visual response", () => {
    const ids = finalAssistantMessageIds([
      { id: "prompt", role: "user" },
      { id: "thought-1", role: "reasoning" },
      { id: "initial-reply", role: "assistant" },
      { id: "thought-2", role: "reasoning" },
      { id: "follow-up", role: "assistant" },
    ]);

    expect([...ids]).toEqual(["follow-up"]);
  });

  it("ends one response when another user message arrives", () => {
    const ids = finalAssistantMessageIds([
      { id: "prompt-1", role: "user" },
      { id: "reply-1", role: "assistant" },
      { id: "prompt-2", role: "user" },
      { id: "reply-2", role: "assistant" },
    ]);

    expect([...ids]).toEqual(["reply-1", "reply-2"]);
  });
});
