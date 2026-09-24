import { describe, expect, it } from "vite-plus/test";
import { continuingAssistantTurnIds, finalAssistantMessageIds } from "./finalAssistantMessages.ts";

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

describe("continuingAssistantTurnIds", () => {
  it("marks an earlier parent reply when Pi follows up without a user message", () => {
    const turns = continuingAssistantTurnIds([
      { role: "user" },
      { role: "assistant", turnId: "first" },
      { role: "reasoning", turnId: "second" },
      { role: "assistant", turnId: "second" },
    ]);

    expect([...turns]).toEqual(["first"]);
  });

  it("keeps separate user prompts and settled replies independent", () => {
    const turns = continuingAssistantTurnIds([
      { role: "user" },
      { role: "assistant", turnId: "first" },
      { role: "user" },
      { role: "assistant", turnId: "second" },
    ]);

    expect([...turns]).toEqual([]);
  });

  it("marks the latest reply while background work continues", () => {
    const messages = [{ role: "user" }, { role: "assistant", turnId: "first" }];

    expect([...continuingAssistantTurnIds(messages, { backgroundWorkContinues: true })]).toEqual([
      "first",
    ]);
    expect([...continuingAssistantTurnIds(messages, { activeTurnId: "second" })]).toEqual([
      "first",
    ]);
    expect([...continuingAssistantTurnIds(messages, { activeTurnId: "first" })]).toEqual([]);
    expect([...continuingAssistantTurnIds(messages)]).toEqual([]);
  });
});
