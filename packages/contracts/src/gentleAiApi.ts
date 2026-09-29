import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The typed surface of `gentle-ai api`, the headless interface that lets T3 Code offer
 * everything Gentle AI's own TUI does. Each method names its params and result; the server
 * validates both against these, so a gentle-ai that answers differently fails loudly instead
 * of rendering wrong state. Ids stay plain strings: gentle-ai adds agents, components, and
 * presets over time, and clients show what it reports.
 *
 * @module gentleAiApi
 */

const Id = Schema.String;
const Ids = Schema.Array(Id);
const Opt = Schema.optionalKey;

// ---- Shared shapes ----------------------------------------------------------------------------

/** What to install: gentle-ai's own `model.Selection`. */
export const GentleAiSelection = Schema.Struct({
  agents: Ids,
  // Omitted components or skills follow the preset, as in the TUI.
  components: Opt(Ids),
  skills: Opt(Ids),
  persona: Opt(Id),
  preset: Opt(Id),
});
export type GentleAiSelection = typeof GentleAiSelection.Type;

export const GentleAiOpenCodeModel = Schema.Struct({
  providerId: Id,
  modelId: Id,
  effort: Opt(Id),
});
export type GentleAiOpenCodeModel = typeof GentleAiOpenCodeModel.Type;

const ModelAndEffort = Schema.Struct({ model: Id, effort: Opt(Id) });
const Assignments = <S extends Schema.Top>(value: S) => Schema.Record(Schema.String, value);

/**
 * Model choices per agent, as gentle-ai's `SyncOverrides`. An absent field leaves that
 * choice alone; an empty object resets it to gentle-ai's defaults.
 */
export const GentleAiModels = Schema.Struct({
  targetAgents: Opt(Ids),
  modelAssignments: Opt(Assignments(GentleAiOpenCodeModel)),
  claudePhaseAssignments: Opt(Assignments(ModelAndEffort)),
  claudeModelAssignments: Opt(Assignments(Id)),
  kiroModelAssignments: Opt(Assignments(Id)),
  codexModelAssignments: Opt(Assignments(Id)),
  codexOrchestratorAssignment: Opt(ModelAndEffort),
  clearCodexOrchestratorAssignment: Opt(Schema.Boolean),
  codexCarrilModelAssignments: Opt(Assignments(Id)),
  codexPhaseModelAssignments: Opt(Assignments(Id)),
});
export type GentleAiModels = typeof GentleAiModels.Type;

const Named = Schema.Struct({ id: Id, label: Id, description: Opt(Schema.String) });
const Cwd = TrimmedNonEmptyString;
const Files = Schema.Struct({ files: Ids, manualActions: Opt(Ids) });

// ---- Status and planning ----------------------------------------------------------------------

export const GentleAiApiStatus = Schema.Struct({
  version: Schema.String,
  system: Schema.Struct({
    os: Schema.String,
    arch: Schema.String,
    shell: Schema.String,
    supported: Schema.Boolean,
  }),
  agents: Schema.Array(
    Schema.Struct({
      id: Id,
      name: Schema.String,
      detected: Schema.Boolean,
      installed: Schema.Boolean,
      supported: Schema.Boolean,
      configPath: Schema.String,
    }),
  ),
  components: Schema.Array(
    Schema.Struct({
      id: Id,
      name: Schema.String,
      description: Schema.String,
      installed: Schema.Boolean,
      requires: Ids,
    }),
  ),
  presets: Schema.Array(
    Schema.Struct({
      id: Id,
      label: Schema.String,
      description: Opt(Schema.String),
      components: Ids,
    }),
  ),
  personas: Schema.Array(
    Schema.Struct({ id: Id, label: Schema.String, description: Opt(Schema.String) }),
  ),
  skills: Schema.Array(Schema.Struct({ id: Id, name: Schema.String, installed: Schema.Boolean })),
  // What gentle-ai recorded choosing; a field is absent until it has been chosen.
  state: Schema.Struct({
    preset: Opt(Id),
    persona: Opt(Id),
    rddMode: Opt(Id),
    pendingSync: Schema.Boolean,
    // The agents' files are behind this gentle-ai; absent from builds before it was reported.
    syncNeeded: Opt(Schema.Boolean),
    lastSyncedAt: Opt(Schema.String),
    background: Schema.Struct({ opencode: Opt(Id), pi: Opt(Id) }),
  }),
  openCodeDetected: Schema.Boolean,
  builderEngines: Ids,
});
export type GentleAiApiStatus = typeof GentleAiApiStatus.Type;

