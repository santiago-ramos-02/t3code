import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  claudeGentleOffOptions,
  cursorGentleOffEnvironment,
  materializeCodexPlainHome,
  materializeOpenCodePlainConfig,
} from "./GentleAiOff.ts";
import { footprintKey, type GentleAiPlainFootprint } from "./PlainFootprint.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const GENTLE_SECTION =
  "<!-- gentle-ai:sdd-orchestrator -->\nRun SDD.\n<!-- /gentle-ai:sdd-orchestrator -->";

/** A user home where gentle-ai set up engram, next to the user's own configuration. */
const makeHome = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gentle-off-" });
  const write = (relative: string, content: string) =>
    Effect.gen(function* () {
      const file = path.join(home, relative);
      yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
      yield* fileSystem.writeFileString(file, content);
    });
  yield* write(
    ".gentle-ai/state.json",
    encodeJson({ components: ["engram", "sdd"], installed_agents: ["claude-code", "codex"] }),
  );
  return { home, write, path, fileSystem };
});

it.layer(NodeServices.layer)("Gentle AI off", (it) => {
  it.effect("gives Codex a home with the user's configuration and none of gentle-ai's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { home, write, path, fileSystem } = yield* makeHome;
        const platform = yield* HostProcess.Platform;
        const codex = path.join(home, ".codex");
        yield* write(".codex/AGENTS.md", `Use tabs.\n\n${GENTLE_SECTION}\n`);
        yield* write(
          ".codex/config.toml",
          'model = "gpt-6"\n\n[mcp_servers.engram]\ncommand = "engram"\n\n[mcp_servers.github]\ncommand = "gh"\n',
        );
        yield* write(".codex/auth.json", '{"token":"x"}');
        yield* write(".codex/engram-instructions.md", "engram");
        yield* write(".codex/skills/sdd-apply/SKILL.md", "gentle");
        yield* write(".codex/skills/mine/SKILL.md", "mine");
        const target = path.join(home, "plain-codex");
        yield* materializeCodexPlainHome({ source: codex, target, platform, userHome: home });

        expect(yield* fileSystem.readFileString(path.join(target, "AGENTS.md"))).toBe("Use tabs.");
        const config = yield* fileSystem.readFileString(path.join(target, "config.toml"));
        expect(config).toContain("[mcp_servers.github]");
        expect(config).not.toContain("engram");
        expect(yield* fileSystem.readFileString(path.join(target, "auth.json"))).toBe(
          '{"token":"x"}',
        );
        expect(yield* fileSystem.exists(path.join(target, "engram-instructions.md"))).toBe(false);
        expect(yield* fileSystem.readDirectory(path.join(target, "skills"))).toEqual(["mine"]);
      }),
    ),
  );

  it.effect("gives OpenCode a config without gentle-ai's agents, plugins, commands, or MCP", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { home, write, path, fileSystem } = yield* makeHome;
        const platform = yield* HostProcess.Platform;
        yield* write(
          ".config/opencode/opencode.json",
          encodeJson({
            default_agent: "gentle-orchestrator",
            agent: { "gentle-orchestrator": {}, "sdd-apply-cheap": {}, mine: { model: "x" } },
            mcp: { engram: { type: "local" }, github: { type: "remote" } },
            theme: "gentleman",
          }),
        );
        yield* write(".config/opencode/plugins/skill-registry.ts", "gentle");
        yield* write(".config/opencode/plugins/mine.ts", "mine");
        yield* write(".config/opencode/commands/sdd-new.md", "gentle");
        yield* write(".config/opencode/commands/deploy.md", "mine");
        const target = path.join(home, "plain-opencode");
        yield* materializeOpenCodePlainConfig({
          source: path.join(home, ".config", "opencode"),
          target,
          platform,
          userHome: home,
        });

        expect(
          decodeJson(yield* fileSystem.readFileString(path.join(target, "opencode.json"))),
        ).toEqual({ agent: { mine: { model: "x" } }, mcp: { github: { type: "remote" } } });
        expect(yield* fileSystem.readDirectory(path.join(target, "plugins"))).toEqual(["mine.ts"]);
        expect(yield* fileSystem.readDirectory(path.join(target, "commands"))).toEqual([
          "deploy.md",
        ]);
      }),
    ),
  );

  it.effect("gives Claude the user's own instructions, settings, agents, skills, and MCP", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { home, write, path, fileSystem } = yield* makeHome;
        const platform = yield* HostProcess.Platform;
        const claudeHome = path.join(home, ".claude");
        yield* write(".claude/CLAUDE.md", `Be brief.\n\n${GENTLE_SECTION}\n`);
        yield* write(
          ".claude/settings.json",
          encodeJson({
            outputStyle: "Gentleman",
            model: "opus",
            hooks: {
              Stop: [{ hooks: [{ type: "command", command: "gentle-ai review stop-hook" }] }],
              PostToolUse: [{ hooks: [{ type: "command", command: "prettier --write" }] }],
            },
          }),
        );
        yield* write(".claude/agents/sdd-apply.md", "---\ndescription: gentle\n---\nx");
        yield* write(
          ".claude/agents/reviewer.md",
          "---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\n---\nReview it.",
        );
        yield* write(".claude/skills/judgment-day/SKILL.md", "gentle");
        yield* write(".claude/skills/mine/SKILL.md", "mine");
        yield* write(".claude/commands/gentle-sdd-new.md", "gentle");
        yield* write(".claude/commands/ship.md", "mine");
        yield* write(
          ".claude.json",
          encodeJson({
            mcpServers: { engram: { command: "engram" }, github: { command: "gh", args: ["mcp"] } },
          }),
        );

        const options = yield* claudeGentleOffOptions({
          claudeHome,
          environment: { HOME: home, USERPROFILE: home },
          platform,
          cwd: undefined,
        });
        expect(options.instructions).toBe("Be brief.");
        expect(options.settings).toEqual({
          model: "opus",
          hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "prettier --write" }] }] },
        });
        expect(options.agents).toEqual({
          reviewer: { description: "Reviews code", prompt: "Review it.", tools: ["Read", "Grep"] },
        });
        expect(options.mcpServers).toEqual({ github: { command: "gh", args: ["mcp"] } });
        const plugin = options.pluginPath ?? "";
        expect(yield* fileSystem.readDirectory(path.join(plugin, "skills"))).toEqual(["mine"]);
        expect(yield* fileSystem.readDirectory(path.join(plugin, "commands"))).toEqual(["ship.md"]);
      }),
    ),
  );

  it.effect("follows gentle-ai's footprint over the built-in lists, down to nested files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { home, write, path, fileSystem } = yield* makeHome;
        const platform = yield* HostProcess.Platform;
        const codex = path.join(home, ".codex");
        yield* write(".codex/AGENTS.md", "Use tabs.\n\ngentle-ai's part\n");
        yield* write(".codex/auth.json", '{"token":"x"}');
        yield* write(".codex/skills/_shared/gentle.md", "gentle");
        yield* write(".codex/skills/_shared/mine.md", "mine");
        yield* write(".codex/skills/judgment-day/SKILL.md", "gentle");
        // A gentle-ai name the footprint does not claim stays: gentle-ai decides, not the name.
        yield* write(".codex/skills/sdd-apply/SKILL.md", "kept");
        const key = (relative: string) => footprintKey(path, path.join(codex, relative), platform);
        const footprint: GentleAiPlainFootprint = {
          removed: new Set([key("skills/_shared/gentle.md"), key("skills/judgment-day")]),
          rewritten: new Map([[key("AGENTS.md"), "Use tabs."]]),
        };
        const target = path.join(home, "plain-codex");
        yield* materializeCodexPlainHome({
          source: codex,
          target,
          platform,
          userHome: home,
          footprint,
        });

        expect(yield* fileSystem.readFileString(path.join(target, "AGENTS.md"))).toBe("Use tabs.");
        expect(yield* fileSystem.readFileString(path.join(target, "auth.json"))).toBe(
          '{"token":"x"}',
        );
        expect((yield* fileSystem.readDirectory(path.join(target, "skills"))).toSorted()).toEqual([
          "_shared",
          "sdd-apply",
        ]);
        expect(yield* fileSystem.readDirectory(path.join(target, "skills", "_shared"))).toEqual([
          "mine.md",
        ]);
      }),
    ),
  );

  it.effect("builds Claude's plain options from gentle-ai's footprint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { home, write, path, fileSystem } = yield* makeHome;
        const platform = yield* HostProcess.Platform;
        const claudeHome = path.join(home, ".claude");
        yield* write(".claude/CLAUDE.md", "Be brief.\n\norchestrator\n");
        yield* write(".claude/settings.json", encodeJson({ model: "opus", theme: "dark" }));
        yield* write(".claude/agents/review-risk.md", "---\ndescription: gentle\n---\nx");
        yield* write(".claude/agents/review-refuter.md", "---\ndescription: Mine now\n---\ny");
        yield* write(".claude/skills/judgment-day/SKILL.md", "gentle");
        yield* write(".claude/skills/mine/SKILL.md", "mine");
        yield* write(
          ".claude.json",
          encodeJson({ mcpServers: { context7: { command: "c7" }, github: { command: "gh" } } }),
        );
        const key = (file: string) => footprintKey(path, file, platform);
        const footprint: GentleAiPlainFootprint = {
          removed: new Set([
            key(path.join(claudeHome, "agents", "review-risk.md")),
            key(path.join(claudeHome, "skills", "judgment-day")),
          ]),
          rewritten: new Map([
            [key(path.join(claudeHome, "CLAUDE.md")), "Be brief.\n"],
            [key(path.join(claudeHome, "settings.json")), encodeJson({ model: "opus" })],
            [
              key(path.join(home, ".claude.json")),
              encodeJson({ mcpServers: { github: { command: "gh" } } }),
            ],
          ]),
        };

        const options = yield* claudeGentleOffOptions({
          claudeHome,
          environment: { HOME: home, USERPROFILE: home },
          platform,
          cwd: undefined,
          footprint,
        });
        expect(options.instructions).toBe("Be brief.\n");
        expect(options.settings).toEqual({ model: "opus" });
        expect(Object.keys(options.agents)).toEqual(["review-refuter"]);
        expect(options.mcpServers).toEqual({ github: { command: "gh" } });
        const plugin = options.pluginPath ?? "";
        expect(yield* fileSystem.readDirectory(path.join(plugin, "skills"))).toEqual(["mine"]);
      }),
    ),
  );

  it.effect("runs Cursor on a filtered home, and refuses on macOS where sign-in follows HOME", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { home, write, path, fileSystem } = yield* makeHome;
        const platform = yield* HostProcess.Platform;
        yield* write(".cursor/rules/gentle-ai.mdc", "gentle");
        yield* write(".cursor/rules/mine.mdc", "mine");
        yield* write(".claude/skills/sdd-apply/SKILL.md", "gentle");
        yield* write(".gitconfig", "[user]\n");
        const environment = { HOME: home, USERPROFILE: home };
        if (platform === "darwin") {
          const error = yield* Effect.flip(cursorGentleOffEnvironment({ environment, platform }));
          expect(error).toMatchObject({
            _tag: "PlainConfigMirrorError",
            detail: expect.stringContaining("macOS"),
          });
          return;
        }
        const next = yield* cursorGentleOffEnvironment({ environment, platform });
        const plainHome = next.HOME ?? "";
        expect(plainHome).not.toBe(home);
        expect(yield* fileSystem.readDirectory(path.join(plainHome, ".cursor", "rules"))).toEqual([
          "mine.mdc",
        ]);
        expect(yield* fileSystem.readDirectory(path.join(plainHome, ".claude", "skills"))).toEqual(
          [],
        );
        expect(yield* fileSystem.readFileString(path.join(plainHome, ".gitconfig"))).toBe(
          "[user]\n",
        );
      }),
    ),
  );
});
