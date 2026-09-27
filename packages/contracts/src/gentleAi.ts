import * as Schema from "effect/Schema";

import type { ProviderOptionSelection } from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/**
 * Gentle AI (https://github.com/Gentleman-Programming/gentle-ai) layers an SDD workflow,
 * subagents, skills, and review onto many coding agents. It is not a provider: it installs
 * into each agent's own configuration, so a thread gets it through whichever provider runs it.
 */

/** The gentle-ai agent ids T3 Code runs, and the provider driver that runs each. */
export const GENTLE_AI_AGENT_DRIVERS = {
  "claude-code": "claudeAgent",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  antigravity: "antigravity",
  pi: "pi",
} as const satisfies Record<string, string>;

/** Model option a thread stores its Gentle AI choice in; absent means on. */
export const GENTLE_AI_OPTION_ID = "gentleAi";

/** Whether a thread's model options leave Gentle AI on. */
export function gentleAiEnabled(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): boolean {
  return options?.find((option) => option.id === GENTLE_AI_OPTION_ID)?.value !== false;
}

/** Gentle AI on this environment, as gentle-ai itself records it. */
export const GentleAiStatus = Schema.Struct({
  // A gentle-ai binary T3 Code can run; everything else needs one.
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  binaryPath: Schema.NullOr(Schema.String),
  // Agents gentle-ai configured on this machine, by gentle-ai's own ids.
  agents: Schema.Array(Schema.String),
  // Provider drivers whose agent Gentle AI is set up for.
  drivers: Schema.Array(ProviderDriverKind),
  preset: Schema.NullOr(Schema.String),
  persona: Schema.NullOr(Schema.String),
  components: Schema.Array(Schema.String),
  // gentle-ai changed since it last synced the agents' assets; `gentle-ai sync` refreshes them.
  syncNeeded: Schema.Boolean,
});
export type GentleAiStatus = typeof GentleAiStatus.Type;

export const GentleAiActionInput = Schema.Struct({
  // refresh re-reads status; the rest run the gentle-ai command of the same name: update
  // checks for new versions, upgrade installs them, sync refreshes agent assets, doctor reports.
  action: Schema.Literals(["refresh", "update", "upgrade", "sync", "doctor"]),
});
export type GentleAiActionInput = typeof GentleAiActionInput.Type;

export const GentleAiActionResult = Schema.Struct({
  status: GentleAiStatus,
  // What gentle-ai printed, for actions that report something.
  output: Schema.optionalKey(Schema.String),
});
export type GentleAiActionResult = typeof GentleAiActionResult.Type;

export class GentleAiError extends Schema.TaggedError<GentleAiError>()("GentleAiError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
