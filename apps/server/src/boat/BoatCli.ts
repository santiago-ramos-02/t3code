import { BoatError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { hostUserHome } from "../hostUserHome.ts";
import type { ProcessRunner } from "../processRunner.ts";

// Only the fields T3 Code reads from `boat status --json`.
const CliStatus = Schema.Struct({
  account: Schema.Struct({
    signedIn: Schema.Boolean,
    identifier: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
const decodeCliStatus = Schema.decodeUnknownOption(Schema.fromJsonString(CliStatus));

// As printed by Boat CLI 1.0.63. The ID lets T3 Code revoke the key it made, so a key without
// one is refused rather than kept untracked.
const CreatedKey = Schema.Struct({
  secret: Schema.String,
  apiKey: Schema.Struct({ id: Schema.String }),
});
const decodeCreatedKey = Schema.decodeUnknownOption(Schema.fromJsonString(CreatedKey));

export interface BoatCliLogin {
  readonly command: string;
  readonly signedIn: boolean;
  readonly account: string | null;
}

// The CLI prints one JSON document; anything before it is an update notice or a warning.
const jsonOf = (stdout: string) => stdout.slice(Math.max(0, stdout.indexOf("{")));

/** The Boat CLI on the server's machine, used to sign T3 Code in without pasting a key. */
export const makeBoatCli = (input: {
  readonly runner: ProcessRunner["Service"];
  readonly path: Path.Path;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}) => {
  const { runner, path, environment, platform } = input;
  // The installer puts the CLI here and adds it to PATH only for new terminals.
  const candidates = [
    "boat",
    path.join(
      hostUserHome(environment, platform),
      ".ascii",
      "bin",
      platform === "win32" ? "boat.exe" : "boat",
    ),
  ];

  const run = (command: string, args: ReadonlyArray<string>) =>
    runner.run({
      command,
      args: [...args, "--json"],
      env: { ...environment, BOAT_NO_UPDATE: "1" },
      timeout: "30 seconds",
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: 64 * 1024,
      outputMode: "truncate",
    });

  /** The first installed CLI and whether it is signed in, or None when there is none. */
  const login = Effect.fn("BoatCli.login")(function* () {
    for (const command of candidates) {
      const output = yield* run(command, ["status"]).pipe(Effect.option);
      if (Option.isNone(output) || output.value.timedOut) continue;
      const status = decodeCliStatus(jsonOf(output.value.stdout));
      if (Option.isNone(status)) continue;
      return Option.some<BoatCliLogin>({
        command,
        signedIn: status.value.account.signedIn,
        account: status.value.account.identifier ?? null,
      });
    }
    return Option.none<BoatCliLogin>();
  });

  const failure = (operation: string, stderr: string) =>
    new BoatError({
      detail: `The Boat CLI could not ${operation}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : "."}`,
    });

  /**
   * Makes a key for T3 Code. The `ci` preset starts, stops, and resumes machines and deletes only
   * the ones it started; it cannot touch billing or the account.
   */
  const createKey = Effect.fn("BoatCli.createKey")(function* (command: string, name: string) {
    const output = yield* run(command, [
      "api-key",
      "create",
      name,
      "--preset",
      "ci",
      "--ttl",
      "never",
    ]).pipe(Effect.mapError(() => failure("create a key", "")));
    const created = decodeCreatedKey(jsonOf(output.stdout));
    if (output.code !== 0 || Option.isNone(created)) {
      return yield* failure("create a key", output.stderr);
    }
    return { secret: created.value.secret, id: created.value.apiKey.id };
  });

  const revokeKey = Effect.fn("BoatCli.revokeKey")(function* (command: string, id: string) {
    const output = yield* run(command, ["api-key", "revoke", id]).pipe(
      Effect.mapError(() => failure("revoke T3 Code's key", "")),
    );
    if (output.code !== 0) return yield* failure("revoke T3 Code's key", output.stderr);
  });

  return { login, createKey, revokeKey };
};
export type BoatCli = ReturnType<typeof makeBoatCli>;
