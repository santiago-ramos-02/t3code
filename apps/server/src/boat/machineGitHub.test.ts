import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ServerSettingsPatch } from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { gitHubTokenPatch } from "./machineGitHub.ts";

const TOKEN = "ghp_hosttoken";
const encodePatch = Schema.encodeSync(ServerSettingsPatch);

// The machine's own credential lookup, over settings that already pick an account for github.com.
const machineCredentials = GitHubCredentials.layer.pipe(
  Layer.provideMerge(
    TestSourceControlHost.layer({
      settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        sourceControlHosts: {
          github: { hosts: { "github.com": { account: "work", enabled: true } } },
        },
      }),
      // A machine with no gh login: settings are the only source.
      process: { run: () => Effect.die("The machine has no gh login.") },
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

it.effect("saves the host's token where the machine's GitHub credential reads it", () =>
  Effect.gen(function* () {
    const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
    const credentials = yield* GitHubCredentials.GitHubCredentials;
    yield* settings.update(gitHubTokenPatch(TOKEN));

    const credential = yield* credentials.get("github.com");
    assert.strictEqual(Redacted.value(credential.token), TOKEN);
    assert.strictEqual(credential.source, "settings");
  }).pipe(Effect.provide(machineCredentials)),
);

it("encodes the settings change as the machine's RPC expects it", () => {
  assert.deepStrictEqual(encodePatch(gitHubTokenPatch(TOKEN)), {
    sourceControlHosts: { github: { tokens: { "github.com": TOKEN } } },
  });
});
