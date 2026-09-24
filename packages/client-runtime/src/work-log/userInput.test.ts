import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { foldUserInputActivities } from "./userInput.ts";

function activity(
  id: string,
  kind: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind,
    payload,
    tone: "info",
    summary: kind,
    turnId: null,
    createdAt: "2026-09-24T00:00:00.000Z",
  };
}

const requested = activity("question", "user-input.requested", {
  requestId: "question-1",
  questions: [{ id: "choice", question: "Which option?", options: [] }],
});

describe("user input work log", () => {
  it("shows an unavailable native question as closed without recording the rejected answer", () => {
    const submitted = activity("submitted", "user-input.answer-submitted", {
      requestId: "question-1",
      answers: { choice: "First" },
    });
    const closed = activity("closed", "user-input.resolved", {
      requestId: "question-1",
      answers: {},
      reason: "unavailable",
    });

    expect(foldUserInputActivities([requested, submitted, closed])).toMatchObject([
      {
        summary: "Question closed",
        payload: { answers: {} },
      },
    ]);
    const timedOut = activity("timeout", "user-input.resolved", {
      requestId: "question-1",
      answers: {},
    });
    expect(foldUserInputActivities([requested, timedOut, submitted, closed])).toMatchObject([
      {
        summary: "Question closed",
        payload: { answers: {} },
      },
    ]);
  });

  it("keeps a previously accepted answer when a duplicate response arrives late", () => {
    const answered = activity("answered", "user-input.resolved", {
      requestId: "question-1",
      answers: { choice: "First" },
    });
    const closed = activity("closed", "user-input.resolved", {
      requestId: "question-1",
      answers: {},
      reason: "unavailable",
    });

    expect(foldUserInputActivities([requested, answered, closed])).toMatchObject([
      {
        summary: "User input submitted",
        payload: { answers: { choice: "First" } },
      },
    ]);
  });
});