/** The follow-up choices the TUI asks for a selection, in its order. */
export const GentleAiPlanQuestion = Schema.Literals([
  "claudeModels",
  "kiroModels",
  "codexModels",
  "openCodeModels",
  "skills",
  "communityTools",
  "openCodePlugins",
  "piPlugins",
  "rdd",
  "openCodeBackground",
  "piBackground",
]);
export type GentleAiPlanQuestion = typeof GentleAiPlanQuestion.Type;

export const GentleAiPlan = Schema.Struct({
  agents: Ids,
  unsupportedAgents: Ids,
  components: Ids,
  addedDependencies: Ids,
  steps: Schema.Array(Schema.Struct({ id: Id })),
  // Newer gentle-ai may ask more; a client skips questions it does not know.
  questions: Schema.Array(Schema.String),
});
export type GentleAiPlan = typeof GentleAiPlan.Type;

// ---- Install, sync, updates ------------------------------------------------------------------

export const GentleAiBackgroundChoice = Schema.Literals(["auto", "on", "off"]);

export const GentleAiInstallParams = Schema.Struct({
  selection: GentleAiSelection,
  // Per agent, a model preset resolved as `models.set` does; explicit `models` win over it.
  modelPresets: Opt(Schema.Record(Schema.String, Id)),
  // The repository RDD is resolved for; gentle-ai's home when absent.
  cwd: Opt(Cwd),
  models: Opt(GentleAiModels),
  communityTools: Opt(Ids),
  openCodePlugins: Opt(Ids),
  // Optional Pi packages, such as the Claude bridge.
  piPlugins: Opt(Ids),
  rdd: Opt(Schema.Boolean),
  background: Opt(
    Schema.Struct({ opencode: Opt(GentleAiBackgroundChoice), pi: Opt(GentleAiBackgroundChoice) }),
  ),
});
export type GentleAiInstallParams = typeof GentleAiInstallParams.Type;

export const GentleAiStepStatus = Schema.Literals(["running", "succeeded", "failed", "skipped"]);
export type GentleAiStepStatus = typeof GentleAiStepStatus.Type;

export const GentleAiInstallResult = Schema.Struct({
  steps: Schema.Array(Schema.Struct({ id: Id, status: Schema.String, error: Opt(Schema.String) })),
  manualActions: Ids,
  backupId: Opt(Id),
  rddMode: Opt(Id),
});

export const GentleAiUpdates = Schema.Struct({
  // False when gentle-ai skipped the check because it ran one recently; `force` runs it anyway.
  checked: Opt(Schema.Boolean),
  tools: Schema.Array(
    Schema.Struct({
      id: Id,
      name: Schema.String,
      // e.g. `up-to-date`, `update-available`, `not-installed`.
      status: Opt(Schema.String),
      installed: Opt(Schema.String),
      latest: Opt(Schema.String),
      updateAvailable: Schema.Boolean,
      releaseUrl: Opt(Schema.String),
      manualAction: Opt(Schema.String),
    }),
  ),
});
export type GentleAiUpdates = typeof GentleAiUpdates.Type;

const UnfinishedTool = Schema.Struct({
  name: Schema.String,
  error: Opt(Schema.String),
  manualAction: Opt(Schema.String),
});

