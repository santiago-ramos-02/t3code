/**
 * Runs one `gentle-ai api <method>` call: parameters as JSON on stdin, newline-delimited JSON
 * events on stdout, ending in exactly one result or error line.
 *
 * @module gentleAi/GentleAiApi
 */
import { GentleAiError } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const ApiLine = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    step: Schema.String,
    // How gentle-ai names the step for people; absent from builds before it did.
    label: Schema.optionalKey(Schema.String),
    status: Schema.Literals(["running", "succeeded", "failed", "skipped"]),
    error: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("log"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("result"), data: Schema.Unknown }),
  Schema.Struct({
    type: Schema.Literal("error"),
    error: Schema.Struct({ code: Schema.String, message: Schema.String }),
  }),
]);
// Lines this version does not understand, such as a newer event type, are skipped.
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(ApiLine));

/** Progress and log events a caller can observe while a call runs. */
export type GentleAiApiEvent =
  | {
      readonly type: "progress";
      readonly step: string;
      readonly label?: string;
      readonly status: "running" | "succeeded" | "failed" | "skipped";
      readonly error?: string;
    }
  | { readonly type: "log"; readonly message: string };

const isGentleAiError = Schema.is(GentleAiError);
const encodeParams = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** The API version a gentle-ai binary offers, or null when it has no headless API. */
export const DescribeResult = Schema.Struct({
  apiVersion: Schema.Number,
  methods: Schema.Array(Schema.String),
  // The workflows the build offers, such as "odd" or "sdd"; absent from early builds.
  features: Schema.optional(Schema.Array(Schema.String)),
});

export const runGentleAiApi = Effect.fn("runGentleAiApi")(function* (input: {
  readonly binaryPath: string;
  readonly method: string;
  readonly params: unknown;
  readonly environment: NodeJS.ProcessEnv;
  readonly timeout: Duration.Input;
  readonly onEvent?: (event: GentleAiApiEvent) => Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const args = ["api", input.method];
  const resolved = yield* resolveSpawnCommand(input.binaryPath, args, { env: input.environment });
  const body = yield* encodeParams(input.params).pipe(
    Effect.mapError(() => new GentleAiError({ detail: `Invalid parameters for ${input.method}.` })),
  );
  const outcome = yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        env: input.environment,
        extendEnv: false,
        shell: resolved.shell,
        stdin: { stream: "pipe", endOnDone: true },
      }),
    );
    yield* Stream.make(new TextEncoder().encode(body)).pipe(Stream.run(child.stdin));
    let final: { readonly data: unknown } | { readonly error: string } | undefined;
    const [, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => {
            const decoded = decodeLine(line);
            if (Option.isNone(decoded)) return Effect.void;
            const event = decoded.value;
            if (event.type === "result") {
              final = { data: event.data };
              return Effect.void;
            }
            if (event.type === "error") {
              final = { error: event.error.message };
              return Effect.void;
            }
            return input.onEvent ? input.onEvent(event) : Effect.void;
          }),
        ),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { final, stderr, exitCode };
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: input.timeout,
      orElse: () =>
        Effect.fail(new GentleAiError({ detail: `gentle-ai ${input.method} timed out.` })),
    }),
    Effect.mapError((cause) =>
      isGentleAiError(cause)
        ? cause
        : new GentleAiError({ detail: `gentle-ai ${input.method} could not be run.` }),
    ),
  );
  if (outcome.final === undefined) {
    const tail = outcome.stderr.trim().split("\n").slice(-3).join(" ").slice(-400);
    return yield* new GentleAiError({
      detail: `gentle-ai ${input.method} ended without a result${tail ? `: ${tail}` : ` (exit ${outcome.exitCode}).`}`,
    });
  }
  if ("error" in outcome.final) return yield* new GentleAiError({ detail: outcome.final.error });
  return outcome.final.data;
});
