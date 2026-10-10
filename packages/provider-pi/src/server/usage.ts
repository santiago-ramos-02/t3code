/**
 * Usage history for Pi: the format of its JSONL session files and where they
 * live. Gentle AI's child Pi sessions live in their own folder beside Pi's
 * sessions root and are read too.
 *
 * @module provider-pi/server/usage
 */
import type { UsageTokenTotals } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  parseTimestampMs,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { PiSettings } from "../settings.ts";

const PiTokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PiCostValue = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const PiUsageSchema = Schema.Struct({
  input: PiTokenCount,
  output: PiTokenCount,
  cacheRead: PiTokenCount,
  cacheWrite: PiTokenCount,
  reasoning: Schema.optionalKey(PiTokenCount),
  totalTokens: PiTokenCount,
  cost: Schema.Struct({
    input: PiCostValue,
    output: PiCostValue,
    cacheRead: PiCostValue,
    cacheWrite: PiCostValue,
    total: PiCostValue,
  }),
});
const PiEntryBase = {
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
} as const;
const PiTranscriptLineSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("session"),
    id: Schema.String,
    timestamp: Schema.String,
  }),
  Schema.Struct({
    ...PiEntryBase,
    type: Schema.Literal("model_change"),
    provider: Schema.String,
    modelId: Schema.String,
  }),
  Schema.Struct({
    ...PiEntryBase,
    type: Schema.Literal("message"),
    message: Schema.Struct({
      role: Schema.Literal("assistant"),
      provider: Schema.String,
      model: Schema.String,
      usage: PiUsageSchema,
    }),
  }),
  Schema.Struct({
    ...PiEntryBase,
    type: Schema.Literal("usage"),
    kind: Schema.String,
    provider: Schema.String,
    model: Schema.String,
    usage: PiUsageSchema,
  }),
  Schema.Struct({
    ...PiEntryBase,
    type: Schema.Literal("compaction"),
    usage: Schema.optionalKey(PiUsageSchema),
  }),
  Schema.Struct({
    ...PiEntryBase,
    type: Schema.Literal("branch_summary"),
    usage: Schema.optionalKey(PiUsageSchema),
  }),
]);
const decodePiTranscriptLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(PiTranscriptLineSchema),
);
const decodePiTranscriptEntry = Schema.decodeUnknownOption(PiTranscriptLineSchema);

/** Rolling state for one Pi session file. */
export const PiScanState = Schema.Struct({
  sessionId: Schema.mutableKey(Schema.String),
  /** Full provider/model slug from the latest active model-bearing entry. */
  model: Schema.mutableKey(Schema.String),
});
export type PiScanState = typeof PiScanState.Type;

export function initialPiScanState(): PiScanState {
  return { sessionId: "", model: "" };
}

const PI_UNKNOWN_MODEL = "unknown/unknown";

function piModelSlug(provider: string, model: string): string | null {
  const cleanProvider = provider.trim();
  const cleanModel = model.trim();
  return cleanProvider.length > 0 && cleanModel.length > 0
    ? `${cleanProvider}/${cleanModel}`
    : null;
}

function piTotals(usage: typeof PiUsageSchema.Type): UsageTokenTotals | null {
  if (
    (usage.reasoning !== undefined && usage.reasoning > usage.output) ||
    usage.totalTokens !== usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  ) {
    return null;
  }
  return {
    uncachedInputTokens: usage.input,
    cachedInputTokens: usage.cacheRead,
    cacheCreationTokens: usage.cacheWrite,
    outputTokens: usage.output,
    // Pi only supplies this when the provider reports an authoritative split.
    reasoningTokens: usage.reasoning ?? 0,
  };
}

function piDedupeKey(input: {
  readonly entryType: string;
  readonly entryId: string;
  readonly timestamp: string;
  readonly model: string;
  readonly usage: typeof PiUsageSchema.Type;
}): string {
  const parts = [
    input.entryType,
    input.entryId,
    input.timestamp,
    input.model,
    input.usage.input,
    input.usage.output,
    input.usage.cacheRead,
    input.usage.cacheWrite,
    input.usage.reasoning ?? "",
    input.usage.totalTokens,
    input.usage.cost.input,
    input.usage.cost.output,
    input.usage.cost.cacheRead,
    input.usage.cost.cacheWrite,
    input.usage.cost.total,
  ];
  return `pi:${parts.map((part) => `${String(part).length}:${String(part)}`).join(":")}`;
}

/**
 * Reduces one Pi JSONL entry into at most one authoritative model call.
 *
 * Forked sessions copy entries byte-for-byte but use a new header. The dedupe
 * key therefore excludes session identity and instead binds the stable entry id
 * to immutable call identity. No prompt, tool, path, parent-session, or
 * extension-owned field is decoded into the returned record.
 */
export function parsePiLine(line: string, state: PiScanState): UsageRecord | null {
  const decoded = decodePiTranscriptLine(line);
  return Option.isNone(decoded) ? null : reducePiEntry(decoded.value, state);
}

