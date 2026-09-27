import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import { GentleAiFootprints, layer } from "./GentleAiFootprints.ts";
import { footprintKey } from "./PlainFootprint.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("GentleAiFootprints", (it) => {
  it.effect("asks gentle-ai about the agents it set up, and falls back when it cannot tell", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcessPlatform;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gentle-footprint-" });
        const skill = path.join(home, ".claude", "skills", "judgment-day");
        const settings = path.join(home, ".claude", "settings.json");
        const script = path.join(home, "fake-gentle-ai.cjs");
        // gentle-ai answers for the set-up agents it is asked about: Claude's footprint is
        // complete, OpenCode was not set up, Codex's reaches outside the home, and asking about
        // Cursor stands for an older gentle-ai without the method.
        yield* fileSystem.writeFileString(
          script,
          `const fs = require("node:fs");
const [, method] = process.argv.slice(2);
const { agents } = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const line = (value) => process.stdout.write(JSON.stringify({ schema: "gentle-ai.api/v1", ...value }) + "\\n");
const ask = agents ?? ["claude-code"];
if (method !== "footprint" || ask.includes("cursor")) line({ type: "error", error: { code: "unsupported", message: "unknown method" } });
else if (ask.includes("codex")) line({ type: "result", data: { agents: ask, removed: [], rewritten: [], unsimulated: ["/etc/xdg/codex"] } });
else if (ask.includes("claude-code")) line({ type: "result", data: { agents: ask, removed: [${encodeJson(skill)}], rewritten: [{ path: ${encodeJson(settings)}, content: "{}" }], unsimulated: [] } });
else line({ type: "result", data: { agents: [], removed: [], rewritten: [], unsimulated: [] } });
`,
        );
        const binary = path.join(home, platform === "win32" ? "gentle-ai.cmd" : "gentle-ai");
        yield* fileSystem.writeFileString(
          binary,
          platform === "win32"
            ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
            : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`,
        );
        if (platform !== "win32") yield* fileSystem.chmod(binary, 0o755);

        const context = yield* Layer.build(
          layer.pipe(Layer.provide(ServerSettings.layerTest({ gentleAiBinaryPath: binary }))),
        ).pipe(
          Effect.provideService(HostProcessEnvironment, {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
          }),
        );
        const footprints = Context.get(context, GentleAiFootprints);

        const claude = yield* footprints.forAgents(["claude-code"]);
        expect(claude?.removed).toEqual(new Set([footprintKey(path, skill, platform)]));
        expect(claude?.rewritten).toEqual(
          new Map([[footprintKey(path, settings, platform), "{}"]]),
        );
        // An agent gentle-ai did not set up has nothing of it, so nothing is filtered.
        const opencode = yield* footprints.forAgents(["opencode"]);
        expect(opencode?.removed.size).toBe(0);
        expect(opencode?.rewritten.size).toBe(0);
        // A footprint that could not be simulated, or an older gentle-ai, means the built-in lists.
        expect(yield* footprints.forAgents(["codex"])).toBeNull();
        expect(yield* footprints.forAgents(["cursor"])).toBeNull();
        // Every set-up agent is gentle-ai's default.
        expect((yield* footprints.forAgents("set-up"))?.removed.size).toBe(1);
      }),
    ),
  );
});
