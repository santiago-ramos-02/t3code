import type { ModelSelection } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  parsePiModelSlug,
  PI_THINKING_LEVELS,
  type PiRpcClient,
  type PiRpcError,
  type PiRpcOptions,
  type PiThinkingLevel,
  asRecord,
  recordString,
} from "../provider/PiRpc.ts";
import type * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PI_TEXT_GENERATION_TIMEOUT = Duration.minutes(3);
const PI_ABORT_TIMEOUT = Duration.seconds(2);
const PI_TEXT_GENERATION_ARGS = [
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-approve",
] as const;
const MAX_OUTPUT_CHARS = 128_000;

const PiCliProvider = Schema.String.check(Schema.isPattern(/^[^\s/:\u0000-\u001f\u007f]+$/u));
const PiCliModel = Schema.String.check(Schema.isPattern(/^[^\s\u0000-\u001f\u007f]+$/u));
const PiAssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  stopReason: Schema.Literals(["stop", "length", "toolUse", "error", "aborted"]),
});

const isPiCliProvider = Schema.is(PiCliProvider);
const isPiCliModel = Schema.is(PiCliModel);
const decodeAssistantMessage = Schema.decodeUnknownOption(PiAssistantMessage);
const decodeThinkingLevel = Schema.decodeUnknownOption(Schema.Literals(PI_THINKING_LEVELS));
const isTextGenerationError = Schema.is(TextGenerationError);

type PiTextGenerationOperation = keyof TextGeneration.TextGeneration["Service"];

type PiTextGenerationRpcFactory = (
  options: PiRpcOptions,
) => Effect.Effect<PiRpcClient, PiRpcError, Scope.Scope>;

export interface PiTextGenerationOptions {
  readonly binaryPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly rpcFactory: PiTextGenerationRpcFactory;
  readonly timeout?: Duration.Input;
  readonly abortTimeout?: Duration.Input;
}

interface ResolvedModelSelection {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel?: PiThinkingLevel;
}

type PiAssistantMessageType = typeof PiAssistantMessage.Type;

interface CompletedAssistantMessage {
  readonly text: string;
  readonly stopReason: PiAssistantMessageType["stopReason"];
}

function selectionError(operation: PiTextGenerationOperation, detail: string) {
  return new TextGenerationError({ operation, detail });
}

function resolveModelSelection(
  operation: PiTextGenerationOperation,
  selection: ModelSelection,
): Effect.Effect<ResolvedModelSelection, TextGenerationError> {
  const parsed = parsePiModelSlug(selection.model);
  if (parsed === undefined || !isPiCliProvider(parsed.provider) || !isPiCliModel(parsed.modelId)) {
    return Effect.fail(
      selectionError(operation, "Pi models must use a valid full provider/modelId form."),
    );
  }

  const thinkingOption = selection.options?.find((option) => option.id === "thinkingLevel");
  if (thinkingOption === undefined) {
    return Effect.succeed({
      provider: parsed.provider,
      modelId: parsed.modelId,
      ...(parsed.thinkingLevel === undefined ? {} : { thinkingLevel: parsed.thinkingLevel }),
    });
  }

  const thinkingLevel = Option.getOrUndefined(decodeThinkingLevel(thinkingOption.value));
  if (thinkingLevel === undefined) {
    return Effect.fail(
      selectionError(operation, "Pi thinkingLevel must be one of Pi's supported levels."),
    );
  }
  return Effect.succeed({
    provider: parsed.provider,
    modelId: parsed.modelId,
    thinkingLevel,
  });
}

function rpcFailure(operation: PiTextGenerationOperation, detail: string): TextGenerationError {
  return new TextGenerationError({ operation, detail });
}