function parsePiRecord(parsed: unknown, state: PiScanState): UsageRecord | null {
  const decoded = decodePiTranscriptEntry(parsed);
  return Option.isNone(decoded) ? null : reducePiEntry(decoded.value, state);
}

function reducePiEntry(
  entry: typeof PiTranscriptLineSchema.Type,
  state: PiScanState,
): UsageRecord | null {
  if (entry.type === "session") {
    if (entry.id.trim().length > 0) state.sessionId = entry.id;
    return null;
  }
  if (entry.type === "model_change") {
    const model = piModelSlug(entry.provider, entry.modelId);
    if (model !== null) state.model = model;
    return null;
  }

  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return null;

  let model: string;
  let usage: typeof PiUsageSchema.Type | undefined;
  if (entry.type === "message") {
    const assistantModel = piModelSlug(entry.message.provider, entry.message.model);
    if (assistantModel === null) return null;
    model = assistantModel;
    state.model = assistantModel;
    usage = entry.message.usage;
  } else if (entry.type === "usage") {
    const usageModel = piModelSlug(entry.provider, entry.model);
    if (usageModel === null) return null;
    model = usageModel;
    usage = entry.usage;
  } else {
    model = state.model || PI_UNKNOWN_MODEL;
    usage = entry.usage;
  }
  if (usage === undefined) return null;

  const totals = piTotals(usage);
  if (totals === null || totalTokens(totals) === 0) return null;
  return {
    provider: "pi",
    timestampMs,
    model,
    sessionId: state.sessionId,
    totals,
    reportedCostUsd: usage.cost.total,
    // Pi reports the billed cost itself, so no fast-mode multiplier applies.
    speed: "standard",
    dedupeKey: piDedupeKey({
      entryType: entry.type,
      entryId: entry.id,
      timestamp: entry.timestamp,
      model,
      usage,
    }),
  };
}

const orEmpty = (record: UsageRecord | null): readonly UsageRecord[] =>
  record === null ? [] : [record];

export const piUsageFormat: TranscriptUsageFormat<PiScanState> = {
  selectFields: {
    type: true,
    id: true,
    parentId: true,
    timestamp: true,
    kind: true,
    provider: true,
    model: true,
    modelId: true,
    usage: true,
    message: { role: true, provider: true, model: true, usage: true },
  },
  mightCarryUsage: (line) =>
    line.includes('"type":"session"') ||
    line.includes('"type":"model_change"') ||
    line.includes('"type":"message"') ||
    line.includes('"type":"usage"') ||
    line.includes('"type":"compaction"') ||
    line.includes('"type":"branch_summary"'),
  parseLine: (line, state) => orEmpty(parsePiLine(line, state)),
  parseProjected: (projected, state) => orEmpty(parsePiRecord(projected, state)),
  state: { initial: initialPiScanState, schema: PiScanState },
};

/* -------------------------------------------------------------------------- */
/* Where Pi keeps its sessions                                                */
/* -------------------------------------------------------------------------- */

interface PiPathOperations {
  readonly sep: string;
  readonly isAbsolute: (path: string) => boolean;
  readonly join: (...paths: ReadonlyArray<string>) => string;
  readonly resolve: (...paths: ReadonlyArray<string>) => string;
}

export type PiRelativePathLimitation =
  | "PI_CODING_AGENT_SESSION_DIR"
  | "PI_CODING_AGENT_DIR"
  | "settings.json sessionDir";

export interface PiAgentDirResolution {
  readonly directory: string;
  readonly ignoredRelativeEnvironment: boolean;
}

export interface PiSessionsRootResolution {
  readonly directory: string;
  readonly ignoredRelativePaths: ReadonlyArray<PiRelativePathLimitation>;
}

function expandPiTildePath(value: string, homeDir: string, pathOps: PiPathOperations): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || (pathOps.sep === "\\" && value.startsWith("~\\"))) {
    return pathOps.join(homeDir, value.slice(2));
  }
  return value;
}

function resolveAbsolutePiPath(
  value: string | undefined,
  homeDir: string,
  pathOps: PiPathOperations,
): string | null {
  if (value === undefined || value.length === 0) return null;
  const normalized = expandPiTildePath(value, homeDir, pathOps);
  return pathOps.isAbsolute(normalized) ? pathOps.resolve(normalized) : null;
}

export function resolvePiAgentDir(
  environment: NodeJS.ProcessEnv,
  homeDir: string,
  pathOps: PiPathOperations,
): PiAgentDirResolution {
  const configured = environment.PI_CODING_AGENT_DIR;
  const absoluteConfigured = resolveAbsolutePiPath(configured, homeDir, pathOps);
  if (absoluteConfigured !== null) {
    return { directory: absoluteConfigured, ignoredRelativeEnvironment: false };
  }
  return {
    directory: pathOps.resolve(homeDir, ".pi", "agent"),
    ignoredRelativeEnvironment: configured !== undefined && configured.length > 0,
  };
}

