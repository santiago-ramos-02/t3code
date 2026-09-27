/**
 * What gentle-ai writes into each agent's configuration, and how to read that configuration
 * without it. A thread with Gentle AI off runs its agent on the user's own configuration minus
 * this footprint.
 *
 * gentle-ai keeps no manifest of the files it manages; its own uninstall recognises them the
 * same way, from asset names, markdown markers, and hook commands (gentle-ai v3.7
 * `internal/components/uninstall`). These rules follow that release; T3 Code supports
 * gentle-ai 3.5 through 3.7.
 *
 * @module gentleAi/GentleAiFootprint
 */

/** Skill directories gentle-ai installs into an agent's skills folder. */
export const GENTLE_AI_SKILLS: ReadonlySet<string> = new Set([
  "_shared",
  "branch-pr",
  "chained-pr",
  "cognitive-doc-design",
  "comment-writer",
  "gentle-ai-bench",
  "go-testing",
  "hermes-ephemeral-delegation",
  "issue-creation",
  "judgment-day",
  "rdd-defect-workflow",
  "sdd-apply",
  "sdd-archive",
  "sdd-design",
  "sdd-explore",
  "sdd-init",
  "sdd-onboard",
  "sdd-propose",
  "sdd-research",
  "sdd-spec",
  "sdd-tasks",
  "sdd-verify",
  "skill-creator",
  "skill-improver",
  "skill-registry",
  "systemic-issue-triage",
  "work-unit-commits",
]);

const SDD_PHASES = [
  "init",
  "explore",
  "research",
  "propose",
  "spec",
  "design",
  "tasks",
  "apply",
  "verify",
  "archive",
  "onboard",
];

/** Subagent names gentle-ai defines (agent files, and OpenCode agent keys). */
export const GENTLE_AI_AGENTS: ReadonlySet<string> = new Set([
  "gentleman",
  "gentle-orchestrator",
  "sdd-orchestrator",
  ...SDD_PHASES.map((phase) => `sdd-${phase}`),
  "jd-judge-a",
  "jd-judge-b",
  "jd-fix-agent",
  "review-readability",
  "review-refuter",
  "review-reliability",
  "review-resilience",
  "review-risk",
]);

/** Whether an agent name is gentle-ai's, including its per-profile `<agent>-<profile>` copies. */
export function isGentleAiAgent(name: string): boolean {
  if (GENTLE_AI_AGENTS.has(name)) return true;
  for (const agent of GENTLE_AI_AGENTS) {
    if (agent !== "gentleman" && name.startsWith(`${agent}-`)) return true;
  }
  return false;
}

/** Slash command files gentle-ai installs, by file name. */
export const GENTLE_AI_COMMAND_FILES: ReadonlySet<string> = new Set([
  // Claude Code prefixes its commands.
  ...[...SDD_PHASES, "continue", "ff", "new", "status"].map((name) => `gentle-sdd-${name}.md`),
  // OpenCode, and Claude Code before the prefix.
  ...[...SDD_PHASES, "continue", "ff", "new", "status"].map((name) => `sdd-${name}.md`),
  "skill-creator.md",
  "skill-registry.md",
]);

/** Whether a skill or slash command an agent reports, by name, is one gentle-ai installed. */
export function isGentleAiResource(name: string): boolean {
  return GENTLE_AI_SKILLS.has(name) || GENTLE_AI_COMMAND_FILES.has(`${name}.md`);
}

/** OpenCode plugin files gentle-ai installs. */
export const GENTLE_AI_OPENCODE_PLUGINS: ReadonlySet<string> = new Set([
  "model-variants.ts",
  "opencode-review-transport.ts",
  "sdd-task-result-artifacts.ts",
  "skill-registry.ts",
  "telemetry-runtime.ts",
  "background-agents.ts",
]);

/**
 * MCP servers gentle-ai registers, limited to the components it actually installed, so a
 * user's own server with the same name survives when gentle-ai did not add one.
 */
export function gentleAiMcpServers(components: ReadonlyArray<string>): ReadonlySet<string> {
  return new Set(["engram", "context7"].filter((component) => components.includes(component)));
}

const SECTION = /<!-- gentle-ai:([\w.-]+) -->[\s\S]*?<!-- \/gentle-ai:\1 -->\n?/g;
const LEGACY_SECTION = /<!-- BEGIN:agent-teams-lite -->[\s\S]*?<!-- END:agent-teams-lite -->\n?/g;
const PERSONA_FINGERPRINTS = ["## Personality", "Senior Architect", "## Rules"];

/**
 * An instructions file without gentle-ai's content: its marked sections, and the unmarked
 * persona preamble it writes ahead of them where it owns the file (Codex, Cursor).
 */
export function withoutGentleAiInstructions(markdown: string): string {
  const normalized = markdown.replaceAll("\r\n", "\n");
  const markerIndex = normalized.indexOf("<!-- gentle-ai:");
  let content = normalized;
  if (markerIndex > 0) {
    const prefix = normalized.slice(0, markerIndex);
    const isPersona =
      (prefix.includes("name: Gentle AI Persona") &&
        prefix.includes("description: Teaching-oriented persona")) ||
      PERSONA_FINGERPRINTS.every((fingerprint) => prefix.includes(fingerprint));
    if (isPersona) content = normalized.slice(markerIndex);
  }
  return content
    .replace(SECTION, "")
    .replace(LEGACY_SECTION, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Whether a hook runs gentle-ai (skill registry refresh, review, SDD preflight, telemetry). */
export function isGentleAiHookCommand(command: string): boolean {
  return /(?:^|[\s"'`;&|(\\/])gentle-ai(?:\.exe)?["']?\s/.test(command);
}

type HookEntry = { readonly hooks?: ReadonlyArray<{ readonly command?: unknown }> };

/**
 * A hooks map (Claude Code settings.json `hooks`, Codex hooks.json) without gentle-ai's hooks.
 * Matcher groups left with no hooks are dropped, then events left with no groups.
 */
export function withoutGentleAiHooks(hooks: unknown): Record<string, unknown> | undefined {
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      result[event] = groups;
      continue;
    }
    const kept = groups.flatMap((group: HookEntry) => {
      if (group === null || typeof group !== "object" || !Array.isArray(group.hooks))
        return [group];
      const remaining = group.hooks.filter(
        (hook) => typeof hook?.command !== "string" || !isGentleAiHookCommand(hook.command),
      );
      return remaining.length === 0 ? [] : [{ ...group, hooks: remaining }];
    });
    if (kept.length > 0) result[event] = kept;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * A Codex config.toml without gentle-ai's entries: its MCP server tables and the instruction
 * files it points Codex at. Line-based, like gentle-ai's own uninstall.
 */
export function withoutGentleAiCodexConfig(toml: string, mcpServers: ReadonlySet<string>): string {
  const lines = toml.replaceAll("\r\n", "\n").split("\n");
  const kept: string[] = [];
  let skipping = false;
  let inTable = false;
  for (const line of lines) {
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line)?.[1];
    if (header !== undefined) {
      inTable = true;
      skipping = [...mcpServers].some(
        (server) =>
          header === `mcp_servers.${server}` || header.startsWith(`mcp_servers.${server}.`),
      );
    }
    if (skipping) continue;
    if (
      !inTable &&
      /^\s*(?:model_instructions_file|experimental_compact_prompt_file)\s*=/.test(line) &&
      /engram-(?:instructions|compact-prompt)\.md/.test(line)
    ) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}