/** Build isolated, short-lived Pi text generation bound to one provider instance. */
export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  options: PiTextGenerationOptions,
) {
  const runPiJson = Effect.fn("PiTextGeneration.runJson")(function* <S extends Schema.Top>(input: {
    readonly operation: PiTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const selection = yield* resolveModelSelection(input.operation, input.modelSelection);
    const args = [
      ...PI_TEXT_GENERATION_ARGS,
      "--provider",
      selection.provider,
      "--model",
      selection.modelId,
      ...(selection.thinkingLevel === undefined ? [] : ["--thinking", selection.thinkingLevel]),
    ];

    const rawOutput = yield* Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* options
          .rpcFactory({
            binaryPath: options.binaryPath,
            cwd: input.cwd,
            args,
            ...(options.environment === undefined ? {} : { environment: options.environment }),
          })
          .pipe(
            Effect.mapError(() =>
              rpcFailure(input.operation, "Failed to start isolated Pi text generation."),
            ),
          );
        const latestAssistant = yield* Ref.make<CompletedAssistantMessage | undefined>(undefined);
        const settled = yield* Deferred.make<CompletedAssistantMessage, TextGenerationError>();

        const fail = (detail: string) =>
          Deferred.fail(
            settled,
            new TextGenerationError({ operation: input.operation, detail }),
          ).pipe(Effect.asVoid);

        yield* rpc.events.pipe(
          Stream.runForEach((event) => {
            if (event.type === "pi_rpc_transport_closed") {
              return fail("Pi text generation ended before settling.");
            }
            if (event.type === "pi_rpc_malformed_record") {
              return fail("Pi returned malformed text generation protocol output.");
            }

            const eventRecord = asRecord(event);
            if (eventRecord === undefined) {
              return fail("Pi returned an invalid text generation event.");
            }
            const eventType = recordString(eventRecord, "type");
            if (
              eventType === "tool_execution_start" ||
              eventType === "tool_execution_update" ||
              eventType === "tool_execution_end" ||
              eventType === "extension_ui_request"
            ) {
              return fail("Pi attempted disabled work during text generation.");
            }
            if (eventType === "message_end") {
              const message = asRecord(eventRecord.message);
              if (message === undefined) {
                return fail("Pi returned a malformed completed message.");
              }
              if (recordString(message, "role") !== "assistant") {
                return Effect.void;
              }
              const decoded = decodeAssistantMessage(message);
              if (Option.isNone(decoded)) {
                return fail("Pi returned a malformed assistant message.");
              }
              const text = decoded.value.content
                .flatMap((part) =>
                  recordString(part, "type") === "text" ? [recordString(part, "text") ?? ""] : [],
                )
                .join("")
                .trim();
              if (text.length > MAX_OUTPUT_CHARS) {
                return fail("Pi text generation exceeded the output limit.");
              }
              return Ref.set(latestAssistant, {
                text,
                stopReason: decoded.value.stopReason,
              });
            }
            if (eventType !== "agent_settled") {
              return Effect.void;
            }
            return Ref.get(latestAssistant).pipe(
              Effect.flatMap((assistant) =>
                assistant === undefined
                  ? fail("Pi settled without an assistant response.")
                  : Deferred.succeed(settled, assistant).pipe(Effect.asVoid),
              ),
            );
          }),
          Effect.catchCause(() => fail("Pi text generation event handling failed.")),
          Effect.forkScoped,
        );

        const interaction = rpc.request({ type: "prompt", message: input.prompt }).pipe(
          Effect.mapError(() =>
            rpcFailure(input.operation, "Pi rejected the text generation request."),
          ),
          Effect.andThen(Deferred.await(settled)),
          Effect.onInterrupt(() => {
            const abortTimeout = options.abortTimeout ?? PI_ABORT_TIMEOUT;
            return rpc
              .request({ type: "abort" }, { timeout: abortTimeout })
              .pipe(Effect.timeoutOption(abortTimeout), Effect.ignore);
          }),
        );

        const completed = yield* interaction.pipe(
          Effect.timeoutOption(options.timeout ?? PI_TEXT_GENERATION_TIMEOUT),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new TextGenerationError({
                    operation: input.operation,
                    detail: "Pi text generation timed out.",
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );

        if (completed.stopReason === "aborted") {
          return yield* selectionError(input.operation, "Pi text generation was cancelled.");
        }
        if (completed.stopReason === "error") {
          return yield* selectionError(input.operation, "Pi text generation failed.");
        }
        if (completed.stopReason === "toolUse") {
          return yield* selectionError(
            input.operation,
            "Pi attempted disabled tool work during text generation.",
          );
        }
        if (completed.text.length === 0) {
          return yield* selectionError(
            input.operation,
            "Pi returned empty text generation output.",
          );
        }
        return completed.text;
      }),
    ).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : rpcFailure(input.operation, "Pi text generation failed."),
      ),
    );

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchema));
    return yield* decodeOutput(extractJsonObject(rawOutput)).pipe(
      Effect.mapError(
        () =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Pi returned invalid structured output.",
          }),
      ),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        ...buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        }),
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        ...buildPrContentPrompt({
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          commitSummary: input.commitSummary,
          diffSummary: input.diffSummary,
          diffPatch: input.diffPatch,
          changeRequestTemplate: input.changeRequestTemplate,
          policy: input.policy,
        }),
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        ...buildBranchNamePrompt({
          message: input.message,
          attachments: input.attachments,
        }),
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        ...buildThreadTitlePrompt({
          message: input.message,
          previousTitle: input.previousTitle,
          linkedContext: input.linkedContext,
          attachments: input.attachments,
        }),
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
