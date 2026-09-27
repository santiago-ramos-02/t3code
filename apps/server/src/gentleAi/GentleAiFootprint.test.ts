import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  gentleAiMcpServers,
  GENTLE_AI_SKILLS,
  isGentleAiAgent,
  isGentleAiHookCommand,
  withoutGentleAiCodexConfig,
  withoutGentleAiHooks,
  withoutGentleAiInstructions,
} from "./GentleAiFootprint.ts";
import { materializePlainMirror } from "./PlainConfigMirror.ts";

describe("gentle-ai footprint", () => {
  it("removes gentle-ai's marked sections and keeps the user's own instructions", () => {
    const markdown = [
      "# My rules",
      "Always use tabs.",
      "",
      "<!-- gentle-ai:persona -->",
      "## Personality",
      "<!-- /gentle-ai:persona -->",
      "",
      "Prefer small PRs.",
      "<!-- gentle-ai:sdd-orchestrator -->",
      "Run SDD phases.",
      "<!-- /gentle-ai:sdd-orchestrator -->",
    ].join("\n");
    expect(withoutGentleAiInstructions(markdown)).toBe(
      "# My rules\nAlways use tabs.\n\nPrefer small PRs.",
    );
  });

  it("drops the unmarked persona preamble gentle-ai writes where it owns the file", () => {
    const codexAgents =
      "## Personality\nSenior Architect\n## Rules\nBe kind.\n\n<!-- gentle-ai:engram-protocol -->\nx\n<!-- /gentle-ai:engram-protocol -->\n";
    expect(withoutGentleAiInstructions(codexAgents)).toBe("");
  });

  it("recognises gentle-ai hooks and removes only them", () => {
    expect(isGentleAiHookCommand("gentle-ai review stop-hook --agent claude-code")).toBe(true);
    expect(
      isGentleAiHookCommand(
        'powershell -NoProfile -Command "& gentle-ai skill-registry refresh --quiet"',
      ),
    ).toBe(true);
    expect(isGentleAiHookCommand("npx prettier --write .")).toBe(false);
    expect(
      withoutGentleAiHooks({
        Stop: [
          {
            hooks: [
              { type: "command", command: "gentle-ai review stop-hook --agent claude-code" },
              { type: "command", command: "say done" },
            ],
          },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "gentle-ai skill-registry refresh || true" }] },
        ],
      }),
    ).toEqual({ Stop: [{ hooks: [{ type: "command", command: "say done" }] }] });
  });

  it("removes gentle-ai's Codex entries and leaves other tables alone", () => {
    const toml = [
      'model = "gpt-6"',
      'model_instructions_file = "/home/me/.codex/engram-instructions.md"',
      "",
      "[mcp_servers.engram]",
      'command = "engram"',
      "[mcp_servers.engram.env]",
      'X = "1"',
      "",
      "[mcp_servers.github]",
      'command = "gh-mcp"',
    ].join("\n");
    expect(withoutGentleAiCodexConfig(toml, gentleAiMcpServers(["engram"]))).toBe(
      ['model = "gpt-6"', "", "[mcp_servers.github]", 'command = "gh-mcp"'].join("\n"),
    );
  });

  it("names gentle-ai's agents, skills, and MCP servers", () => {
    expect(isGentleAiAgent("sdd-apply")).toBe(true);
    expect(isGentleAiAgent("sdd-apply-cheap")).toBe(true);
    expect(isGentleAiAgent("my-reviewer")).toBe(false);
    expect(GENTLE_AI_SKILLS.has("judgment-day")).toBe(true);
    // A user's own context7 survives when gentle-ai did not install one.
    expect([...gentleAiMcpServers(["engram", "sdd"])]).toEqual(["engram"]);
  });
});

it.layer(NodeServices.layer)("plain config mirror", (it) => {
  it.effect(
    "links shared state, omits and narrows gentle-ai entries, and never deletes through a link",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const platform = yield* HostProcessPlatform;
          const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-plain-mirror-" });
          const source = path.join(root, "home");
          const target = path.join(root, "plain");
          yield* fileSystem.makeDirectory(path.join(source, "sessions"), { recursive: true });
          yield* fileSystem.writeFileString(path.join(source, "sessions", "a.jsonl"), "{}");
          yield* fileSystem.makeDirectory(path.join(source, "skills", "sdd-apply"), {
            recursive: true,
          });
          yield* fileSystem.makeDirectory(path.join(source, "skills", "mine"), { recursive: true });
          yield* fileSystem.writeFileString(path.join(source, "auth.json"), '{"token":"x"}');
          yield* fileSystem.writeFileString(path.join(source, "AGENTS.md"), "gentle");
          yield* fileSystem.writeFileString(path.join(source, "engram-instructions.md"), "x");

          const build = materializePlainMirror({
            source,
            target,
            platform,
            plan: (name) =>
              name === "AGENTS.md"
                ? { kind: "write", content: "mine" }
                : name === "engram-instructions.md"
                  ? { kind: "omit" }
                  : name === "skills"
                    ? { kind: "filter", keep: (skill) => !GENTLE_AI_SKILLS.has(skill) }
                    : { kind: "link" },
          });
          yield* build;
          expect(yield* fileSystem.readFileString(path.join(target, "AGENTS.md"))).toBe("mine");
          expect(yield* fileSystem.readFileString(path.join(target, "auth.json"))).toBe(
            '{"token":"x"}',
          );
          expect(yield* fileSystem.exists(path.join(target, "sessions", "a.jsonl"))).toBe(true);
          expect(yield* fileSystem.exists(path.join(target, "engram-instructions.md"))).toBe(false);
          expect((yield* fileSystem.readDirectory(path.join(target, "skills"))).toSorted()).toEqual(
            ["mine"],
          );
          // Writes through a linked directory reach the real one, as the agent's sessions must.
          yield* fileSystem.writeFileString(path.join(target, "sessions", "b.jsonl"), "{}");
          expect(yield* fileSystem.exists(path.join(source, "sessions", "b.jsonl"))).toBe(true);

          // Rebuilding clears the mirror without touching the real directory behind its links.
          yield* build;
          expect(yield* fileSystem.exists(path.join(source, "sessions", "a.jsonl"))).toBe(true);
          expect(yield* fileSystem.exists(path.join(source, "skills", "sdd-apply"))).toBe(true);
          expect(yield* fileSystem.readFileString(path.join(source, "AGENTS.md"))).toBe("gentle");
          yield* fileSystem.remove(target, { recursive: true });
          expect(yield* fileSystem.exists(path.join(source, "sessions", "b.jsonl"))).toBe(true);
        }),
      ),
  );
});
