import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const PiGentleRoutingEntry = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(
    Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  ),
});
export const PiGentleRouting = Schema.Record(Schema.String, PiGentleRoutingEntry);
export type PiGentleRouting = typeof PiGentleRouting.Type;

export const PiGentleSddPreferences = Schema.Struct({
  executionMode: Schema.Literals(["interactive", "auto"]),
  artifactStore: Schema.Literals(["openspec", "engram", "hybrid", "none"]),
  chainedPrStrategy: Schema.Literals(["ask-on-risk", "auto-chain", "single-pr"]),
  reviewBudgetLines: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PiGentleSddPreferences = typeof PiGentleSddPreferences.Type;

export const PiGentleSddStatus = Schema.Struct({
  changeName: Schema.NullOr(Schema.String),
  artifactStore: Schema.Literals(["openspec", "engram", "hybrid", "none"]),
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
export type PiGentleSddStatus = typeof PiGentleSddStatus.Type;

export const PiGentleComposerState = Schema.Struct({
  available: Schema.Boolean,
  sddStatus: Schema.NullOr(PiGentleSddStatus),
  projectInitNeeded: Schema.Boolean,
});
export type PiGentleComposerState = typeof PiGentleComposerState.Type;

export const PiGentleComposerReadInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  cwd: TrimmedNonEmptyString,
});

export const PiGentleState = Schema.Struct({
  available: Schema.Boolean,
  profiles: Schema.Array(Schema.Struct({ name: Schema.String, routing: PiGentleRouting })),
  active: Schema.NullOr(Schema.String),
  project: Schema.NullOr(
    Schema.Struct({
      pinAvailable: Schema.Boolean,
      pinned: Schema.NullOr(Schema.String),
      pinSource: Schema.NullOr(Schema.Literals(["local", "repo"])),
      sdd: Schema.NullOr(PiGentleSddPreferences),
    }),
  ),
});
export type PiGentleState = typeof PiGentleState.Type;

export const PiGentleReadInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
});
export const PiGentleActionInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  action: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("create"),
      name: Schema.String,
      cwd: Schema.optionalKey(TrimmedNonEmptyString),
    }),
    Schema.Struct({
      type: Schema.Literal("save"),
      name: Schema.String,
      routing: PiGentleRouting,
      cwd: Schema.optionalKey(TrimmedNonEmptyString),
    }),
    Schema.Struct({ type: Schema.Literal("pin"), name: Schema.String, cwd: TrimmedNonEmptyString }),
    Schema.Struct({ type: Schema.Literal("clearPin"), cwd: TrimmedNonEmptyString }),
    Schema.Struct({
      type: Schema.Literal("saveSdd"),
      cwd: TrimmedNonEmptyString,
      preferences: PiGentleSddPreferences,
    }),
  ]),
});
