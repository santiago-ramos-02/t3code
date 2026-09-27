import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
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

/**
 * Package name the server gives the skills and slash commands gentle-ai installed into an
 * agent, so clients can leave them out of threads with Gentle AI off.
 */
export const GENTLE_AI_PACKAGE = "gentle-ai";

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

/** Where a project's SDD artifacts live, as chosen in its SDD preflight. */
export const GentleAiArtifactStore = Schema.Literals(["openspec", "engram", "hybrid", "none"]);

/** gentle-ai's native SDD status (`gentle-ai sdd-status --json`), the same for every agent. */
export const GentleAiSddStatus = Schema.Struct({
  changeName: Schema.NullOr(Schema.String),
  artifactStore: GentleAiArtifactStore,
  nextRecommended: Schema.Literals([
    "apply",
    "verify",
    "remediate",
    "archive",
    "archived",
    "resolve-blockers",
    "sdd-new",
    "select-change",
    "propose",
    "spec",
    "design",
    "tasks",
  ]),
  blockedReasons: Schema.Array(Schema.String),
  dependencies: Schema.Struct({
    proposal: Schema.Literals(["blocked", "ready", "all_done"]),
    specs: Schema.Literals(["blocked", "ready", "all_done"]),
    design: Schema.Literals(["blocked", "ready", "all_done"]),
    tasks: Schema.Literals(["blocked", "ready", "all_done"]),
    apply: Schema.Literals(["blocked", "ready", "all_done"]),
    verify: Schema.Literals(["blocked", "ready", "all_done"]),
    archive: Schema.Literals(["blocked", "ready", "all_done"]),
  }),
  actionContext: Schema.Struct({
    mode: Schema.Literals(["repo-local", "workspace-planning"]),
    allowedEditRoots: Schema.Array(Schema.String),
  }),
  remediationState: Schema.optionalKey(
    Schema.Struct({
      required: Schema.Boolean,
      complete: Schema.Boolean,
      failedEvidenceRevision: Schema.String,
    }),
  ),
  taskProgress: Schema.Struct({
    total: Schema.Int,
    completed: Schema.Int,
    pending: Schema.Int,
  }),
});
export type GentleAiSddStatus = typeof GentleAiSddStatus.Type;

/** Native SDD status of one active OpenSpec change in a project. */
export const GentleAiSddChange = Schema.Struct({
  ...GentleAiSddStatus.fields,
  changeName: Schema.String,
});
export type GentleAiSddChange = typeof GentleAiSddChange.Type;

export const GentleAiSddChangesInput = Schema.Struct({ cwd: TrimmedNonEmptyString });

/** A project's active SDD changes. Only file-backed stores have changes to list. */
export const GentleAiSddChanges = Schema.Struct({
  artifactStore: GentleAiArtifactStore,
  changes: Schema.Array(GentleAiSddChange),
});
export type GentleAiSddChanges = typeof GentleAiSddChanges.Type;

export class GentleAiError extends Schema.TaggedError<GentleAiError>()("GentleAiError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