export const GentleAiUpgradeResult = Schema.Struct({
  upgraded: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      oldVersion: Opt(Schema.String),
      newVersion: Opt(Schema.String),
    }),
  ),
  failed: Schema.Array(UnfinishedTool),
  skipped: Schema.Array(UnfinishedTool),
  // Files the follow-up sync changed, when the upgrade synced.
  files: Ids,
  backupId: Opt(Id),
  backupWarning: Opt(Schema.String),
  restartRequired: Schema.Boolean,
  syncPending: Schema.Boolean,
});

// ---- Models --------------------------------------------------------------------------

export const GentleAiModelAgent = Schema.Literals(["claude-code", "codex", "kiro-ide", "opencode"]);
export type GentleAiModelAgent = typeof GentleAiModelAgent.Type;

export const GentleAiModelConfig = Schema.Struct({
  agent: GentleAiModelAgent,
  presets: Schema.Array(Named),
  currentPreset: Schema.NullOr(Id),
  phases: Schema.Array(Schema.Struct({ id: Id, label: Schema.String, group: Id })),
  current: GentleAiModels,
  options: Schema.Struct({
    claude: Opt(
      Schema.Struct({
        models: Schema.Array(Schema.Struct({ id: Id, label: Schema.String, efforts: Ids })),
      }),
    ),
    kiro: Opt(
      Schema.Struct({ models: Schema.Array(Schema.Struct({ id: Id, label: Schema.String })) }),
    ),
    codex: Opt(
      Schema.Struct({
        models: Schema.Array(Schema.Struct({ id: Id, label: Schema.String })),
        efforts: Ids,
      }),
    ),
    opencode: Opt(
      Schema.Struct({
        providers: Schema.Array(
          Schema.Struct({
            id: Id,
            name: Schema.String,
            models: Schema.Array(Schema.Struct({ id: Id, name: Schema.String, variants: Ids })),
          }),
        ),
        customAgents: Ids,
      }),
    ),
  }),
});
export type GentleAiModelConfig = typeof GentleAiModelConfig.Type;

// ---- Claude Code profiles --------------------------------------------------------------------

/** Claude Code's model slots, the names its orchestrator picks between per delegation. */
export const GENTLE_AI_CLAUDE_SLOTS = ["fable", "opus", "sonnet", "haiku"] as const;
export type GentleAiClaudeSlot = (typeof GENTLE_AI_CLAUDE_SLOTS)[number];

/** What one slot runs, and what the orchestrator should use it for. */
export const GentleAiClaudeSlotModel = Schema.Struct({
  model: Id,
  label: Opt(Schema.String),
  useFor: Opt(Schema.String),
});

/**
 * A named Claude Code setup: what each slot runs, and optionally fixed models for Gentle AI's
 * phases. Without phases, Claude Code's orchestrator picks every model itself.
 */
export const GentleAiClaudeProfile = Schema.Struct({
  name: Schema.String,
  description: Opt(Schema.String),
  slots: Schema.Record(Schema.String, GentleAiClaudeSlotModel),
  phases: Opt(Assignments(ModelAndEffort)),
});
export type GentleAiClaudeProfile = typeof GentleAiClaudeProfile.Type;

export const GentleAiClaudeProfiles = Schema.Struct({
  active: Schema.NullOr(Schema.String),
  profiles: Schema.Array(GentleAiClaudeProfile),
});
export type GentleAiClaudeProfiles = typeof GentleAiClaudeProfiles.Type;

export const GentleAiModelsSetParams = Schema.Union([
  Schema.Struct({ agent: GentleAiModelAgent, preset: Id }),
  Schema.Struct({ agent: GentleAiModelAgent, models: GentleAiModels }),
]);

// ---- Backups, plugins, tools, builder --------------------------------------------------------

