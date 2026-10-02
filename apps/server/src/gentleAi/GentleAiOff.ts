/**
 * Launching an agent with Gentle AI off. Each agent reads gentle-ai's footprint from its own
 * config home, so a thread with Gentle AI off gets a plain mirror of that home for the life of
 * its session: shared state (credentials, sessions, history) stays linked to the real home,
 * while gentle-ai's files are left out and the files it edits are filtered copies.
 *
 * @module gentleAi/GentleAiOff
 */
import * as NodeCrypto from "node:crypto";
import { hostUserHome } from "../hostUserHome.ts";
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  gentleAiMcpServers,
  GENTLE_AI_COMMAND_FILES,
  GENTLE_AI_OPENCODE_PLUGINS,
  GENTLE_AI_SKILLS,
  isGentleAiAgent,
  withoutGentleAiCodexConfig,
  withoutGentleAiHooks,
  withoutGentleAiInstructions,
} from "./GentleAiFootprint.ts";
import {
  materializePlainMirror,
  PlainConfigMirrorError,
  type PlainEntry,
} from "./PlainConfigMirror.ts";
import { footprintPlan, plainContent, type GentleAiPlainFootprint } from "./PlainFootprint.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));
const InstallState = Schema.Struct({
  components: Schema.optional(Schema.Array(Schema.String)),
  installed_agents: Schema.optional(Schema.Array(Schema.String)),
});
const decodeInstallState = Schema.decodeUnknownEffect(Schema.fromJsonString(InstallState));

/** What gentle-ai recorded installing: its components and the agents it set up. */
const installState = (userHome: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const statePath = path.join(userHome, ".gentle-ai", "state.json");
    return yield* fileSystem.readFileString(statePath).pipe(
      Effect.flatMap(decodeInstallState),
      Effect.orElseSucceed((): typeof InstallState.Type => ({})),
    );
  });

/** The components gentle-ai installed, which decide which MCP servers are its own. */
const installedComponents = (userHome: string) =>
  installState(userHome).pipe(Effect.map((state) => state.components ?? []));

const readText = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => null));
  });

/** A JSON object with gentle-ai's keys removed; unreadable JSON is kept as it was. */
const filterJson = (
  text: string,
  filter: (value: Record<string, unknown>) => Record<string, unknown>,
) =>
  decodeJson(text).pipe(
    Effect.flatMap((value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? encodeJson(filter({ ...value }))
        : Effect.succeed(text),
    ),
    Effect.orElseSucceed(() => text),
  );

function withoutKeys(
  value: unknown,
  drop: (key: string) => boolean,
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const kept = Object.fromEntries(Object.entries(value).filter(([key]) => !drop(key)));
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * A session-scoped directory for one plain home. Each session gets its own, so concurrent
 * threads never rebuild a home another is running on; it is removed when the session ends.
 */
export const gentleAiOffDirectory = (agent: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return path.join(NodeOS.tmpdir(), "t3code-gentle-off", `${agent}-${NodeCrypto.randomUUID()}`);
    }),
    (directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore);
      }),
  );

/**
 * A plain CODEX_HOME: no gentle-ai instructions, skills, hooks, MCP servers, or profiles. A
 * `footprint` from gentle-ai decides exactly what that is; without one, the built-in lists do.
 */
