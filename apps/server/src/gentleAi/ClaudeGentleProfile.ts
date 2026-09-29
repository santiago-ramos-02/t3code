/**
 * The Gentle AI Claude Code profile T3 Code applies itself. gentle-ai, told T3 Code is its
 * host, leaves ~/.claude alone and writes the applied profile's slot models and guide to
 * ~/.gentle-ai/claude-host.json. T3 Code gives them only to Claude Code sessions that go
 * through a proxy (ANTHROPIC_BASE_URL set), since only a proxy serves other providers'
 * models; Claude Code reaching Anthropic directly keeps its own models.
 *
 * @module gentleAi/ClaudeGentleProfile
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { gentleAiUserHome } from "./GentleAiOff.ts";

/** The host name T3 Code gives gentle-ai when applying or saving a Claude Code profile. */
export const GENTLE_AI_PROFILE_HOST = "t3";

// Only the slot variables pass through, whatever else the file holds.
const SLOT_VARIABLE = /^ANTHROPIC_DEFAULT_(FABLE|OPUS|SONNET|HAIKU)_MODEL$/;

const HostSetup = Schema.Struct({
  profile: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
  guide: Schema.optional(Schema.String),
});
const decodeHostSetup = Schema.decodeUnknownEffect(Schema.fromJsonString(HostSetup));

export interface ClaudeGentleProfile {
  readonly name: string;
  /** Slot variables, for the session's settings. */
  readonly env: Readonly<Record<string, string>>;
  /** What each slot runs and is for, for the system prompt; empty when the profile says nothing. */
  readonly guide: string;
}

/** Whether Claude Code launched with this environment talks to a proxy. */
export const goesThroughProxy = (environment: NodeJS.ProcessEnv) =>
  (environment.ANTHROPIC_BASE_URL ?? "").trim() !== "";

/** The applied profile for a proxied session, or null when none is applied or it is unreadable. */
export const readClaudeGentleProfile = (
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(
      gentleAiUserHome(environment, platform),
      ".gentle-ai",
      "claude-host.json",
    );
    const setup = yield* fileSystem.readFileString(file).pipe(Effect.flatMap(decodeHostSetup));
    const env = Object.fromEntries(
      Object.entries(setup.env).filter(
        ([name, value]) => SLOT_VARIABLE.test(name) && value.trim() !== "",
      ),
    );
    return {
      name: setup.profile,
      env,
      guide: setup.guide?.trim() ?? "",
    } satisfies ClaudeGentleProfile;
  }).pipe(Effect.orElseSucceed((): ClaudeGentleProfile | null => null));