export const GentleAiBackup = Schema.Struct({
  id: Id,
  createdAt: Schema.String,
  source: Schema.String,
  description: Schema.String,
  fileCount: Schema.Number,
  createdByVersion: Schema.String,
  pinned: Schema.Boolean,
});
export type GentleAiBackup = typeof GentleAiBackup.Type;

/** The agents with plugins gentle-ai manages; OpenCode when a call names none. */
export const GentleAiPluginAgent = Schema.Literals(["opencode", "pi"]);
export type GentleAiPluginAgent = typeof GentleAiPluginAgent.Type;

export const GentleAiPlugins = Schema.Struct({
  supported: Schema.Boolean,
  reason: Opt(Schema.String),
  plugins: Schema.Array(
    Schema.Struct({
      id: Id,
      name: Schema.String,
      description: Schema.String,
      // Absent for an installed plugin gentle-ai no longer offers; it can still be removed.
      repoUrl: Opt(Schema.String),
      installed: Schema.Boolean,
    }),
  ),
});
export type GentleAiPlugins = typeof GentleAiPlugins.Type;

export const GentleAiTools = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      id: Id,
      name: Schema.String,
      description: Schema.String,
      repoUrl: Schema.String,
      cliAvailable: Schema.Boolean,
      agents: Schema.Array(
        Schema.Struct({
          agent: Id,
          detected: Schema.Boolean,
          configured: Schema.Boolean,
          path: Opt(Schema.String),
          reason: Opt(Schema.String),
        }),
      ),
    }),
  ),
});
export type GentleAiTools = typeof GentleAiTools.Type;

export const GentleAiBuiltAgent = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  content: Schema.String,
});
export type GentleAiBuiltAgent = typeof GentleAiBuiltAgent.Type;

export const GentleAiBuilderPreview = Schema.Struct({
  agent: GentleAiBuiltAgent,
  targets: Ids,
  conflicts: Ids,
});
export type GentleAiBuilderPreview = typeof GentleAiBuilderPreview.Type;

// ---- Review and uninstall --------------------------------------------------------------------

/**
 * gentle-ai's own `gentle-ai.review-mode/v1` report, passed through unchanged. Mode values are
 * gentle-ai's (`on`/`off`); an empty `global` or `clone_local` means that scope never chose.
 */
export const GentleAiReviewMode = Schema.Struct({
  scope: Schema.String,
  status: Schema.Struct({
    global: Schema.String,
    clone_local: Schema.String,
    effective: Schema.String,
    source: Schema.String,
  }),
});
export type GentleAiReviewMode = typeof GentleAiReviewMode.Type;

const StoreEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  reason: Schema.String,
  present: Schema.Boolean,
  files: Schema.Number,
  bytes: Schema.Number,
  removed: Schema.Boolean,
});

/** gentle-ai's own `gentle-ai.review-store-reset-result/v1` report, passed through unchanged. */
export const GentleAiReviewStore = Schema.Struct({
  report: Schema.Struct({
    operation: Schema.String,
    repository: Schema.String,
    store_root: Schema.String,
    removable: Schema.Array(StoreEntry),
    preserved: Schema.Array(StoreEntry),
    unrecognized: Schema.Array(Schema.Unknown),
    in_flight: Schema.Array(Schema.Unknown),
    settled_lineages: Schema.Number,
    removed_files: Schema.Number,
    removed_bytes: Schema.Number,
    complete: Schema.Boolean,
  }),
});
export type GentleAiReviewStore = typeof GentleAiReviewStore.Type;

export const GentleAiUninstallMode = Schema.Literals([
  "partial",
  "full",
  "full-remove",
  "clean-install",
]);
export type GentleAiUninstallMode = typeof GentleAiUninstallMode.Type;