export const materializeCodexPlainHome = Effect.fn("materializeCodexPlainHome")(function* (input: {
  readonly source: string;
  readonly target: string;
  readonly platform: NodeJS.Platform;
  readonly userHome: string;
  readonly footprint?: GentleAiPlainFootprint | null;
}) {
  const path = yield* Path.Path;
  if (input.footprint) {
    return yield* materializePlainMirror({
      source: input.source,
      target: input.target,
      platform: input.platform,
      plan: footprintPlan(input.footprint, input.source, path, input.platform),
    });
  }
  const mcpServers = gentleAiMcpServers(yield* installedComponents(input.userHome));
  const agents = yield* readText(path.join(input.source, "AGENTS.md"));
  const config = yield* readText(path.join(input.source, "config.toml"));
  const hooksText = yield* readText(path.join(input.source, "hooks.json"));
  const hooks =
    hooksText === null
      ? null
      : yield* filterJson(hooksText, (value) => ({
          ...value,
          ...(value.hooks === undefined ? {} : { hooks: withoutGentleAiHooks(value.hooks) ?? {} }),
        }));
  yield* materializePlainMirror({
    source: input.source,
    target: input.target,
    platform: input.platform,
    plan: (name): PlainEntry => {
      if (name === "AGENTS.md" && agents !== null)
        return { kind: "write", content: withoutGentleAiInstructions(agents) };
      if (name === "config.toml" && config !== null)
        return { kind: "write", content: withoutGentleAiCodexConfig(config, mcpServers) };
      if (name === "hooks.json" && hooks !== null) return { kind: "write", content: hooks };
      if (name === "skills")
        return { kind: "filter", keep: (skill) => !GENTLE_AI_SKILLS.has(skill) };
      if (
        name === "engram-instructions.md" ||
        name === "engram-compact-prompt.md" ||
        /^sdd-(?:strong|mid|cheap)\.config\.toml$/.test(name)
      )
        return { kind: "omit" };
      return { kind: "link" };
    },
  });
});

/**
 * A plain OpenCode config directory (`<XDG_CONFIG_HOME>/opencode`): no gentle-ai agents,
 * commands, plugins, skills, prompts, themes, or MCP servers.
 */
export const materializeOpenCodePlainConfig = Effect.fn("materializeOpenCodePlainConfig")(
  function* (input: {
    readonly source: string;
    readonly target: string;
    readonly platform: NodeJS.Platform;
    readonly userHome: string;
    readonly footprint?: GentleAiPlainFootprint | null;
  }) {
    const path = yield* Path.Path;
    if (input.footprint) {
      return yield* materializePlainMirror({
        source: input.source,
        target: input.target,
        platform: input.platform,
        plan: footprintPlan(input.footprint, input.source, path, input.platform),
      });
    }
    const mcpServers = gentleAiMcpServers(yield* installedComponents(input.userHome));
    const settingsFiles = ["opencode.json", "opencode.jsonc", "config.json"];
    const settings = new Map<string, string>();
    for (const name of settingsFiles) {
      const text = yield* readText(path.join(input.source, name));
      if (text === null) continue;
      settings.set(
        name,
        yield* filterJson(text, (value) => {
          const agent = withoutKeys(value.agent, isGentleAiAgent);
          const mcp = withoutKeys(value.mcp, (key) => mcpServers.has(key));
          const next: Record<string, unknown> = { ...value };
          delete next.agent;
          delete next.mcp;
          if (agent) next.agent = agent;
          if (mcp) next.mcp = mcp;
          if (typeof next.default_agent === "string" && isGentleAiAgent(next.default_agent))
            delete next.default_agent;
          if (typeof next.theme === "string" && next.theme.startsWith("gentleman"))
            delete next.theme;
          return next;
        }),
      );
    }
    const agentsText = yield* readText(path.join(input.source, "AGENTS.md"));
    yield* materializePlainMirror({
      source: input.source,
      target: input.target,
      platform: input.platform,
      plan: (name): PlainEntry => {
        const filtered = settings.get(name);
        if (filtered !== undefined) return { kind: "write", content: filtered };
        if (name === "AGENTS.md" && agentsText !== null)
          return { kind: "write", content: withoutGentleAiInstructions(agentsText) };
        if (name === "skills" || name === "skill")
          return { kind: "filter", keep: (skill) => !GENTLE_AI_SKILLS.has(skill) };
        if (name === "commands" || name === "command")
          return { kind: "filter", keep: (file) => !GENTLE_AI_COMMAND_FILES.has(file) };
        if (name === "plugins" || name === "plugin")
          return { kind: "filter", keep: (file) => !GENTLE_AI_OPENCODE_PLUGINS.has(file) };
        if (name === "agents" || name === "agent")
          return { kind: "filter", keep: (file) => !isGentleAiAgent(file.replace(/\.md$/, "")) };
        if (name === "themes")
          return { kind: "filter", keep: (file) => !file.startsWith("gentleman") };
        if (name === "prompts") return { kind: "filter", keep: (entry) => entry !== "sdd" };
        if (name.startsWith(".gentle-ai-")) return { kind: "omit" };
        return { kind: "link" };
      },
    });
  },
);

