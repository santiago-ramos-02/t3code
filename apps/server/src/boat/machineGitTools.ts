/**
 * On a Boat machine, signs git and `gh` in with the GitHub token the host saved in this server's
 * settings, so agents running here can push and open pull requests. Agents start before the host
 * gives the token, so it goes to the tools' own logins rather than into agent environments.
 */
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "../processRunner.ts";
import * as Settings from "../serverSettings.ts";

/** Set by the command that starts T3 Code on a Boat machine; nowhere else touches global logins. */
export const BOAT_MACHINE_ENV = "T3CODE_BOAT_MACHINE";

const GITHUB_HOST = "github.com";

// git's credential protocol, as `git credential-store` reads it on stdin.
const credentialInput = (password: string | null) =>
  [
    "protocol=https",
    `host=${GITHUB_HOST}`,
    "username=x-access-token",
    ...(password === null ? [] : [`password=${password}`]),
    "",
    "",
  ].join("\n");

const HELPER_KEY = `credential.https://${GITHUB_HOST}.helper`;

/**
 * Points git and `gh` at `token`, or signs them out when it is null. The token only ever goes on
 * stdin. Never fails: a machine whose tools could not sign in still runs.
 */
export const signInGitTools = Effect.fn("MachineGitTools.signIn")(function* (token: string | null) {
  const runner = yield* ProcessRunner.ProcessRunner;
  // Only the command is logged: the tool's output is no place to look for a token.
  const run = (command: string, args: ReadonlyArray<string>, stdin = "") =>
    runner.run({ command, args, stdin, timeout: "30 seconds" }).pipe(
      Effect.map((result) => result.code === 0),
      Effect.orElseSucceed(() => false),
      Effect.flatMap((ok) =>
        ok
          ? Effect.void
          : Effect.logWarning("Could not update a Boat machine's GitHub login", { command }),
      ),
    );

  if (token === null) {
    yield* run("git", ["credential-store", "erase"], credentialInput(null));
    yield* run("git", ["config", "--global", "--unset-all", HELPER_KEY]);
    yield* run("gh", ["auth", "logout", "--hostname", GITHUB_HOST]);
    return;
  }
  yield* run("git", ["credential-store", "store"], credentialInput(token));
  yield* run("git", ["config", "--global", HELPER_KEY, "store"]);
  // Templates without gh still get git.
  yield* run("gh", ["auth", "login", "--hostname", GITHUB_HOST, "--with-token"], token);
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* HostProcess.Environment;
    if (environment[BOAT_MACHINE_ENV] !== "1") return;
    const settings = yield* Settings.ServerSettingsService;
    const credentials = yield* GitHubCredentials.GitHubCredentials;
    const changes = yield* settings.subscribeChanges;
    // A login from the machine's own env or gh is the user's; only the host's saved token is ours.
    const savedToken = () =>
      credentials.get(GITHUB_HOST).pipe(
        Effect.map((credential) =>
          credential.source === "settings" ? Redacted.value(credential.token) : null,
        ),
        Effect.orElseSucceed(() => null),
      );
    let signedIn = false;
    yield* Stream.concat(Stream.make(undefined), changes).pipe(
      Stream.mapEffect(savedToken),
      Stream.changes,
      Stream.runForEach((token) => {
        if (token === null && !signedIn) return Effect.void;
        signedIn = token !== null;
        return signInGitTools(token);
      }),
      Effect.forkScoped,
    );
  }),
);
