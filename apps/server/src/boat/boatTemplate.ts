/**
 * Builds the Boat template new machines start from: a scratch machine boots from a source snapshot,
 * updates its tools to their latest versions, forgets its T3 Code identity, and is saved under the
 * template's name. Used by the "make-template" machine action and `scripts/update-boat-template.ts`.
 * @module boat/boatTemplate
 */
import { BoatError, GENTLE_PI_FORK_SOURCE } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { BOAT_READY_STATES, BOAT_START_FAILED_STATES, type BoatApi } from "./BoatApi.ts";
import { forkRuntimeCommands } from "./forkRuntime.ts";

/** The template's name when T3 Code picks one. */
export const DEFAULT_TEMPLATE_NAME = "t3code-template";

// A share code (`bsh_…`) is someone else's snapshot, which cannot be saved over.
const SHARE_CODE = /^bsh_/;

/** The name a build saves under: the configured template, unless that is a share code. */
export const templateNameFor = (configured: string | null) =>
  configured !== null && configured.length > 0 && !SHARE_CODE.test(configured)
    ? configured
    : DEFAULT_TEMPLATE_NAME;

// Long enough for the slowest build; Boat deletes a scratch machine T3 Code failed to.
const SCRATCH_TTL_SECONDS = 2 * 60 * 60;
const SCRIPT_PATH = "/tmp/t3-template.sh";
const LOG_PATH = "/tmp/t3-template.log";
const STATUS_PATH = "/tmp/t3-template.status";

/**
 * What runs on the scratch machine. Each tool already there is updated in place and a failure only
 * skips that tool; the last line lists what was updated and what failed. Then the T3 Code home
 * loses everything that belongs to one install, so machines started from the template do not share
 * an identity, signing keys, Boat, cloud, or GitHub credentials, or projects and threads.
 */
export const templatePrepScript = (t3Version: string): string | null => {
  const runtime = forkRuntimeCommands(t3Version);
  if (runtime === null) return null;
  const gentleAi = "santiago-ramos-02/gentle-ai";
  return [
    "set -u",
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$PATH"',
    'updated=""; failed=""',
    'step() { name="$1"; shift; echo "== $name"; if "$@"; then updated="$updated,$name"; else failed="$failed,$name"; fi; }',
    // The install prints `installed` or `unavailable` last.
    `update_t3() { case "$( ${runtime.install} )" in *installed) return 0;; *) return 1;; esac; }`,
    "update_claude() { claude update || npm install -g @anthropic-ai/claude-code@latest; }",
    "update_codex() { npm install -g @openai/codex@latest; }",
    `update_pi() { npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest && { pi update ${GENTLE_PI_FORK_SOURCE} || pi install ${GENTLE_PI_FORK_SOURCE}; }; }`,
    "update_gentle_ai() {",
    `  tag=$(curl -fsSL https://api.github.com/repos/${gentleAi}/releases/latest | sed -n 's/.*"tag_name": *"\\([^"]*\\)".*/\\1/p' | head -n 1)`,
    '  [ -n "$tag" ] || return 1',
    "  dir=$(mktemp -d) && bin=$(command -v gentle-ai) &&",
    `  curl -fsSL "https://github.com/${gentleAi}/releases/download/$tag/gentle-ai_\${tag#v}_linux_amd64.tar.gz" | tar -xz -C "$dir" gentle-ai &&`,
    '  install -m 755 "$dir/gentle-ai" "$bin"; status=$?; rm -rf "$dir"; return $status',
    "}",
    `step "T3 Code ${t3Version}" update_t3`,
    'command -v claude >/dev/null 2>&1 && step "Claude Code" update_claude',
    "command -v codex >/dev/null 2>&1 && step Codex update_codex",
    'command -v pi >/dev/null 2>&1 && step "Pi with Gentle AI" update_pi',
    "command -v gentle-ai >/dev/null 2>&1 && step gentle-ai update_gentle_ai",
    'home="$HOME/.t3/userdata"',
    'rm -rf "$home/environment-id" "$home/anonymous-id" "$home/server-runtime.json" "$home"/statev2.sqlite* "$home"/state.sqlite* "$home/logs" "$home/attachments" "$home"/secrets/*-signing-key.bin "$home"/secrets/boat-* "$home"/secrets/cloud-* "$home"/secrets/source-control-*',
    // T3 Code gives each new machine the host's GitHub token when it starts.
    'rm -rf "$HOME/.t3/worktrees" "$HOME/.git-credentials" "$HOME/.config/gh/hosts.yml"',
    'echo "updated=${updated#,};failed=${failed#,}"',
  ].join("\n");
};

/** The tools a build updated and the ones it could not, from the script's last line. */
export const parsePrepSummary = (log: string) => {
  const line = log.trim().split("\n").at(-1) ?? "";
  const match = /^updated=([^;]*);failed=(.*)$/.exec(line.trim());
  if (match === null) return null;
  const list = (text: string) => (text.length === 0 ? [] : text.split(","));
  return { updated: list(match[1]!), failed: list(match[2]!) };
};

export type TemplateBoat = Pick<
  BoatApi,
  | "createSandbox"
  | "getSandbox"
  | "runCommand"
  | "startDetached"
  | "stopSandbox"
  | "deleteSandbox"
  | "listNamedSnapshots"
  | "saveNamedSnapshot"
>;

class StillWaiting extends Data.TaggedError("StillWaiting")<{}> {}

