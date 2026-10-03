import * as Schema from "effect/Schema";

/**
 * Memory: what the agents on an environment learned, kept by Engram (persistent agent memory)
 * and read through its local server on that environment. Every shape here is what the T3 server
 * hands clients; Engram's own API stays behind it.
 */

/** Whether Engram can be read on the environment. */
export const MemoryStatus = Schema.Struct({
  state: Schema.Literals([
    // No engram binary on the environment.
    "not-installed",
    "running",
    // Installed, but its server could not be started or reached.
    "unreachable",
  ]),
  version: Schema.NullOr(Schema.String),
  // Why it is not running, for the user.
  problem: Schema.optionalKey(Schema.String),
});
export type MemoryStatus = typeof MemoryStatus.Type;

/** One memory, without its content, as lists and the brain map show it. */
export const MemoryObservation = Schema.Struct({
  id: Schema.Number,
  syncId: Schema.String,
  sessionId: Schema.String,
  // decision, architecture, bugfix, pattern, config, discovery, learning, preference, passive,
  // session_summary, manual, or any type an agent chose.
  type: Schema.String,
  title: Schema.String,
  project: Schema.NullOr(Schema.String),
  scope: Schema.String,
  topicKey: Schema.NullOr(Schema.String),
  // How many times it was updated in place; 1 for a memory saved once.
  revisionCount: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type MemoryObservation = typeof MemoryObservation.Type;

/**
 * How two memories relate. `pending` is one Engram flagged and nobody judged yet; the others are
 * verdicts.
 */
export const MemoryRelationKind = Schema.Literals([
  "pending",
  "related",
  "compatible",
  "scoped",
  "conflicts_with",
  "supersedes",
  "not_conflict",
]);
export type MemoryRelationKind = typeof MemoryRelationKind.Type;

/** A verdict a person can give a pending relation. */
export const MemoryVerdict = Schema.Literals([
  "related",
  "compatible",
  "scoped",
  "conflicts_with",
  "supersedes",
  "not_conflict",
]);
export type MemoryVerdict = typeof MemoryVerdict.Type;

export const MemoryRelation = Schema.Struct({
  syncId: Schema.String,
  relation: Schema.String,
  judgmentStatus: Schema.String,
  // The memories' sync ids. Either can be missing from the observations, when it was deleted.
  sourceId: Schema.String,
  targetId: Schema.String,
  sourceTitle: Schema.String,
  targetTitle: Schema.String,
  updatedAt: Schema.String,
});
export type MemoryRelation = typeof MemoryRelation.Type;

export const MemorySession = Schema.Struct({
  id: Schema.String,
  project: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  observationCount: Schema.Number,
});
export type MemorySession = typeof MemorySession.Type;

export const MemoryProject = Schema.Struct({
  name: Schema.String,
  observationCount: Schema.Number,
  sessionCount: Schema.Number,
});
export type MemoryProject = typeof MemoryProject.Type;

/** Everything the Memory page shows at once. Lists are empty unless Engram is running. */
export const MemoryOverview = Schema.Struct({
  status: MemoryStatus,
  projects: Schema.Array(MemoryProject),
  observations: Schema.Array(MemoryObservation),
  // Whether there were more memories than the overview carries; the newest are kept.
  observationsTruncated: Schema.Boolean,
  relations: Schema.Array(MemoryRelation),
  sessions: Schema.Array(MemorySession),
});
export type MemoryOverview = typeof MemoryOverview.Type;

export const MemorySearchInput = Schema.Struct({
  query: Schema.String,
  project: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
});

export const MemorySearchResult = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      observation: MemoryObservation,
      // The start of its content, to show why it matched.
      snippet: Schema.String,
    }),
  ),
});
export type MemorySearchResult = typeof MemorySearchResult.Type;

export const MemoryObservationInput = Schema.Struct({ id: Schema.Number });

/** One memory in full, with what was saved around it in the same session. */
export const MemoryObservationDetail = Schema.Struct({
  observation: MemoryObservation,
  content: Schema.String,
  before: Schema.Array(MemoryObservation),
  after: Schema.Array(MemoryObservation),
});
export type MemoryObservationDetail = typeof MemoryObservationDetail.Type;

/** Engram's own health checks. */
export const MemoryHealth = Schema.Struct({
  // ok, warning, or error.
  status: Schema.String,
  checks: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      // ok, warning, blocked, or error.
      result: Schema.String,
      message: Schema.String,
      // What Engram suggests doing about it.
      nextStep: Schema.NullOr(Schema.String),
    }),
  ),
});
export type MemoryHealth = typeof MemoryHealth.Type;

export const MemoryJudgeInput = Schema.Struct({
  relationSyncId: Schema.String,
  verdict: MemoryVerdict,
});

export const MemoryObsidianExportInput = Schema.Struct({
  // The Obsidian vault's folder on the environment; memories go into its engram folder.
  vault: Schema.String,
  // One project, or every project when absent.
  project: Schema.optionalKey(Schema.String),
});
export const MemoryObsidianExportResult = Schema.Struct({ output: Schema.String });

export class MemoryError extends Schema.TaggedError<MemoryError>()("MemoryError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
