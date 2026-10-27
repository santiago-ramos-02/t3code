#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import { BoatError, BoatSettings } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import { makeBoatApi } from "../src/boat/BoatApi.ts";
import { buildTemplate } from "../src/boat/boatTemplate.ts";

const LATEST_RELEASE_URL =
  "https://api.github.com/repos/santiago-ramos-02/t3code/releases?per_page=1";

const decodeSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ settings: BoatSettings })),
);
const Releases = Schema.Array(Schema.Struct({ tag_name: Schema.String }));

/** The newest fork release's T3 Code version, nightly or stable. */
const latestT3Version = Effect.gen(function* () {
  const response = yield* HttpClient.get(LATEST_RELEASE_URL);
  const [release] = yield* HttpClientResponse.schemaBodyJson(Releases)(response);
  if (release === undefined) {
    return yield* new BoatError({ detail: "The fork has no published release." });
  }
  return release.tag_name.replace(/^(personal-)?v/, "");
});

export const updateBoatTemplateCommand = Command.make(
  "update-boat-template",
  {
    homeDir: Flag.String("home-dir").pipe(
      Flag.optional,
      Flag.withDescription("The T3 home whose Boat key and template to use. Defaults to ~/.t3."),
    ),
  },
  ({ homeDir }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userdata = path.join(
        Option.getOrElse(homeDir, () => path.join(NodeOS.homedir(), ".t3")),
        "userdata",
      );
      // Read only: T3 Code keeps owning its key and settings.
      const apiKey = yield* fileSystem
        .readFileString(path.join(userdata, "secrets", "boat-api-key.bin"))
        .pipe(
          Effect.map((key) => key.trim()),
          Effect.orElseSucceed(() => ""),
        );
      if (apiKey === "") {
        return yield* new BoatError({
          detail: `No Boat API key in ${userdata}. Add one in Settings first.`,
        });
      }
      const template = yield* fileSystem.readFileString(path.join(userdata, "boat.json")).pipe(
        Effect.map((text) =>
          Option.getOrNull(Option.map(decodeSettings(text), (state) => state.settings.template)),
        ),
        Effect.orElseSucceed(() => null),
      );
      if (template === null || template.startsWith("bsh_")) {
        return yield* new BoatError({
          detail:
            "No template of your own to update. Pick Use as template in a Boat machine's menu in T3 Code first.",
        });
      }

      const t3Version = yield* latestT3Version;
      yield* Console.log(
        `Updating Boat template "${template}" to T3 Code ${t3Version} and the latest tools.`,
      );
      const boat = makeBoatApi(yield* HttpClient.HttpClient, apiKey);
      const summary = yield* buildTemplate({
        boat,
        from: template,
        name: template,
        t3Version,
        onStep: (step) => Console.log(`${step}…`),
      });
      yield* Console.log(`Updated: ${summary.updated.join(", ") || "nothing"}`);
      if (summary.failed.length > 0) {
        yield* Console.log(`Could not update: ${summary.failed.join(", ")}`);
      }
      yield* Console.log(`New machines start from the updated "${template}".`);
    }),
).pipe(
  Command.withDescription(
    "Update the Boat template new machines start from to the latest T3 Code, Claude Code, Codex, Pi, and gentle-ai.",
  ),
);

if (import.meta.main) {
  Command.run(updateBoatTemplateCommand, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}