/**
 * The environment an OpenCode server runs with when Gentle AI is off: a plain config home, and,
 * when gentle-ai also set up Claude Code, no Claude Code compatibility, which would otherwise
 * load gentle-ai's instructions and skills from ~/.claude.
 */
export const openCodeGentleOffEnvironment = Effect.fn("openCodeGentleOffEnvironment")(
  function* (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly platform: NodeJS.Platform;
    readonly footprint?: GentleAiPlainFootprint | null;
  }) {
    const path = yield* Path.Path;
    const userHome = hostUserHome(input.environment, input.platform);
    const configHome = input.environment.XDG_CONFIG_HOME?.trim() || path.join(userHome, ".config");
    const plainConfigHome = yield* gentleAiOffDirectory("opencode");
    yield* materializeOpenCodePlainConfig({
      source: path.join(configHome, "opencode"),
      target: path.join(plainConfigHome, "opencode"),
      platform: input.platform,
      userHome,
      footprint: input.footprint ?? null,
    });
    const claudeCode = (yield* installState(userHome)).installed_agents?.includes("claude-code");
    return {
      ...input.environment,
      XDG_CONFIG_HOME: plainConfigHome,
      ...(claudeCode
        ? { OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }
        : {}),
    } satisfies NodeJS.ProcessEnv;
  },
);

/** A Claude Code subagent passed to the SDK, parsed from the user's own agent file. */
export interface ClaudePlainAgent {
  readonly description: string;
  readonly prompt: string;
  // Mutable to match the SDK's AgentDefinition.
  readonly tools?: string[];
  readonly model?: string;
}

