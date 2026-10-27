/**
 * Gives a Boat machine this server's GitHub token so it can clone private repositories and push. Boat keeps
 * every command, so the token goes to the machine's own T3 Code server over HTTPS instead.
 */
import {
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
  ServerSettingsError,
  ServerSettingsPatch,
  WS_METHODS,
} from "@t3tools/contracts";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import type { BoatApi } from "./BoatApi.ts";
import { openMachineRpc } from "./machineRpc.ts";

const GITHUB_HOST = "github.com";

const NO_GITHUB_LOGIN_NOTICE =
  "This server has no GitHub login to give the machine, so it cannot clone private repositories or push to GitHub. Sign in with `gh auth login` or add a GitHub token in Settings, then resume the machine.";
const GITHUB_LOGIN_FAILED_NOTICE =
  "T3 Code could not give this machine your GitHub login, so it cannot clone private repositories or push to GitHub. Resume the machine to try again.";

/** The settings change that saves a GitHub token as the one the server reads. */
export const gitHubTokenPatch = (token: string) =>
  ({
    sourceControlHosts: { github: { tokens: { [GITHUB_HOST]: token } } },
  }) satisfies Schema.Schema.Type<typeof ServerSettingsPatch>;

const UpdateSettingsRpcs = RpcGroup.make(
  Rpc.make(WS_METHODS.serverUpdateSettings, {
    payload: Schema.Struct({ patch: ServerSettingsPatch }),
    // The machine answers with its settings; only whether the change was accepted matters here.
    success: Schema.Unknown,
    error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
  }),
);

/**
 * Saves this server's GitHub token on a running machine. Returns the notice to show on the machine
 * when it could not, or null. Never fails: a machine without GitHub access still starts.
 */
export const giveMachineGitHubLogin = Effect.fn("BoatMachines.giveGitHubLogin")(
  function* (input: {
    readonly boat: BoatApi;
    readonly sandboxId: string;
    readonly t3Command: string;
    readonly port: number;
  }) {
    const credentials = yield* GitHubCredentials.GitHubCredentials;
    const credential = yield* credentials.get(GITHUB_HOST).pipe(Effect.option);
    if (Option.isNone(credential)) return NO_GITHUB_LOGIN_NOTICE;

    const machineUrl = yield* input.boat.hostPublicPort(input.sandboxId, input.port);
    yield* Effect.gen(function* () {
      // A token that can only change settings and expires soon.
      const client = yield* openMachineRpc({
        boat: input.boat,
        sandboxId: input.sandboxId,
        machineUrl,
        t3Command: input.t3Command,
        group: UpdateSettingsRpcs,
        scopes: [AuthSettingsWriteScope],
        ttl: "5m",
        label: "T3 Code GitHub sign-in",
      });
      yield* client[WS_METHODS.serverUpdateSettings]({
        patch: gitHubTokenPatch(Redacted.value(credential.value.token)),
      });
    }).pipe(Effect.scoped);
    return null;
  },
  (effect, input) =>
    effect.pipe(
      Effect.timeout("45 seconds"),
      // The cause can carry the one-time socket ticket, so only the machine is logged.
      Effect.catch(() =>
        Effect.logWarning("Could not give a Boat machine the GitHub login", {
          sandboxId: input.sandboxId,
        }).pipe(Effect.as(GITHUB_LOGIN_FAILED_NOTICE)),
      ),
    ),
);