/** A project's ODD feature documents (`odd/tasks/*.md`), most recently changed first. */
export const GentleAiOddFeatures = Schema.Struct({
  features: Schema.Array(
    Schema.Struct({
      // The file name without .md, as ODD names the feature.
      name: Schema.String,
      // Relative to the project, with forward slashes.
      path: Schema.String,
      title: Schema.String,
      objective: Opt(Schema.String),
      tasksDone: Schema.Number,
      tasksTotal: Schema.Number,
      nextStep: Opt(Schema.String),
      updatedAt: Schema.String,
    }),
  ),
});
export type GentleAiOddFeatures = typeof GentleAiOddFeatures.Type;

export const GentleAiUninstallParams = Schema.Struct({
  mode: GentleAiUninstallMode,
  agents: Opt(Ids),
  components: Opt(Ids),
  engramScope: Opt(Schema.Literals(["global", "project"])),
  // Only scopes project cleanup; without one, Gentle AI is removed from the agents alone.
  cwd: Opt(Cwd),
});
export type GentleAiUninstallParams = typeof GentleAiUninstallParams.Type;

export const GentleAiUninstallResult = Schema.Struct({
  backupPath: Opt(Schema.String),
  changedFiles: Ids,
  removedFiles: Ids,
  removedDirectories: Ids,
  manualActions: Ids,
  failedAgents: Opt(Schema.Unknown),
  binaryRemoved: Opt(Schema.Boolean),
  synced: Opt(Schema.Boolean),
});

export const GentleAiDoctor = Schema.Struct({
  ok: Schema.Boolean,
  checks: Schema.Array(
    Schema.Struct({
      id: Id,
      status: Schema.String,
      message: Schema.String,
      remedy: Opt(Schema.String),
    }),
  ),
});
export type GentleAiDoctor = typeof GentleAiDoctor.Type;

// ---- The method table ------------------------------------------------------------------------

const Empty = Schema.Struct({});

/**
 * A query answers directly; a job is long-running or changes the machine, runs on the server
 * as the environment's single Gentle AI job, and streams its progress to every client.
 */
const codecs = <P extends Schema.Codec<unknown, unknown>, R extends Schema.Codec<unknown, unknown>>(
  params: P,
  result: R,
) => ({
  params,
  result,
  decodeParams: Schema.decodeUnknownEffect(params),
  encodeParams: Schema.encodeUnknownEffect(params),
  decodeResult: Schema.decodeUnknownEffect(result),
  // Clients decode what the server already validated; Option keeps render paths synchronous.
  decodeResultOption: Schema.decodeUnknownOption(result),
  encodeResult: Schema.encodeUnknownEffect(result),
});
const query = <P extends Schema.Codec<unknown, unknown>, R extends Schema.Codec<unknown, unknown>>(
  params: P,
  result: R,
) => ({ kind: "query" as const, ...codecs(params, result) });
const job = <P extends Schema.Codec<unknown, unknown>, R extends Schema.Codec<unknown, unknown>>(
  params: P,
  result: R,
) => ({ kind: "job" as const, ...codecs(params, result) });

