import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { PiRpcError } from "./PiRpc.ts";

// Wire-format schemas for Pi's RPC mode: responses, session history entries, and streamed
// events, as emitted by Pi 0.86.1 and newer. The adapter decodes every record through these.

export const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
export const FiniteNonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
export const UsageSchema = Schema.Struct({
  input: FiniteNonNegative,
  output: FiniteNonNegative,
  cacheRead: FiniteNonNegative,
  cacheWrite: FiniteNonNegative,
  reasoning: Schema.optionalKey(FiniteNonNegative),
  totalTokens: FiniteNonNegative,
  cost: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    cacheRead: Schema.Finite,
    cacheWrite: Schema.Finite,
    total: Schema.Finite,
  }),
});
export const PiModelIdentitySchema = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
});
// Pi reports no model until one is chosen; the session still needs a model identity.
export const UNSELECTED_MODEL = "pi/unselected";
export function modelSlug(model: typeof PiModelIdentitySchema.Type | null | undefined): string {
  return model === null || model === undefined ? UNSELECTED_MODEL : `${model.provider}/${model.id}`;
}
export const PiSessionIdSchema = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/),
);
export const PiResumeCursorSchema = Schema.Struct({
  version: Schema.Literal(2),
  sessionId: PiSessionIdSchema,
  providerInstanceId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
});

export type PiJsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<PiJsonValue>
  | { readonly [key: string]: PiJsonValue };