export function resolvePiSessionsRoot(
  environment: NodeJS.ProcessEnv,
  globalSessionDir: string | undefined,
  homeDir: string,
  pathOps: PiPathOperations,
): PiSessionsRootResolution {
  const ignoredRelativePaths: PiRelativePathLimitation[] = [];
  const configuredSessions = environment.PI_CODING_AGENT_SESSION_DIR;
  const absoluteConfiguredSessions = resolveAbsolutePiPath(configuredSessions, homeDir, pathOps);
  if (absoluteConfiguredSessions !== null) {
    return { directory: absoluteConfiguredSessions, ignoredRelativePaths };
  }
  if (configuredSessions !== undefined && configuredSessions.length > 0) {
    ignoredRelativePaths.push("PI_CODING_AGENT_SESSION_DIR");
  }

  const agentDir = resolvePiAgentDir(environment, homeDir, pathOps);
  if (agentDir.ignoredRelativeEnvironment) {
    ignoredRelativePaths.push("PI_CODING_AGENT_DIR");
  } else if (globalSessionDir !== undefined && globalSessionDir.trim().length > 0) {
    const absoluteGlobalSessionDir = resolveAbsolutePiPath(globalSessionDir, homeDir, pathOps);
    if (absoluteGlobalSessionDir !== null) {
      return { directory: absoluteGlobalSessionDir, ignoredRelativePaths };
    }
    ignoredRelativePaths.push("settings.json sessionDir");
  }

  return {
    directory: pathOps.resolve(agentDir.directory, "sessions"),
    ignoredRelativePaths,
  };
}

export function piSourceDiagnostic(
  directoryMissing: boolean,
  limitations: ReadonlyArray<PiRelativePathLimitation>,
): string {
  if (limitations.length > 0) {
    const noun = limitations.length === 1 ? "setting" : "settings";
    return `Ignored relative Pi path ${noun} ${limitations.join(", ")} because relative Pi paths resolve from each invocation cwd; historical usage used the next reliable absolute source instead. Custom --session-dir and project-local directories outside that source are not discoverable.`;
  }
  return directoryMissing
    ? "No Pi transcript directory on this environment. Custom --session-dir and project-local session directories outside the resolved Pi sessions root are not discoverable."
    : "Custom Pi --session-dir and project-local session directories outside this resolved sessions root are not discoverable.";
}

const PiGlobalSettings = Schema.Struct({ sessionDir: Schema.optionalKey(Schema.String) });
const decodePiGlobalSettings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PiGlobalSettings as unknown as Schema.Codec<typeof PiGlobalSettings.Type>),
);

/** The user's home as a process started with `environment` sees it. */
const piUserHome = (
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fallback: string,
): string =>
  (platform === "win32" ? environment.USERPROFILE : environment.HOME)?.trim() || fallback;

export const piUsageReader: ProviderUsageReader<PiSettings, FileSystem.FileSystem | Path.Path> = {
  kind: "transcripts",
  provider: "pi",
  format: piUsageFormat,
  // Historical transcript usage is intentionally provider-level. A Pi sessions
  // root can be shared by several configured instances, and the files carry no
  // reliable T3 provider-instance identity. Live adapter events retain their
  // exact providerInstanceId separately.
  directories: Effect.fn("piUsageReader.directories")(function* ({ environment }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDir = piUserHome(
      environment,
      yield* HostProcess.Platform,
      yield* HostProcess.HomeDirectory,
    );
    const agentDir = resolvePiAgentDir(environment, homeDir, path);
    const hasAbsoluteSessionEnvironment =
      resolveAbsolutePiPath(environment.PI_CODING_AGENT_SESSION_DIR, homeDir, path) !== null;
    const globalSessionDir =
      hasAbsoluteSessionEnvironment || agentDir.ignoredRelativeEnvironment
        ? undefined
        : yield* fileSystem.readFileString(path.join(agentDir.directory, "settings.json")).pipe(
            Effect.flatMap((raw) =>
              decodePiGlobalSettings(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw),
            ),
            Effect.map((settings) => settings.sessionDir),
            Effect.orElseSucceed(() => undefined),
          );
    const resolved = resolvePiSessionsRoot(environment, globalSessionDir, homeDir, path);
    const exists = yield* fileSystem
      .exists(resolved.directory)
      .pipe(Effect.orElseSucceed(() => false));
    // Gentle AI runs child Pi sessions outside Pi's normal sessions root.
    const gentleSessions = path.resolve(agentDir.directory, "gentle-agents", "sessions");
    const relative = path.relative(resolved.directory, gentleSessions);
    const gentleInsideRoot =
      relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    return [
      {
        dir: resolved.directory,
        message: piSourceDiagnostic(!exists, resolved.ignoredRelativePaths),
      },
      ...(gentleInsideRoot ? [] : [{ dir: gentleSessions, optional: true as const }]),
    ];
  }),
};