export const GENTLE_AI_METHODS = {
  status: query(Empty, GentleAiApiStatus),
  plan: query(Schema.Struct({ selection: GentleAiSelection }), GentleAiPlan),
  updates: query(Schema.Struct({ force: Opt(Schema.Boolean) }), GentleAiUpdates),
  "models.get": query(
    Schema.Struct({ agent: GentleAiModelAgent, discover: Opt(Schema.Boolean) }),
    GentleAiModelConfig,
  ),
  "backups.list": query(Empty, Schema.Struct({ backups: Schema.Array(GentleAiBackup) })),
  "plugins.list": query(Schema.Struct({ agent: Opt(GentleAiPluginAgent) }), GentleAiPlugins),
  "tools.list": query(Schema.Struct({ cwd: Opt(Cwd) }), GentleAiTools),
  "builder.engines": query(
    Empty,
    Schema.Struct({
      engines: Schema.Array(
        Schema.Struct({ id: Id, name: Schema.String, available: Schema.Boolean }),
      ),
    }),
  ),
  // Without a cwd, the global setting read from the home directory.
  "odd.features": query(Schema.Struct({ cwd: Cwd }), GentleAiOddFeatures),
  "review.status": query(Schema.Struct({ cwd: Opt(Cwd) }), GentleAiReviewMode),
  "reviewStore.survey": query(Schema.Struct({ cwd: Cwd }), GentleAiReviewStore),
  "uninstall.plan": query(
    GentleAiUninstallParams,
    Schema.Struct({
      mode: GentleAiUninstallMode,
      agents: Ids,
      components: Ids,
      engramScopeAvailable: Schema.Boolean,
    }),
  ),
  doctor: query(Empty, GentleAiDoctor),
  "claude.profiles": query(Empty, GentleAiClaudeProfiles),

  install: job(GentleAiInstallParams, GentleAiInstallResult),
  sync: job(Schema.Struct({ agents: Opt(Ids), models: Opt(GentleAiModels) }), Files),
  // With `sync`, a sync follows the upgrade: the TUI's "Upgrade + Sync" rather than "Upgrade tools".
  upgrade: job(
    Schema.Struct({ tools: Opt(Ids), backup: Opt(Schema.Boolean), sync: Opt(Schema.Boolean) }),
    GentleAiUpgradeResult,
  ),
  "models.set": job(GentleAiModelsSetParams, Files),
  "backups.restore": job(Schema.Struct({ id: Id }), Schema.Struct({ restoredFiles: Ids })),
  "backups.delete": job(Schema.Struct({ id: Id }), Empty),
  "backups.rename": job(Schema.Struct({ id: Id, description: Schema.String }), Empty),
  "backups.pin": job(Schema.Struct({ id: Id, pinned: Schema.Boolean }), Empty),
  "plugins.install": job(
    Schema.Struct({ ids: Ids, agent: Opt(GentleAiPluginAgent) }),
    Schema.Struct({
      results: Schema.Array(Schema.Struct({ id: Id, changed: Schema.Boolean, files: Ids })),
    }),
  ),
  "plugins.uninstall": job(
    Schema.Struct({ id: Id, agent: Opt(GentleAiPluginAgent) }),
    Schema.Record(Schema.String, Schema.Unknown),
  ),
  "tools.install": job(
    Schema.Struct({ ids: Ids, cwd: Cwd }),
    Schema.Struct({
      results: Schema.Array(Schema.Struct({ id: Id, commandsRun: Ids, manualActions: Ids })),
    }),
  ),
  // Generation runs an agent for up to minutes, so it is a job even though it changes nothing.
  "builder.generate": job(
    Schema.Struct({ engine: Id, prompt: TrimmedNonEmptyString }),
    GentleAiBuilderPreview,
  ),
  "builder.install": job(
    // `engine` is the one that generated the agent, recorded with it.
    Schema.Struct({ agent: GentleAiBuiltAgent, engine: Id }),
    Schema.Struct({ files: Ids, renamedTo: Opt(Schema.String), warnings: Ids }),
  ),
  "review.set": job(
    Schema.Struct({
      // Needed for a clone override; the global switch works without one.
      cwd: Opt(Cwd),
      enabled: Schema.Boolean,
      scope: Opt(Schema.Literals(["global", "clone"])),
    }),
    GentleAiReviewMode,
  ),
  "reviewStore.reset": job(
    Schema.Struct({
      cwd: Cwd,
      includeInFlight: Opt(Schema.Boolean),
      includeAdapterReviews: Opt(Schema.Boolean),
    }),
    GentleAiReviewStore,
  ),
  "uninstall.run": job(GentleAiUninstallParams, GentleAiUninstallResult),
  // `replaces` is the previous name of a renamed profile. Saving the applied profile reapplies it.
  "claude.profiles.save": job(
    Schema.Struct({ profile: GentleAiClaudeProfile, replaces: Opt(Schema.String) }),
    GentleAiClaudeProfiles,
  ),
  "claude.profiles.delete": job(Schema.Struct({ name: Schema.String }), GentleAiClaudeProfiles),
  // A null name applies none, putting Claude Code's own slot models back.
  "claude.profiles.apply": job(
    Schema.Struct({ name: Schema.NullOr(Schema.String) }),
    GentleAiClaudeProfiles,
  ),
} as const;