/** Repeats `check` every few seconds until it has an answer, failing after `minutes`. */
const waitFor = <A, E>(
  check: Effect.Effect<Option.Option<A>, E>,
  minutes: number,
  tooLong: string,
) =>
  check.pipe(
    Effect.flatMap(
      Option.match({ onNone: () => Effect.fail(new StillWaiting()), onSome: Effect.succeed }),
    ),
    Effect.retry({
      while: (error) => error instanceof StillWaiting,
      schedule: Schedule.spaced("5 seconds"),
      times: minutes * 12,
    }),
    Effect.catchTags({ StillWaiting: () => Effect.fail(new BoatError({ detail: tooLong })) }),
  );

const sandboxState = (boat: TemplateBoat, sandboxId: string) =>
  boat.getSandbox(sandboxId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new BoatError({ detail: "The template's build machine disappeared." })),
        onSome: (sandbox) => Effect.succeed(sandbox.state),
      }),
    ),
  );

/**
 * Saves `sandboxId` under `name`, replacing any snapshot of that name, and returns once Boat has
 * it. Boat lists a save as soon as it starts and keeps a replaced snapshot's creation time, so
 * the save is done once a snapshot that is new, or was seen saving, is `ready`.
 */
export const saveNamedSnapshotAndWait = Effect.fn("BoatTemplate.saveNamedSnapshot")(function* (
  boat: TemplateBoat,
  sandboxId: string,
  name: string,
) {
  const find = <S extends { readonly name: string }>(snapshots: ReadonlyArray<S>) =>
    snapshots.find((snapshot) => snapshot.name === name);
  const identity = (
    snapshot:
      | {
          readonly createdAt: string;
          readonly snapshotId?: string | undefined;
          readonly sourceSandboxId?: string | undefined;
        }
      | undefined,
  ) =>
    snapshot === undefined
      ? null
      : `${snapshot.snapshotId ?? ""}|${snapshot.sourceSandboxId ?? ""}|${snapshot.createdAt}`;
  const before = identity(find((yield* boat.listNamedSnapshots()).snapshots));
  yield* boat.saveNamedSnapshot(sandboxId, name);
  let seenSaving = false;
  yield* waitFor(
    boat.listNamedSnapshots().pipe(
      Effect.map(({ snapshots }) => {
        const saved = find(snapshots);
        if (saved === undefined) return Option.none();
        if (saved.status !== undefined && saved.status !== "ready") {
          seenSaving = true;
          return Option.none();
        }
        return seenSaving || identity(saved) !== before ? Option.some(saved) : Option.none();
      }),
    ),
    20,
    `Boat did not finish saving "${name}" within 20 minutes.`,
  );
});

/**
 * Builds the template from `from` (a named snapshot, or null for Boat's base image) and saves it
 * as `name`. Returns the tools it updated and the ones it could not. The scratch machine is
 * deleted whatever happens.
 */
export const buildTemplate = Effect.fn("BoatTemplate.build")(function* (input: {
  readonly boat: TemplateBoat;
  readonly from: string | null;
  readonly name: string;
  readonly t3Version: string;
  readonly onStep?: (step: string) => Effect.Effect<void>;
}) {
  const { boat } = input;
  const step = input.onStep ?? (() => Effect.void);
  const script = templatePrepScript(input.t3Version);
  if (script === null) {
    return yield* new BoatError({ detail: `"${input.t3Version}" is not a T3 Code version.` });
  }
  yield* step("Starting a build machine");
  const sandbox = yield* boat.createSandbox({
    type: "default",
    from: input.from,
    ttlSeconds: SCRATCH_TTL_SECONDS,
  });
  return yield* Effect.gen(function* () {
    yield* waitFor(
      sandboxState(boat, sandbox.id).pipe(
        Effect.flatMap((state) =>
          BOAT_START_FAILED_STATES.has(state)
            ? Effect.fail(
                new BoatError({ detail: `The build machine stopped while starting (${state}).` }),
              )
            : Effect.succeed(BOAT_READY_STATES.has(state) ? Option.some(state) : Option.none()),
        ),
      ),
      10,
      "The build machine did not start within 10 minutes.",
    );

    yield* step("Updating tools");
    // Encoded, so the script reaches the machine without any shell quoting of its own.
    const encoded = Buffer.from(script).toString("base64");
    yield* boat.runCommand(sandbox.id, {
      command: `echo ${encoded} | base64 -d > ${SCRIPT_PATH} && rm -f ${STATUS_PATH}`,
    });
    yield* boat.startDetached(
      sandbox.id,
      `sh -c 'bash -l ${SCRIPT_PATH} > ${LOG_PATH} 2>&1; echo $? > ${STATUS_PATH}'`,
    );
    yield* waitFor(
      boat
        .runCommand(sandbox.id, { command: `cat ${STATUS_PATH} 2>/dev/null || echo running` })
        .pipe(
          Effect.map((result) =>
            result.stdout.trim() === "running" ? Option.none() : Option.some(result.stdout),
          ),
        ),
      30,
      "Updating the template's tools took over 30 minutes.",
    );
    const log = yield* boat.runCommand(sandbox.id, { command: `tail -n 1 ${LOG_PATH}` });
    const summary = parsePrepSummary(log.stdout);
    if (summary === null) {
      return yield* new BoatError({ detail: "The template's update script did not finish." });
    }

    yield* step("Saving the template");
    yield* boat.stopSandbox(sandbox.id);
    yield* waitFor(
      sandboxState(boat, sandbox.id).pipe(
        // Boat archives a stopped machine's disk; the save needs it archived.
        Effect.map((state) => (state === "archived" ? Option.some(state) : Option.none())),
      ),
      10,
      "The build machine did not stop within 10 minutes.",
    );
    yield* saveNamedSnapshotAndWait(boat, sandbox.id, input.name);
    return summary;
  }).pipe(Effect.ensuring(boat.deleteSandbox(sandbox.id).pipe(Effect.ignore)));
});
