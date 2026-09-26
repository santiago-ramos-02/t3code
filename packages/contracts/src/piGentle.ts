import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const PiGentleRoutingEntry = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(
    Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  ),
});
export type PiGentleRoutingEntry = typeof PiGentleRoutingEntry.Type;
export const PiGentleRouting = Schema.Record(Schema.String, PiGentleRoutingEntry);
export type PiGentleRouting = typeof PiGentleRouting.Type;
/** Routing key a profile uses for the main Pi model rather than a subagent. */
export const PI_GENTLE_ORCHESTRATOR = "orchestrator";

export const PiGentleSddPreferences = Schema.Struct({
  executionMode: Schema.Literals(["interactive", "auto"]),
  artifactStore: Schema.Literals(["openspec", "engram", "hybrid", "none"]),
  chainedPrStrategy: Schema.Literals(["ask-on-risk", "auto-chain", "single-pr"]),
  reviewBudgetLines: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PiGentleSddPreferences = typeof PiGentleSddPreferences.Type;

export const PiGentlePersona = Schema.Literals(["gentleman", "neutral"]);

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

/** Native SDD status of one active OpenSpec change in a project. */
export const PiGentleSddChange = Schema.Struct({
  ...PiGentleSddStatus.fields,
  changeName: Schema.String,
});
export type PiGentleSddChange = typeof PiGentleSddChange.Type;

export const PiGentleComposerState = Schema.Struct({
  available: Schema.Boolean,
  projectInitNeeded: Schema.Boolean,
  // Profiles a thread can apply, with the orchestrator entry that moves the thread's model.
  profiles: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        orchestrator: Schema.optionalKey(PiGentleRoutingEntry),
      }),
    ),
  ),
  // The profile subagent launches in this project resolve: its pin, else the active profile.
  effectiveProfile: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ name: Schema.String, pinned: Schema.Boolean })),
  ),
  // When changes are requested, exactly one of these is present: the project's active changes,
  // or why Gentle AI could not list them.
  changes: Schema.optionalKey(Schema.Array(PiGentleSddChange)),
  changesError: Schema.optionalKey(Schema.String),
});
export type PiGentleComposerState = typeof PiGentleComposerState.Type;

export const PiGentleComposerReadInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  cwd: TrimmedNonEmptyString,
  // Listing changes runs Gentle AI once per change, so clients ask only when showing them.
  includeChanges: Schema.optionalKey(Schema.Boolean),
});

export const PiGentleInitializeInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  cwd: TrimmedNonEmptyString,
  command: Schema.optionalKey(Schema.Literals(["setup", "review"])),
});

export const PiGentleState = Schema.Struct({
  available: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  // Set when the installed Gentle AI is newer than the releases T3 Code was tested with.
  compatibilityWarning: Schema.optionalKey(Schema.String),
  globalPersona: Schema.optionalKey(PiGentlePersona),
  profiles: Schema.Array(Schema.Struct({ name: Schema.String, routing: PiGentleRouting })),
  active: Schema.NullOr(Schema.String),
  project: Schema.NullOr(
    Schema.Struct({
      pinAvailable: Schema.Boolean,
      pinned: Schema.NullOr(Schema.String),
      pinSource: Schema.NullOr(Schema.Literals(["local", "repo"])),
      sdd: Schema.NullOr(PiGentleSddPreferences),
      persona: Schema.Struct({
        effective: PiGentlePersona,
        global: PiGentlePersona,
        override: Schema.NullOr(PiGentlePersona),
      }),
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
      type: Schema.Literal("install"),
      cwd: Schema.optionalKey(TrimmedNonEmptyString),
    }),
    Schema.Struct({
      type: Schema.Literal("update"),
      cwd: Schema.optionalKey(TrimmedNonEmptyString),
    }),
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
    Schema.Struct({
      type: Schema.Literal("activate"),
      name: Schema.String,
      cwd: Schema.optionalKey(TrimmedNonEmptyString),
    }),
    // Gentle AI's own apply from inside a project: re-pins the checkout when a pin governs it,
    // otherwise activates the profile globally.
    Schema.Struct({
      type: Schema.Literal("apply"),
      name: Schema.String,
      cwd: TrimmedNonEmptyString,
    }),
    Schema.Struct({ type: Schema.Literal("pin"), name: Schema.String, cwd: TrimmedNonEmptyString }),
    Schema.Struct({ type: Schema.Literal("clearPin"), cwd: TrimmedNonEmptyString }),
    Schema.Struct({
      type: Schema.Literal("setPersona"),
      cwd: TrimmedNonEmptyString,
      mode: Schema.NullOr(PiGentlePersona),
    }),
    Schema.Struct({
      type: Schema.Literal("setGlobalPersona"),
      mode: PiGentlePersona,
      cwd: Schema.optionalKey(TrimmedNonEmptyString),
    }),
    Schema.Struct({
      type: Schema.Literal("saveSdd"),
      cwd: TrimmedNonEmptyString,
      preferences: PiGentleSddPreferences,
    }),
  ]),
});