type Methods = typeof GENTLE_AI_METHODS;
export type GentleAiMethod = keyof Methods;
export type GentleAiQueryMethod = {
  [M in GentleAiMethod]: Methods[M]["kind"] extends "query" ? M : never;
}[GentleAiMethod];
export type GentleAiJobMethod = Exclude<GentleAiMethod, GentleAiQueryMethod>;
export type GentleAiParams<M extends GentleAiMethod> = Methods[M]["params"]["Type"];
export type GentleAiResult<M extends GentleAiMethod> = Methods[M]["result"]["Type"];

const QUERY_METHODS = [
  "status",
  "plan",
  "updates",
  "models.get",
  "backups.list",
  "plugins.list",
  "tools.list",
  "builder.engines",
  "review.status",
  "reviewStore.survey",
  "uninstall.plan",
  "doctor",
  "odd.features",
  "claude.profiles",
] as const satisfies ReadonlyArray<GentleAiQueryMethod>;
const JOB_METHODS = [
  "install",
  "sync",
  "upgrade",
  "models.set",
  "backups.restore",
  "backups.delete",
  "backups.rename",
  "backups.pin",
  "plugins.install",
  "plugins.uninstall",
  "tools.install",
  "builder.generate",
  "builder.install",
  "review.set",
  "reviewStore.reset",
  "uninstall.run",
  "claude.profiles.save",
  "claude.profiles.delete",
  "claude.profiles.apply",
] as const satisfies ReadonlyArray<GentleAiJobMethod>;
// Both lists name every method of their kind; adding a method to the table without listing it
// fails here.
type Unlisted =
  | Exclude<GentleAiQueryMethod, (typeof QUERY_METHODS)[number]>
  | Exclude<GentleAiJobMethod, (typeof JOB_METHODS)[number]>;
export const GENTLE_AI_METHODS_LISTED: [Unlisted] extends [never] ? true : Unlisted = true;

export const GentleAiQueryMethodName = Schema.Literals(QUERY_METHODS);
export const GentleAiJobMethodName = Schema.Literals(JOB_METHODS);

// ---- Jobs and the RPCs -----------------------------------------------------------------------

export const GentleAiQueryInput = Schema.Struct({
  method: GentleAiQueryMethodName,
  params: Schema.Unknown,
});
export const GentleAiQueryResult = Schema.Struct({ data: Schema.Unknown });

export const GentleAiJobInput = Schema.Struct({
  method: GentleAiJobMethodName,
  params: Schema.Unknown,
});

/** The environment's Gentle AI job: one at a time, since gentle-ai serializes its own state. */
export const GentleAiJob = Schema.Struct({
  id: Schema.String,
  method: GentleAiJobMethodName,
  phase: Schema.Literals(["running", "succeeded", "failed"]),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  steps: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      // gentle-ai's name for the step, when it gives one.
      label: Opt(Schema.String),
      status: GentleAiStepStatus,
      error: Opt(Schema.String),
    }),
  ),
  // Command output, capped to the most recent lines.
  log: Schema.Array(Schema.String),
  result: Opt(Schema.Unknown),
  error: Opt(Schema.String),
});
export type GentleAiJob = typeof GentleAiJob.Type;

/** A method's result as the client receives it, or None if it does not match the contract. */
export function decodeGentleAiResult<M extends GentleAiMethod>(
  method: M,
  data: unknown,
): Option.Option<GentleAiResult<M>> {
  const decode: (input: unknown) => Option.Option<GentleAiResult<M>> =
    GENTLE_AI_METHODS[method].decodeResultOption;
  return decode(data);
}
