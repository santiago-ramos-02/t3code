import { describe, expect, it } from "@effect/vitest";

import { gentleAgentControlPrompt } from "./gentleAgentControl";

describe("gentleAgentControlPrompt", () => {
  it("names Gentle's existing cancel tool and the specific child", () => {
    expect(gentleAgentControlPrompt({ taskId: "child-1", action: "cancel" })).toContain(
      'subagent_cancel tool with task_id "child-1"',
    );
  });

  it("preserves quoted and multiline directions as one tool message", () => {
    const prompt = gentleAgentControlPrompt({
      taskId: "child-2",
      action: "steer",
      message: 'Check "auth"\nthen report',
    });
    expect(prompt).toContain('subagent_send_message tool with task_id "child-2"');
    expect(prompt).toContain('message "Check \\"auth\\"\\nthen report"');
  });
});
