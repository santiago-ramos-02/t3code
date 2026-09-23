export type GentleAgentRequest =
  | { readonly taskId: string; readonly action: "cancel" }
  | { readonly taskId: string; readonly action: "steer"; readonly message: string };

export function gentleAgentControlPrompt(request: GentleAgentRequest): string {
  const taskId = JSON.stringify(request.taskId);
  if (request.action === "cancel") {
    return `Please use the Gentle AI subagent_cancel tool with task_id ${taskId}. Tell me whether the task was stopped.`;
  }
  return `Please use the Gentle AI subagent_send_message tool with task_id ${taskId} and message ${JSON.stringify(request.message)}. Send that message exactly, then tell me whether it was accepted.`;
}