const ClaudeMcpServer = Schema.Union([
  Schema.Struct({
    type: Schema.optional(Schema.Literal("stdio")),
    command: Schema.String,
    args: Schema.optional(Schema.Array(Schema.String)),
    env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literals(["sse", "http"]),
    url: Schema.String,
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
]);
const decodeClaudeMcpServer = Schema.decodeUnknownOption(ClaudeMcpServer);

/** An MCP server in the shape the Claude Agent SDK takes. */
export type ClaudePlainMcpServer =
  | {
      type?: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { type: "sse" | "http"; url: string; headers?: Record<string, string> };

function toClaudeMcpServer(value: unknown): ClaudePlainMcpServer | null {
  const decoded = decodeClaudeMcpServer(value);
  if (decoded._tag === "None") return null;
  const server = decoded.value;
  if ("command" in server) {
    return {
      ...(server.type === undefined ? {} : { type: server.type }),
      command: server.command,
      ...(server.args === undefined ? {} : { args: [...server.args] }),
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
    };
  }
  return {
    type: server.type,
    url: server.url,
    ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
  };
}

/** What a Claude Code session loads instead of the user's settings when Gentle AI is off. */
export interface ClaudeGentleOffOptions {
  // The user's instructions (CLAUDE.md) without gentle-ai's sections.
  readonly instructions: string | null;
  // The user's settings.json without gentle-ai's hooks, output style, and theme.
  readonly settings: Record<string, unknown>;
  readonly agents: Record<string, ClaudePlainAgent>;
  // A local plugin holding the user's own skills and commands.
  readonly pluginPath: string | null;
  // The user's and approved project MCP servers without gentle-ai's; loaded strictly.
  readonly mcpServers: Record<string, ClaudePlainMcpServer>;
}

/** The frontmatter fields and body of an agent markdown file. */
function parseAgentFile(text: string): ClaudePlainAgent | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (field?.[1] && field[2] !== undefined)
      fields.set(field[1], field[2].trim().replace(/^["']|["']$/g, ""));
  }
  const description = fields.get("description");
  if (!description) return null;
  const tools = fields
    .get("tools")
    ?.split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  const model = fields.get("model");
  return {
    description,
    prompt: (match[2] ?? "").trim(),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(model ? { model } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

const readJsonRecord = (filePath: string) =>
  readText(filePath).pipe(
    Effect.flatMap((text) => (text === null ? Effect.succeed(null) : decodeJson(text))),
    Effect.map(asRecord),
    Effect.orElseSucceed((): Record<string, unknown> => ({})),
  );

const readDirectoryNames = (directory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  });

/**
 * Claude Code with Gentle AI off. Claude reads gentle-ai's footprint from its user settings
 * source, so the session drops that source and gets back the user's own pieces of it, filtered.
 * The config directory itself does not change, so sign-in and session history are untouched.
 */
export const claudeGentleOffOptions = Effect.fn("claudeGentleOffOptions")(function* (input: {
  readonly claudeHome: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly cwd: string | undefined;
  /** gentle-ai's own account of what it added; without one, the built-in lists decide. */
  readonly footprint?: GentleAiPlainFootprint | null;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const footprint = input.footprint ?? null;
  const userHome = hostUserHome(input.environment, input.platform);
  // Legacy only: with a footprint, gentle-ai's rewrites already leave its MCP servers out.
  const mcpNames = footprint
    ? new Set<string>()
    : gentleAiMcpServers(yield* installedComponents(userHome));
  /** A file's text as gentle-ai's uninstall would leave it; null when it would be gone. */
  const plainText = (filePath: string) =>
    readText(filePath).pipe(
      Effect.map((text) =>
        text === null || footprint === null
          ? text
          : plainContent(footprint, filePath, text, path, input.platform),
      ),
    );
  const ownedByGentleAi = (filePath: string) =>
    footprint !== null &&
    footprintPlan(
      footprint,
      path.dirname(filePath),
      path,
      input.platform,
    )(path.basename(filePath), false).kind === "omit";

  const claudeMd = yield* plainText(path.join(input.claudeHome, "CLAUDE.md"));
  const instructions =
    claudeMd === null
      ? null
      : (footprint ? claudeMd : withoutGentleAiInstructions(claudeMd)) || null;

  const settingsText = yield* plainText(path.join(input.claudeHome, "settings.json"));
  const settings =
    settingsText === null
      ? {}
      : yield* decodeJson(settingsText).pipe(
          Effect.map(asRecord),
          Effect.orElseSucceed((): Record<string, unknown> => ({})),
        );
  if (!footprint) {
    const hooks = withoutGentleAiHooks(settings.hooks);
    delete settings.hooks;
    if (hooks) settings.hooks = hooks;
    if (
      typeof settings.outputStyle === "string" &&
      /^(?:gentleman|neutral)$/i.test(settings.outputStyle)
    )
      delete settings.outputStyle;
    if (typeof settings.theme === "string" && settings.theme.startsWith("gentleman"))
      delete settings.theme;
    const plugins = withoutKeys(
      settings.enabledPlugins,
      (key) => mcpNames.has("engram") && key.startsWith("engram@"),
    );
    delete settings.enabledPlugins;
    if (plugins) settings.enabledPlugins = plugins;
  }

  const agents: Record<string, ClaudePlainAgent> = {};
  const agentsDirectory = path.join(input.claudeHome, "agents");
  for (const file of yield* readDirectoryNames(agentsDirectory)) {
    const name = file.replace(/\.md$/, "");
    const agentPath = path.join(agentsDirectory, file);
    if (!file.endsWith(".md")) continue;
    if (footprint ? ownedByGentleAi(agentPath) : isGentleAiAgent(name)) continue;
    const text = yield* readText(agentPath);
    const agent = text === null ? null : parseAgentFile(text);
    if (agent) agents[name] = agent;
  }

  // Skills and commands have no programmatic SDK channel, so they return as a local plugin.
  const skillsDirectory = path.join(input.claudeHome, "skills");
  const commandsDirectory = path.join(input.claudeHome, "commands");
  const skillsPlan: (name: string, directory: boolean) => PlainEntry = footprint
    ? footprintPlan(footprint, skillsDirectory, path, input.platform)
    : (skill) => (GENTLE_AI_SKILLS.has(skill) ? { kind: "omit" } : { kind: "link" });
  const commandsPlan: (name: string, directory: boolean) => PlainEntry = footprint
    ? footprintPlan(footprint, commandsDirectory, path, input.platform)
    : (command) => (GENTLE_AI_COMMAND_FILES.has(command) ? { kind: "omit" } : { kind: "link" });
  const userSkills = (yield* readDirectoryNames(skillsDirectory)).filter(
    (skill) => skillsPlan(skill, true).kind !== "omit",
  );
  const userCommands = (yield* readDirectoryNames(commandsDirectory)).filter(
    (command) => command.endsWith(".md") && commandsPlan(command, false).kind !== "omit",
  );
  let pluginPath: string | null = null;
  if (userSkills.length > 0 || userCommands.length > 0) {
    pluginPath = yield* gentleAiOffDirectory("claude-plugin");
    yield* fileSystem.makeDirectory(path.join(pluginPath, ".claude-plugin"), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(pluginPath, ".claude-plugin", "plugin.json"),
      yield* encodeJson({ name: "user", description: "Your own skills and commands." }),
    );
    yield* materializePlainMirror({
      source: skillsDirectory,
      target: path.join(pluginPath, "skills"),
      platform: input.platform,
      plan: skillsPlan,
    });
    yield* materializePlainMirror({
      source: commandsDirectory,
      target: path.join(pluginPath, "commands"),
      platform: input.platform,
      plan: commandsPlan,
    });
  }

  // User MCP servers live in .claude.json: inside a custom config directory, else in the home.
  const userConfigText = yield* plainText(
    input.environment.CLAUDE_CONFIG_DIR?.trim()
      ? path.join(input.claudeHome, ".claude.json")
      : path.join(userHome, ".claude.json"),
  );
  const userConfig =
    userConfigText === null
      ? {}
      : yield* decodeJson(userConfigText).pipe(
          Effect.map(asRecord),
          Effect.orElseSucceed((): Record<string, unknown> => ({})),
        );
  const project = input.cwd ? asRecord(asRecord(userConfig.projects)[input.cwd]) : {};
  const mcpServers: Record<string, unknown> = {
    ...asRecord(userConfig.mcpServers),
    ...asRecord(project.mcpServers),
  };
  // Project .mcp.json servers the user approved still load, as they would normally.
  if (input.cwd) {
    const approved = Array.isArray(project.enabledMcpjsonServers)
      ? project.enabledMcpjsonServers
      : [];
    const projectServers = asRecord(
      (yield* readJsonRecord(path.join(input.cwd, ".mcp.json"))).mcpServers,
    );
    for (const [name, server] of Object.entries(projectServers)) {
      if (project.enableAllProjectMcpServers === true || approved.includes(name))
        mcpServers[name] = server;
    }
  }
  const servers: Record<string, ClaudePlainMcpServer> = {};
  for (const [name, server] of Object.entries(mcpServers)) {
    const config = mcpNames.has(name) ? null : toClaudeMcpServer(server);
    if (config) servers[name] = config;
  }

  return {
    instructions,
    settings,
    agents,
    pluginPath,
    mcpServers: servers,
  } satisfies ClaudeGentleOffOptions;
});

/**
 * A plain Antigravity GEMINI_HOME. T3 Code already runs Antigravity on a private profile, so
 * gentle-ai reaches it only through the user skill folders linked into it; the mirror links
 * the profile's own state and narrows those two folders to the user's own skills.
 */
export const materializeAntigravityPlainHome = Effect.fn("materializeAntigravityPlainHome")(
  function* (input: {
    readonly source: string;
    readonly target: string;
    readonly platform: NodeJS.Platform;
  }) {
    const path = yield* Path.Path;
    const skillParents = new Set(["config", "antigravity-cli"]);
    yield* materializePlainMirror({
      source: input.source,
      target: input.target,
      platform: input.platform,
      plan: (name) => (skillParents.has(name) ? { kind: "omit" } : { kind: "link" }),
    });
    for (const parent of skillParents) {
      yield* materializePlainMirror({
        source: path.join(input.source, parent),
        target: path.join(input.target, parent),
        platform: input.platform,
        plan: (name) =>
          name === "skills"
            ? { kind: "filter", keep: (skill) => !GENTLE_AI_SKILLS.has(skill) }
            : { kind: "link" },
      });
    }
  },
);

/**
 * The environment a Cursor agent runs with when Gentle AI is off. Cursor has no config
 * directory setting, so the agent gets a mirror of the user's home as HOME: every entry is
 * linked back, and the folders Cursor reads gentle-ai's footprint from are filtered. Cursor's
 * sign-in lives outside HOME on Windows (%APPDATA%) and Linux (XDG config, pinned here); on macOS
 * it is in the login keychain under HOME, so Gentle AI cannot be turned off there.
 */
export const cursorGentleOffEnvironment = Effect.fn("cursorGentleOffEnvironment")(
  function* (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly platform: NodeJS.Platform;
    /** Every set-up agent's footprint: Cursor also reads the Claude and Codex folders. */
    readonly footprint?: GentleAiPlainFootprint | null;
  }) {
    const path = yield* Path.Path;
    if (input.platform === "darwin") {
      return yield* new PlainConfigMirrorError({
        detail:
          "Gentle AI cannot be turned off for Cursor on macOS, where its sign-in is tied to your home folder.",
      });
    }
    const userHome = hostUserHome(input.environment, input.platform);
    const plainEnvironment = (home: string) =>
      ({
        ...input.environment,
        HOME: home,
        ...(input.platform === "win32"
          ? { USERPROFILE: home }
          : {
              XDG_CONFIG_HOME:
                input.environment.XDG_CONFIG_HOME?.trim() || path.join(userHome, ".config"),
            }),
      }) satisfies NodeJS.ProcessEnv;
    if (input.footprint) {
      const home = yield* gentleAiOffDirectory("cursor");
      yield* materializePlainMirror({
        source: userHome,
        target: home,
        platform: input.platform,
        plan: footprintPlan(input.footprint, userHome, path, input.platform),
        skipUnlinkable: true,
      });
      return plainEnvironment(home);
    }
    const mcpServers = gentleAiMcpServers(yield* installedComponents(userHome));
    const mcpText = yield* readText(path.join(userHome, ".cursor", "mcp.json"));
    const mcp =
      mcpText === null
        ? null
        : yield* filterJson(mcpText, (value) => {
            const servers = withoutKeys(value.mcpServers, (key) => mcpServers.has(key));
            const next: Record<string, unknown> = { ...value };
            delete next.mcpServers;
            if (servers) next.mcpServers = servers;
            return next;
          });
    const home = yield* gentleAiOffDirectory("cursor");
    const filtered = new Set([".cursor", ".claude", ".codex", ".agents"]);
    yield* materializePlainMirror({
      source: userHome,
      target: home,
      platform: input.platform,
      plan: (name) => (filtered.has(name) ? { kind: "omit" } : { kind: "link" }),
      skipUnlinkable: true,
    });
    const skills: PlainEntry = { kind: "filter", keep: (skill) => !GENTLE_AI_SKILLS.has(skill) };
    for (const name of filtered) {
      yield* materializePlainMirror({
        source: path.join(userHome, name),
        target: path.join(home, name),
        platform: input.platform,
        plan: (entry): PlainEntry => {
          if (entry === "skills") return skills;
          if (name !== ".cursor") return { kind: "link" };
          if (entry === "mcp.json" && mcp !== null) return { kind: "write", content: mcp };
          if (entry === "rules")
            return { kind: "filter", keep: (rule) => rule !== "gentle-ai.mdc" };
          if (entry === "agents")
            return { kind: "filter", keep: (file) => !isGentleAiAgent(file.replace(/\.md$/, "")) };
          return { kind: "link" };
        },
      });
    }
    return plainEnvironment(home);
  },
);