export const PiJsonValueSchema: Schema.Codec<PiJsonValue> = Schema.suspend(
  (): Schema.Codec<PiJsonValue> =>
    Schema.Union([
      Schema.Null,
      Schema.Boolean,
      Schema.Finite,
      Schema.String,
      Schema.Array(PiJsonValueSchema),
      Schema.Record(Schema.String, PiJsonValueSchema),
    ]),
);
export const PiJsonObjectSchema = Schema.Record(Schema.String, PiJsonValueSchema);
export const PiTextContentSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  textSignature: Schema.optionalKey(Schema.String),
});
export const PiImageContentSchema = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});
export const PiThinkingContentSchema = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  thinkingSignature: Schema.optionalKey(Schema.String),
  redacted: Schema.optionalKey(Schema.Boolean),
});
export const PiToolCallSchema = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: PiJsonObjectSchema,
  thoughtSignature: Schema.optionalKey(Schema.String),
  namespace: Schema.optionalKey(Schema.String),
});
export const PiUserContentSchema = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Union([PiTextContentSchema, PiImageContentSchema])),
]);
export const PiUsageSchema = Schema.Struct({
  input: FiniteNonNegative,
  output: FiniteNonNegative,
  cacheRead: FiniteNonNegative,
  cacheWrite: FiniteNonNegative,
  cacheWrite1h: Schema.optionalKey(FiniteNonNegative),
  reasoning: Schema.optionalKey(FiniteNonNegative),
  totalTokens: FiniteNonNegative,
  cost: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    cacheRead: Schema.Finite,
    cacheWrite: Schema.Finite,
    total: Schema.Finite,
  }),
});
export const PiDiagnosticSchema = Schema.Struct({
  type: Schema.String,
  timestamp: Schema.Finite,
  error: Schema.optionalKey(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      message: Schema.String,
      stack: Schema.optionalKey(Schema.String),
      code: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
    }),
  ),
  details: Schema.optionalKey(PiJsonObjectSchema),
});
export const PiDeferredHandleSchema = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  api: Schema.String,
  id: Schema.String,
  expiresAt: Schema.optionalKey(Schema.Finite),
  pollAfterMs: Schema.optionalKey(Schema.Finite),
  data: Schema.optionalKey(PiJsonValueSchema),
});
export const PiToolSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: PiJsonObjectSchema,
  constrainedSampling: Schema.optionalKey(
    Schema.Union([
      Schema.Literal(false),
      Schema.Struct({
        type: Schema.Literal("json_schema"),
        strict: Schema.Literals(["prefer", "require"]),
      }),
      Schema.Struct({
        type: Schema.Literal("grammar"),
        variants: Schema.Record(Schema.String, Schema.String),
      }),
    ]),
  ),
});
export const PiSystemMessageSchema = Schema.Struct({
  role: Schema.Literal("system"),
  content: Schema.Union([Schema.String, Schema.Array(PiTextContentSchema)]),
  sections: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  toolsAdded: Schema.optionalKey(Schema.Array(PiToolSchema)),
  toolsRemoved: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
  timestamp: Schema.Finite,
});
export const PiHistoryMessageSchema = Schema.Union([
  PiSystemMessageSchema,
  Schema.Struct({
    role: Schema.Literal("user"),
    content: PiUserContentSchema,
    timestamp: Schema.Finite,
  }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.Array(
      Schema.Union([PiTextContentSchema, PiThinkingContentSchema, PiToolCallSchema]),
    ),
    api: Schema.String,
    provider: Schema.String,
    model: Schema.String,
    responseModel: Schema.optionalKey(Schema.String),
    responseId: Schema.optionalKey(Schema.String),
    providerThinkingLevel: Schema.optionalKey(Schema.String),
    diagnostics: Schema.optionalKey(Schema.Array(PiDiagnosticSchema)),
    usage: PiUsageSchema,
    stopReason: Schema.Literals([
      "pending",
      "stop",
      "length",
      "toolUse",
      "error",
      "aborted",
      "deferred",
    ]),
    deferred: Schema.optionalKey(PiDeferredHandleSchema),
    errorMessage: Schema.optionalKey(Schema.String),
    rawStopReason: Schema.optionalKey(Schema.String),
    endTurn: Schema.optionalKey(Schema.Boolean),
    timestamp: Schema.Finite,
  }),
  Schema.Struct({
    role: Schema.Literal("toolResult"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    content: Schema.Array(Schema.Union([PiTextContentSchema, PiImageContentSchema])),
    details: Schema.optionalKey(Schema.Unknown),
    usage: Schema.optionalKey(PiUsageSchema),
    isError: Schema.Boolean,
    timestamp: Schema.Finite,
  }),
  Schema.Struct({
    role: Schema.Literal("bashExecution"),
    command: Schema.String,
    output: Schema.String,
    exitCode: Schema.optionalKey(Schema.Finite),
    cancelled: Schema.Boolean,
    truncated: Schema.Boolean,
    fullOutputPath: Schema.optionalKey(Schema.String),
    timestamp: Schema.Finite,
    excludeFromContext: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    role: Schema.Literal("custom"),
    customType: Schema.String,
    content: PiUserContentSchema,
    display: Schema.Boolean,
    details: Schema.optionalKey(Schema.Unknown),
    timestamp: Schema.Finite,
  }),
  Schema.Struct({
    role: Schema.Literal("branchSummary"),
    summary: Schema.String,
    fromId: Schema.NullOr(Schema.String),
    timestamp: Schema.Finite,
  }),
  Schema.Struct({
    role: Schema.Literal("compactionSummary"),
    summary: Schema.String,
    tokensBefore: FiniteNonNegative,
    timestamp: Schema.Finite,
  }),
]);
export const PiSessionEntryBase = {
  id: TrimmedNonEmptyString,
  parentId: Schema.NullOr(TrimmedNonEmptyString),
  timestamp: Schema.String,
} as const;
export const PiSessionEntrySchema = Schema.Union([
  Schema.Struct({
    ...PiSessionEntryBase,
    type: Schema.Literal("message"),
    message: PiHistoryMessageSchema,
  }),
  Schema.Struct({
    ...PiSessionEntryBase,
    type: Schema.Literal("thinking_level_change"),
    thinkingLevel: Schema.String,
  }),
  Schema.Struct({
    ...PiSessionEntryBase,
    type: Schema.Literal("model_change"),
    provider: Schema.String,
    modelId: Schema.String,
  }),
  Schema.Struct({
    ...PiSessionEntryBase,
    type: Schema.Literal("usage"),
    kind: Schema.String,
    provider: Schema.String,
    model: Schema.String,
    usage: PiUsageSchema,
    note: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...PiSessionEntryBase,
    type: Schema.Literal("compaction"),
    summary: Schema.String,
    firstKeptEntryId: Schema.String,
    tokensBefore: FiniteNonNegative,
    details: Schema.optionalKey(Schema.Unknown),
    usage: Schema.optionalKey(PiUsageSchema),
    fromHook: Schema.optionalKey(Schema.Boolean),
    systemMessage: Schema.optionalKey(PiSystemMessageSchema),
  }),
  Schema.Struct({
    ...PiSessionEntryBase,
    type: Schema.Literal("branch_summary"),
    fromId: Schema.String,
    summary: Schema.String,
    details: Schema.optionalKey(Schema.Unknown),
    usage: Schema.optionalKey(PiUsageSchema),
    fromHook: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    ...PiSessionEntryBase,
    type: Schema.Literal("custom"),
    customType: Schema.String,
    data: Schema.optionalKey(Schema.Unknown),
  }),
  Schema.Struct({
    ...PiSessionEntryBase,
    type: Schema.Literal("label"),
    targetId: Schema.String,
    label: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...PiSessionEntryBase,
    type: Schema.Literal("session_info"),
    name: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...PiSessionEntryBase,
    type: Schema.Literal("custom_message"),
    customType: Schema.String,
    content: PiUserContentSchema,
    details: Schema.optionalKey(Schema.Unknown),
    display: Schema.Boolean,
  }),
]);
export const StateResponseSchema = Schema.Struct({
  data: Schema.Struct({
    model: Schema.optionalKey(Schema.NullOr(PiModelIdentitySchema)),
    thinkingLevel: Schema.String,
    isStreaming: Schema.Boolean,
    isCompacting: Schema.Boolean,
    sessionFile: Schema.optionalKey(Schema.String),
    sessionId: PiSessionIdSchema,
  }),
});
export const AssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  provider: Schema.String,
  model: Schema.String,
  usage: UsageSchema,
  stopReason: Schema.String,
  errorMessage: Schema.optionalKey(Schema.String),
});
export const MessageUpdateSchema = Schema.Struct({
  type: Schema.Literal("message_update"),
  usage: UsageSchema,
  assistantMessageEvent: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("text_delta"),
      contentIndex: Schema.Int,
      delta: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("thinking_delta"),
      contentIndex: Schema.Int,
      delta: Schema.String,
    }),
  ]),
});
export const FinalAssistantEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("turn_end"),
    message: AssistantMessageSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("message_end"),
    message: AssistantMessageSchema,
  }),
]);
export const ToolContentSchema = Schema.Array(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
    Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
  ]),
);
export const ToolResultSchema = Schema.Struct({
  content: ToolContentSchema,
  details: Schema.optionalKey(Schema.Unknown),
});
export const ToolEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool_execution_start"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: JsonRecord,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_update"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: JsonRecord,
    partialResult: ToolResultSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_end"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    result: ToolResultSchema,
    isError: Schema.Boolean,
  }),
]);
export const BlockingExtensionUiSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("select"),
    title: Schema.String,
    options: Schema.Array(Schema.String),
    timeout: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("confirm"),
    title: Schema.String,
    message: Schema.String,
    timeout: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("input"),
    title: Schema.String,
    placeholder: Schema.optionalKey(Schema.String),
    timeout: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("editor"),
    title: Schema.String,
    prefill: Schema.optionalKey(Schema.String),
  }),
]);
export const NonBlockingExtensionUiSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("notify"),
    message: Schema.optionalKey(Schema.String),
    notifyType: Schema.optionalKey(Schema.Literals(["info", "warning", "error"])),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("setStatus"),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.optionalKey(Schema.String),
    method: Schema.Literal("setWidget"),
    widgetKey: Schema.optionalKey(Schema.String),
    widgetLines: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("setTitle"),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("set_editor_text"),
  }),
]);
export const AgentStartedSchema = Schema.Struct({ type: Schema.Literal("agent_start") });
export const SettledSchema = Schema.Struct({ type: Schema.Literal("agent_settled") });
export const IgnoredAgentEndSchema = Schema.Struct({ type: Schema.Literal("agent_end") });
export const CompactionResultSchema = Schema.Struct({
  summary: Schema.String,
  firstKeptEntryId: Schema.String,
  tokensBefore: FiniteNonNegative,
  estimatedTokensAfter: Schema.optionalKey(FiniteNonNegative),
});
export const CompactionEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("compaction_start"),
    reason: Schema.Literals(["manual", "threshold", "overflow"]),
  }),
  Schema.Struct({
    type: Schema.Literal("compaction_end"),
    reason: Schema.Literals(["manual", "threshold", "overflow"]),
    result: Schema.optionalKey(CompactionResultSchema),
    aborted: Schema.Boolean,
    willRetry: Schema.Boolean,
    errorMessage: Schema.optionalKey(Schema.String),
  }),
]);
export const NativeEventSchema = Schema.Union([
  MessageUpdateSchema,
  FinalAssistantEventSchema,
  ToolEventSchema,
  BlockingExtensionUiSchema,
  NonBlockingExtensionUiSchema,
  AgentStartedSchema,
  SettledSchema,
  IgnoredAgentEndSchema,
  CompactionEventSchema,
]);
export const ForkResponseSchema = Schema.Struct({
  data: Schema.Struct({
    text: Schema.String,
    cancelled: Schema.Boolean,
  }),
});
export const EntriesResponseSchema = Schema.Struct({
  data: Schema.Struct({
    entries: Schema.Array(PiSessionEntrySchema),
    leafId: Schema.NullOr(Schema.String),
  }),
});
export const decodeResumeCursor = Schema.decodeUnknownEffect(PiResumeCursorSchema);
export const decodeStateResponse = Schema.decodeUnknownEffect(StateResponseSchema);
export const decodeForkResponse = Schema.decodeUnknownEffect(ForkResponseSchema);
export const decodeEntriesResponse = Schema.decodeUnknownEffect(EntriesResponseSchema);
export const decodeNativeEvent = Schema.decodeUnknownOption(NativeEventSchema);
export const isPiRpcError = Schema.is(PiRpcError);
export const decodeAnswer = Schema.decodeUnknownOption(
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
