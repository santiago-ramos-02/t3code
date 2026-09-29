import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Pi packages that make up Gentle AI. A Pi thread with Gentle AI off loads none of them, and
 * clients hide the commands and skills they provide.
 */
export const PI_GENTLE_PACKAGES: ReadonlyArray<string> = ["gentle-pi", "gentle-engram"];

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

export const PiGentlePersona = Schema.Literals(["gentleman", "neutral"]);

export const PiGentleComposerState = Schema.Struct({
  available: Schema.Boolean,
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
});
export type PiGentleComposerState = typeof PiGentleComposerState.Type;

export const PiGentleComposerReadInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  cwd: TrimmedNonEmptyString,
});

export const PiGentleState = Schema.Struct({
  available: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  // The installed commit when gentle-pi is installed from git, which the version alone
  // does not tell apart.
  commit: Schema.optionalKey(Schema.String),
  // Whether Pi's package source has a newer gentle-pi; absent when that cannot be known,
  // such as a pinned version, a local folder, or no network.
  updateAvailable: Schema.optionalKey(Schema.Boolean),
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
    // Updates an installed gentle-pi in place. T3 Code never installs it: users opt into
    // Gentle AI with Pi's own package manager.
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
  ]),
});
