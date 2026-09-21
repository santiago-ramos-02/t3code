import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  TrimmedNonEmptyString,
  isProviderSendTurnSupportedImageMimeType,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderUserInputAnswers,
  type ThreadId,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  PI_MCP_AUTHORIZATION_ENV,
  PI_MCP_ENDPOINT_ENV,
  PI_MCP_SCOPE_ENV,
} from "../pi-mcp/PiMcpBridgeSource.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  parsePiModelSlug,
  PiRpcError,
  PI_THINKING_LEVELS,
  type PiRpcClient,
  type PiRpcEvent,
  type PiRpcOptions,
  type PiThinkingLevel,
} from "../PiRpc.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const MAX_TOOL_DETAIL_CHARS = 2_048;
const DEFAULT_INTERRUPT_SETTLEMENT_TIMEOUT = "5 seconds";
const decodeThinkingLevel = Schema.decodeUnknownOption(Schema.Literals(PI_THINKING_LEVELS));
const encodePiMcpScope = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      environmentId: Schema.String,
      threadId: Schema.String,
      providerSessionId: Schema.String,
      providerInstanceId: Schema.String,
      runtimeMode: Schema.Literals([
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ]),
      capabilities: Schema.Array(Schema.String),
    }),
  ),
);

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const FiniteNonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const UsageSchema = Schema.Struct({
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
const PiModelIdentitySchema = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
});
const PiSessionIdSchema = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/),
);
const PiResumeCursorSchema = Schema.Struct({
  version: Schema.Literal(2),
  sessionId: PiSessionIdSchema,
  providerInstanceId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
});

type PiJsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<PiJsonValue>
  | { readonly [key: string]: PiJsonValue };
const PiJsonValueSchema: Schema.Codec<PiJsonValue> = Schema.suspend((): Schema.Codec<PiJsonValue> =>
  Schema.Union([
    Schema.Null,
    Schema.Boolean,
    Schema.Finite,
    Schema.String,
    Schema.Array(PiJsonValueSchema),
    Schema.Record(Schema.String, PiJsonValueSchema),
  ]),
);
const PiJsonObjectSchema = Schema.Record(Schema.String, PiJsonValueSchema);
const PiTextContentSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  textSignature: Schema.optionalKey(Schema.String),
});
const PiImageContentSchema = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});
const PiThinkingContentSchema = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  thinkingSignature: Schema.optionalKey(Schema.String),
  redacted: Schema.optionalKey(Schema.Boolean),
});
const PiToolCallSchema = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: PiJsonObjectSchema,
  thoughtSignature: Schema.optionalKey(Schema.String),
  namespace: Schema.optionalKey(Schema.String),
});
const PiUserContentSchema = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Union([PiTextContentSchema, PiImageContentSchema])),
]);
const PiUsageSchema = Schema.Struct({
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
const PiDiagnosticSchema = Schema.Struct({
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
const PiDeferredHandleSchema = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  api: Schema.String,
  id: Schema.String,
  expiresAt: Schema.optionalKey(Schema.Finite),
  pollAfterMs: Schema.optionalKey(Schema.Finite),
  data: Schema.optionalKey(PiJsonValueSchema),
});
const PiToolSchema = Schema.Struct({
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
const PiSystemMessageSchema = Schema.Struct({
  role: Schema.Literal("system"),
  content: Schema.Union([Schema.String, Schema.Array(PiTextContentSchema)]),
  sections: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  toolsAdded: Schema.optionalKey(Schema.Array(PiToolSchema)),
  toolsRemoved: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
  timestamp: Schema.Finite,
});
const PiHistoryMessageSchema = Schema.Union([
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
const PiSessionEntryBase = {
  id: TrimmedNonEmptyString,
  parentId: Schema.NullOr(TrimmedNonEmptyString),
  timestamp: Schema.String,
} as const;
const PiSessionEntrySchema = Schema.Union([
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
const StateResponseSchema = Schema.Struct({
  data: Schema.Struct({
    model: Schema.optionalKey(Schema.NullOr(PiModelIdentitySchema)),
    thinkingLevel: Schema.String,
    isStreaming: Schema.Boolean,
    isCompacting: Schema.Boolean,
    sessionFile: Schema.optionalKey(Schema.String),
    sessionId: PiSessionIdSchema,
  }),
});
const AssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  provider: Schema.String,
  model: Schema.String,
  usage: UsageSchema,
  stopReason: Schema.String,
  errorMessage: Schema.optionalKey(Schema.String),
});
const MessageUpdateSchema = Schema.Struct({
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
const FinalAssistantEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("turn_end"),
    message: AssistantMessageSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("message_end"),
    message: AssistantMessageSchema,
  }),
]);
const ToolContentSchema = Schema.Array(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
    Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
  ]),
);
const ToolResultSchema = Schema.Struct({
  content: ToolContentSchema,
  details: Schema.optionalKey(Schema.Unknown),
});
const ToolEventSchema = Schema.Union([
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
const BlockingExtensionUiSchema = Schema.Union([
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
const NonBlockingExtensionUiSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("notify"),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("setStatus"),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("setWidget"),
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
const AgentStartedSchema = Schema.Struct({ type: Schema.Literal("agent_start") });
const SettledSchema = Schema.Struct({ type: Schema.Literal("agent_settled") });
const IgnoredAgentEndSchema = Schema.Struct({ type: Schema.Literal("agent_end") });
const CompactionResultSchema = Schema.Struct({
  summary: Schema.String,
  firstKeptEntryId: Schema.String,
  tokensBefore: FiniteNonNegative,
  estimatedTokensAfter: Schema.optionalKey(FiniteNonNegative),
});
const CompactionEventSchema = Schema.Union([
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
const NativeEventSchema = Schema.Union([
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
const ForkResponseSchema = Schema.Struct({
  data: Schema.Struct({
    text: Schema.String,
    cancelled: Schema.Boolean,
  }),
});
const EntriesResponseSchema = Schema.Struct({
  data: Schema.Struct({
    entries: Schema.Array(PiSessionEntrySchema),
    leafId: Schema.NullOr(Schema.String),
  }),
});
const decodeResumeCursor = Schema.decodeUnknownEffect(PiResumeCursorSchema);
const decodeStateResponse = Schema.decodeUnknownEffect(StateResponseSchema);
const decodeForkResponse = Schema.decodeUnknownEffect(ForkResponseSchema);
const decodeEntriesResponse = Schema.decodeUnknownEffect(EntriesResponseSchema);
const decodeNativeEvent = Schema.decodeUnknownOption(NativeEventSchema);
const decodeAnswer = Schema.decodeUnknownOption(
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);

export type PiAdapterRpcFactory = (
  options: PiRpcOptions,
) => Effect.Effect<PiRpcClient, PiRpcError, Scope.Scope>;

export class PiAdapterAttachmentReadError extends Data.TaggedError("PiAdapterAttachmentReadError")<{
  readonly cause: unknown;
}> {}

export interface PiAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly mcpExtensionPath: string;
  readonly attachmentsDir: string;
  readonly normalizeWorkspaceCwd: (cwd: string) => string;
  readonly rpcFactory: PiAdapterRpcFactory;
  readonly readFile: (path: string) => Effect.Effect<Uint8Array, PiAdapterAttachmentReadError>;
  readonly interruptSettlementTimeout?: Duration.Input;
}

type Adapter = ProviderAdapterShape<ProviderAdapterError>;
type PiUsage = typeof UsageSchema.Type;
type PiResumeCursor = typeof PiResumeCursorSchema.Type;
type PiSessionEntry = typeof PiSessionEntrySchema.Type;
type NativeEvent = typeof NativeEventSchema.Type;
type BlockingExtensionUi = typeof BlockingExtensionUiSchema.Type;

interface PendingApproval {
  readonly method: "confirm";
  timeoutFiber: Fiber.Fiber<void> | undefined;
}

interface PendingUserInput {
  readonly method: "select" | "input" | "editor";
  readonly selectValueByLabel: ReadonlyMap<string, string> | undefined;
  timeoutFiber: Fiber.Fiber<void> | undefined;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number | undefined;
  cost: number;
}

interface PreparedModelSelection {
  readonly model: string;
  readonly thinkingLevel: PiThinkingLevel | undefined;
  readonly command:
    | {
        readonly provider: string;
        readonly modelId: string;
      }
    | undefined;
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly completion: Deferred.Deferred<void>;
  abortRequested: boolean;
  agentRunBegan: boolean;
  promptPending: boolean;
  settled: boolean;
  readonly usage: UsageTotals;
  readonly usageByModel: Map<string, UsageTotals>;
  stopReason: string | undefined;
  errorMessage: string | undefined;
  model: string;
  thinkingLevel: PiThinkingLevel | undefined;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly rpc: PiRpcClient;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  session: ProviderSession;
  model: string;
  thinkingLevel: PiThinkingLevel | undefined;
  activeTurn: ActiveTurn | undefined;
  initializing: boolean;
  turnStarting: boolean;
  compacting: boolean;
  rollbacking: boolean;
  stopped: boolean;
  explicitScopeClose: boolean;
}

function boundedText(value: string, maxChars = MAX_TOOL_DETAIL_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function nonEmpty(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return boundedText(trimmed.length > 0 ? trimmed : fallback);
}

function toolText(result: typeof ToolResultSchema.Type): string | undefined {
  const text = result.content
    .flatMap((content) => (content.type === "text" ? [content.text] : []))
    .join("\n")
    .trim();
  return text.length > 0 ? boundedText(text) : undefined;
}

function toolItemType(toolName: string) {
  const normalized = toolName.toLowerCase();
  if (normalized === "bash" || normalized.includes("command")) return "command_execution" as const;
  if (["read", "write", "edit"].includes(normalized) || normalized.includes("file")) {
    return "file_change" as const;
  }
  if (normalized.includes("mcp")) return "mcp_tool_call" as const;
  if (normalized.includes("web") || normalized.includes("search")) return "web_search" as const;
  if (normalized.includes("image")) return "image_view" as const;
  return "dynamic_tool_call" as const;
}

function emptyUsage(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: undefined,
    cost: 0,
  };
}

function addUsage(target: UsageTotals, usage: PiUsage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  if (usage.reasoning !== undefined) {
    target.reasoning = (target.reasoning ?? 0) + usage.reasoning;
  }
  target.cost += usage.cost.total;
}

function usagePayload(
  usage: UsageTotals,
  usageByModel: ReadonlyMap<string, UsageTotals>,
): {
  readonly tokenUsage: TurnTokenUsage;
  readonly totalCostUsd: number;
  readonly modelUsage: Record<string, unknown>;
} {
  const toTokenFields = (totals: UsageTotals) => ({
    inputTokens: Math.trunc(totals.input + totals.cacheRead + totals.cacheWrite),
    outputTokens: Math.trunc(totals.output),
    ...(totals.reasoning === undefined ? {} : { reasoningTokens: Math.trunc(totals.reasoning) }),
    cachedInputTokens: Math.trunc(totals.cacheRead),
    cacheCreationTokens: Math.trunc(totals.cacheWrite),
  });
  const tokenUsage: TurnTokenUsage = {
    usageScope: "main_agent",
    usageStatus: "complete",
    ...toTokenFields(usage),
    hasSubagents: false,
  };
  const modelUsage = Object.fromEntries(
    [...usageByModel].map(([model, totals]) => [
      model,
      { ...toTokenFields(totals), totalCostUsd: totals.cost },
    ]),
  );
  return { tokenUsage, totalCostUsd: usage.cost, modelUsage };
}

function optionThinkingLevel(
  selection: ProviderSendTurnInput["modelSelection"] | ProviderSessionStartInput["modelSelection"],
): PiThinkingLevel | undefined {
  const selected = selection?.options?.find((option) => option.id === "thinkingLevel")?.value;
  return Option.getOrUndefined(decodeThinkingLevel(selected));
}

function selectOptions(options: ReadonlyArray<string>): {
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description: string;
  }>;
  readonly selectValueByLabel: ReadonlyMap<string, string>;
} {
  const selectValueByLabel = new Map<string, string>();
  const normalized = options.map((value, index) => {
    const base = nonEmpty(value, `Option ${index + 1}`);
    let label = base;
    let suffix = 2;
    while (selectValueByLabel.has(label)) {
      const marker = ` (${suffix})`;
      label = `${base.slice(0, Math.max(0, MAX_TOOL_DETAIL_CHARS - marker.length))}${marker}`;
      suffix += 1;
    }
    selectValueByLabel.set(label, value);
    return { label, description: "Select this option." };
  });
  return { options: normalized, selectValueByLabel };
}

function answerValue(
  answers: ProviderUserInputAnswers,
  requestId: ApprovalRequestId,
): string | undefined {
  return Option.getOrUndefined(
    Option.map(decodeAnswer(answers[requestId]), (answer) =>
      typeof answer === "string" ? answer : answer.join("\n"),
    ),
  );
}

function mapRequestError(method: string, cause: unknown): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: "Pi rejected or could not complete the RPC request.",
    cause,
  });
}

function invalidResponse(
  method: string,
  detail: string,
  _cause?: unknown,
): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
  });
}

function normalizeHistoryMessage(
  message: typeof PiHistoryMessageSchema.Type,
): Readonly<Record<string, unknown>> {
  switch (message.role) {
    case "system":
    case "user":
    case "assistant":
      return { role: message.role, content: message.content };
    case "toolResult":
      return {
        role: message.role,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content,
        isError: message.isError,
      };
    case "bashExecution":
      return {
        role: message.role,
        command: message.command,
        output: message.output,
        ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
        cancelled: message.cancelled,
        truncated: message.truncated,
      };
    case "custom":
      return {
        role: message.role,
        customType: message.customType,
        content: message.content,
        display: message.display,
      };
    case "branchSummary":
      return {
        role: message.role,
        summary: message.summary,
        fromId: message.fromId,
      };
    case "compactionSummary":
      return {
        role: message.role,
        summary: message.summary,
        tokensBefore: message.tokensBefore,
      };
  }
}

function normalizeHistoryItem(entry: PiSessionEntry): Readonly<Record<string, unknown>> {
  const base = {
    id: entry.id,
    parentId: entry.parentId,
    type: entry.type,
    timestamp: entry.timestamp,
  } as const;
  switch (entry.type) {
    case "message":
      return { ...base, ...normalizeHistoryMessage(entry.message) };
    case "thinking_level_change":
      return { ...base, thinkingLevel: entry.thinkingLevel };
    case "model_change":
      return { ...base, provider: entry.provider, modelId: entry.modelId };
    case "usage":
      return {
        ...base,
        kind: entry.kind,
        provider: entry.provider,
        model: entry.model,
        usage: entry.usage,
        ...(entry.note === undefined ? {} : { note: entry.note }),
      };
    case "compaction":
      return {
        ...base,
        summary: entry.summary,
        firstKeptEntryId: entry.firstKeptEntryId,
        tokensBefore: entry.tokensBefore,
        ...(entry.fromHook === undefined ? {} : { fromHook: entry.fromHook }),
      };
    case "branch_summary":
      return {
        ...base,
        fromId: entry.fromId,
        summary: entry.summary,
        ...(entry.fromHook === undefined ? {} : { fromHook: entry.fromHook }),
      };
    case "custom":
      return {
        ...base,
        customType: entry.customType,
      };
    case "label":
      return {
        ...base,
        targetId: entry.targetId,
        ...(entry.label === undefined ? {} : { label: entry.label }),
      };
    case "session_info":
      return { ...base, ...(entry.name === undefined ? {} : { name: entry.name }) };
    case "custom_message":
      return {
        ...base,
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
      };
  }
}

const historyFromEntriesResponse = Effect.fnUntraced(function* (
  response: unknown,
  threadId: ThreadId,
): Effect.fn.Return<
  {
    readonly snapshot: ProviderThreadSnapshot;
    readonly userEntryIds: ReadonlyArray<string>;
  },
  ProviderAdapterRequestError
> {
  const decoded = yield* decodeEntriesResponse(response).pipe(
    Effect.mapError((cause) =>
      invalidResponse("get_entries", "Pi returned malformed session entries.", cause),
    ),
  );
  const { entries, leafId } = decoded.data;
  if (entries.length === 0) {
    if (leafId !== null) {
      return yield* invalidResponse(
        "get_entries",
        "Pi returned a history leaf without session entries.",
      );
    }
    return { snapshot: { threadId, turns: [] }, userEntryIds: [] };
  }
  if (leafId === null) {
    return yield* invalidResponse(
      "get_entries",
      "Pi returned session entries without an active history leaf.",
    );
  }

  const byId = new Map<string, PiSessionEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      return yield* invalidResponse("get_entries", "Pi returned duplicate session entry IDs.");
    }
    byId.set(entry.id, entry);
  }

  const reversed: Array<PiSessionEntry> = [];
  const visited = new Set<string>();
  let nextId: string | null = leafId;
  while (nextId !== null) {
    if (visited.has(nextId)) {
      return yield* invalidResponse("get_entries", "Pi returned a cyclic session entry graph.");
    }
    visited.add(nextId);
    const entry = byId.get(nextId);
    if (entry === undefined) {
      return yield* invalidResponse(
        "get_entries",
        "Pi returned an active history branch with a missing parent entry.",
      );
    }
    reversed.push(entry);
    nextId = entry.parentId;
  }
  const activeBranch = reversed.reverse();
  const turns: Array<{ id: TurnId; items: Array<unknown> }> = [];
  const userEntryIds: Array<string> = [];
  for (const entry of activeBranch) {
    const isUserEntry = entry.type === "message" && entry.message?.role === "user";
    if (isUserEntry) {
      userEntryIds.push(entry.id);
      turns.push({ id: TurnId.make(entry.id), items: [normalizeHistoryItem(entry)] });
      continue;
    }
    const turn = turns.at(-1);
    if (turn !== undefined) turn.items.push(normalizeHistoryItem(entry));
  }
  return {
    snapshot: { threadId, turns },
    userEntryIds,
  };
});

const makeResumeCursor = Effect.fnUntraced(function* (
  sessionId: string,
  providerInstanceId: ProviderInstanceId,
  cwd: string,
  method: string,
): Effect.fn.Return<PiResumeCursor, ProviderAdapterRequestError> {
  return yield* decodeResumeCursor({
    version: 2,
    sessionId,
    providerInstanceId,
    cwd,
  }).pipe(
    Effect.mapError((cause) =>
      invalidResponse(method, "Pi returned incomplete persisted session identity.", cause),
    ),
  );
});

export const makePiAdapter = Effect.fn("PiAdapter.make")(function* (
  options: PiAdapterOptions,
): Effect.fn.Return<Adapter, never, Scope.Scope> {
  const adapterScope = yield* Scope.Scope;
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const operationLock = yield* Semaphore.make(1);
  const sessions = new Map<ThreadId, SessionContext>();
  const rpcFactory = options.rpcFactory;
  let eventSequence = 0;
  let turnSequence = 0;

  const stamp = Effect.fnUntraced(function* () {
    eventSequence += 1;
    return {
      eventId: EventId.make(`pi:${options.instanceId}:${eventSequence}`),
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };
  });

  const emit = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

  const eventBase = Effect.fnUntraced(function* (context: SessionContext) {
    return {
      ...(yield* stamp()),
      provider: PROVIDER,
      providerInstanceId: options.instanceId,
      threadId: context.threadId,
    } as const;
  });

  const requireSession = Effect.fn("PiAdapter.requireSession")(function* (threadId: ThreadId) {
    const context = sessions.get(threadId);
    if (context === undefined || context.stopped) {
      return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
    }
    return context;
  });

  const interruptTimeout = (fiber: Fiber.Fiber<void> | undefined) =>
    fiber === undefined ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.ignore);

  const settlePendingRequests = Effect.fnUntraced(function* (context: SessionContext) {
    for (const [requestId, pending] of context.pendingApprovals) {
      yield* interruptTimeout(pending.timeoutFiber);
      yield* emit({
        ...(yield* eventBase(context)),
        type: "request.resolved",
        requestId: RuntimeRequestId.make(requestId),
        ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
        payload: { requestType: "permission_approval", decision: "cancel" },
      });
    }
    context.pendingApprovals.clear();
    for (const [requestId, pending] of context.pendingUserInputs) {
      yield* interruptTimeout(pending.timeoutFiber);
      yield* emit({
        ...(yield* eventBase(context)),
        type: "user-input.resolved",
        requestId: RuntimeRequestId.make(requestId),
        ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
        payload: { answers: {} },
      });
    }
    context.pendingUserInputs.clear();
  });

  const settleTurn = Effect.fnUntraced(function* (
    context: SessionContext,
    input: {
      readonly transportFailure?: string;
      readonly stopped?: boolean;
      readonly abortReason?: string;
    } = {},
  ) {
    const turn = context.activeTurn;
    if (turn === undefined || turn.settled) return;
    turn.settled = true;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const aborted = turn.abortRequested || turn.stopReason === "aborted" || input.stopped === true;
    const hasUsage = turn.usageByModel.size > 0;
    const usage = hasUsage ? usagePayload(turn.usage, turn.usageByModel) : undefined;
    if (aborted) {
      yield* emit({
        ...(yield* eventBase(context)),
        type: "turn.aborted",
        turnId: turn.turnId,
        payload: {
          reason: input.abortReason ?? (input.stopped ? "session stopped" : "aborted"),
          ...(usage === undefined ? {} : { tokenUsage: usage.tokenUsage }),
        },
      });
    } else {
      const failed = input.transportFailure !== undefined || turn.stopReason === "error";
      yield* emit({
        ...(yield* eventBase(context)),
        type: "turn.completed",
        turnId: turn.turnId,
        payload: {
          state: failed ? "failed" : "completed",
          ...(turn.stopReason === undefined ? {} : { stopReason: turn.stopReason }),
          ...(usage === undefined ? {} : usage),
          ...(input.transportFailure !== undefined
            ? { errorMessage: input.transportFailure }
            : turn.errorMessage
              ? { errorMessage: boundedText(turn.errorMessage) }
              : {}),
        },
      });
    }
    const { activeTurnId: _activeTurnId, ...readySession } = context.session;
    context.session = {
      ...readySession,
      status: input.transportFailure === undefined ? "ready" : "error",
      updatedAt,
      ...(input.transportFailure === undefined
        ? {}
        : { lastError: "The Pi RPC process closed unexpectedly." }),
    };
    context.activeTurn = undefined;
    yield* Deferred.succeed(turn.completion, undefined).pipe(Effect.ignore);
  });

  const handleTransportClosed = Effect.fnUntraced(function* (
    context: SessionContext,
    error: PiRpcError,
  ) {
    if (context.stopped) return;
    yield* settleTurn(context, { transportFailure: "The Pi RPC process closed unexpectedly." });
    yield* settlePendingRequests(context);
    context.stopped = true;
    sessions.delete(context.threadId);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    context.session = {
      ...context.session,
      status: "error",
      updatedAt,
      lastError: "The Pi RPC process closed unexpectedly.",
    };
    yield* emit({
      ...(yield* eventBase(context)),
      type: "session.state.changed",
      payload: { state: "error", reason: error.reason },
    });
    yield* emit({
      ...(yield* eventBase(context)),
      type: "session.exited",
      payload: { reason: error.reason, recoverable: true, exitKind: "error" },
    });
  });

  const expireRequest = Effect.fnUntraced(function* (
    context: SessionContext,
    requestId: ApprovalRequestId,
  ) {
    if (context.stopped) return;
    const approval = context.pendingApprovals.get(requestId);
    if (approval !== undefined) {
      context.pendingApprovals.delete(requestId);
      yield* emit({
        ...(yield* eventBase(context)),
        type: "request.resolved",
        requestId: RuntimeRequestId.make(requestId),
        ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
        payload: { requestType: "permission_approval", decision: "cancel" },
      });
      return;
    }
    if (!context.pendingUserInputs.has(requestId)) return;
    context.pendingUserInputs.delete(requestId);
    yield* emit({
      ...(yield* eventBase(context)),
      type: "user-input.resolved",
      requestId: RuntimeRequestId.make(requestId),
      ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
      payload: { answers: {} },
    });
  });

  const scheduleRequestTimeout = Effect.fnUntraced(function* (
    context: SessionContext,
    requestId: ApprovalRequestId,
    timeout: number | undefined,
  ) {
    if (timeout === undefined) return;
    const fiber = yield* Effect.sleep(Duration.millis(Math.max(0, timeout))).pipe(
      Effect.andThen(operationLock.withPermits(1)(expireRequest(context, requestId))),
      Effect.forkIn(context.scope),
    );
    const pending =
      context.pendingApprovals.get(requestId) ?? context.pendingUserInputs.get(requestId);
    if (pending === undefined) {
      yield* interruptTimeout(fiber);
      return;
    }
    pending.timeoutFiber = fiber;
  });

  const handleExtensionUi = Effect.fnUntraced(function* (
    context: SessionContext,
    event: BlockingExtensionUi,
  ) {
    const requestId = ApprovalRequestId.make(event.id);
    if (
      context.pendingApprovals.has(requestId) ||
      context.pendingUserInputs.has(requestId) ||
      context.stopped
    ) {
      return;
    }
    if (event.method === "select") {
      const mapped = selectOptions(event.options);
      context.pendingUserInputs.set(requestId, {
        method: "select",
        selectValueByLabel: mapped.selectValueByLabel,
        timeoutFiber: undefined,
      });
      yield* emit({
        ...(yield* eventBase(context)),
        type: "user-input.requested",
        requestId: RuntimeRequestId.make(event.id),
        ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
        payload: {
          questions: [
            {
              id: event.id,
              header: nonEmpty(event.title, "Select"),
              question: nonEmpty(event.title, "Select an option"),
              options: mapped.options,
              allowCustomAnswer: false,
              multiSelect: false,
            },
          ],
        },
      });
      yield* scheduleRequestTimeout(context, requestId, event.timeout);
      return;
    }
    if (event.method === "confirm") {
      context.pendingApprovals.set(requestId, {
        method: "confirm",
        timeoutFiber: undefined,
      });
      yield* emit({
        ...(yield* eventBase(context)),
        type: "request.opened",
        requestId: RuntimeRequestId.make(event.id),
        ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
        payload: {
          requestType: "permission_approval",
          detail: boundedText(`${nonEmpty(event.title, "Pi confirmation")}\n${event.message}`),
          options: [
            { decision: "accept", label: "Confirm" },
            { decision: "decline", label: "Decline" },
            { decision: "cancel", label: "Cancel" },
          ],
        },
      });
      yield* scheduleRequestTimeout(context, requestId, event.timeout);
      return;
    }
    context.pendingUserInputs.set(requestId, {
      method: event.method,
      selectValueByLabel: undefined,
      timeoutFiber: undefined,
    });
    const question =
      event.method === "input"
        ? nonEmpty(event.placeholder, "Enter a value")
        : nonEmpty(event.prefill, "Enter text");
    yield* emit({
      ...(yield* eventBase(context)),
      type: "user-input.requested",
      requestId: RuntimeRequestId.make(event.id),
      ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
      payload: {
        questions: [
          {
            id: event.id,
            header: nonEmpty(event.title, event.method === "input" ? "Input" : "Editor"),
            question,
            options: [],
            allowCustomAnswer: true,
            multiSelect: false,
          },
        ],
      },
    });
    yield* scheduleRequestTimeout(
      context,
      requestId,
      event.method === "input" ? event.timeout : undefined,
    );
  });

  const handleNativeEvent = Effect.fnUntraced(function* (
    context: SessionContext,
    event: PiRpcEvent,
  ) {
    if (
      event.type === "pi_rpc_transport_closed" &&
      "error" in event &&
      Schema.is(PiRpcError)(event.error)
    ) {
      yield* handleTransportClosed(context, event.error);
      return;
    }
    if (event.type === "pi_rpc_malformed_record") return;
    const decoded = decodeNativeEvent(event);
    if (Option.isNone(decoded)) return;
    const native: NativeEvent = decoded.value;
    if (native.type === "agent_start" || native.type === "agent_end") return;
    if (native.type === "agent_settled") {
      yield* settleTurn(context);
      return;
    }
    if (native.type === "compaction_start") return;
    if (native.type === "compaction_end") {
      if (!native.aborted && native.errorMessage === undefined && native.result !== undefined) {
        yield* emit({
          ...(yield* eventBase(context)),
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            detail: {
              reason: native.reason,
              tokensBefore: native.result.tokensBefore,
              ...(native.result.estimatedTokensAfter === undefined
                ? {}
                : { estimatedTokensAfter: native.result.estimatedTokensAfter }),
            },
          },
        });
      }
      return;
    }
    if (native.type === "extension_ui_request") {
      if (
        native.method === "notify" ||
        native.method === "setStatus" ||
        native.method === "setWidget" ||
        native.method === "setTitle" ||
        native.method === "set_editor_text"
      ) {
        return;
      }
      yield* handleExtensionUi(context, native);
      return;
    }
    const turn = context.activeTurn;
    if (turn === undefined || turn.settled) return;
    if (native.type === "message_update") {
      yield* emit({
        ...(yield* eventBase(context)),
        type: "content.delta",
        turnId: turn.turnId,
        payload: {
          streamKind:
            native.assistantMessageEvent.type === "text_delta"
              ? "assistant_text"
              : "reasoning_text",
          delta: native.assistantMessageEvent.delta,
          contentIndex: native.assistantMessageEvent.contentIndex,
        },
      });
      return;
    }
    // Pi 0.86.1 emits one finalized assistant message at message_end, then exposes
    // that same message again on turn_end after tool results. Count only message_end.
    if (native.type === "turn_end") return;
    if (native.type === "message_end") {
      const model = `${native.message.provider}/${native.message.model}`;
      addUsage(turn.usage, native.message.usage);
      const modelUsage = turn.usageByModel.get(model) ?? emptyUsage();
      addUsage(modelUsage, native.message.usage);
      turn.usageByModel.set(model, modelUsage);
      turn.stopReason = native.message.stopReason;
      turn.errorMessage = native.message.errorMessage;
      turn.model = model;
      context.model = model;
      return;
    }
    const itemId = RuntimeItemId.make(native.toolCallId);
    const common = {
      itemType: toolItemType(native.toolName),
      title: nonEmpty(native.toolName, "Pi tool"),
    } as const;
    if (native.type === "tool_execution_start") {
      yield* emit({
        ...(yield* eventBase(context)),
        type: "item.started",
        turnId: turn.turnId,
        itemId,
        payload: { ...common, status: "inProgress", data: { toolName: common.title } },
      });
      return;
    }
    if (native.type === "tool_execution_update") {
      yield* emit({
        ...(yield* eventBase(context)),
        type: "item.updated",
        turnId: turn.turnId,
        itemId,
        payload: {
          ...common,
          status: "inProgress",
          ...(toolText(native.partialResult) ? { detail: toolText(native.partialResult) } : {}),
        },
      });
      return;
    }
    yield* emit({
      ...(yield* eventBase(context)),
      type: "item.completed",
      turnId: turn.turnId,
      itemId,
      payload: {
        ...common,
        status: native.isError ? "failed" : "completed",
        ...(toolText(native.result) ? { detail: toolText(native.result) } : {}),
        data: { isError: native.isError },
      },
    });
  });

  const processEvents = (context: SessionContext) =>
    context.rpc.events.pipe(
      Stream.takeUntil((event) => event.type === "pi_rpc_transport_closed"),
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type !== "agent_start" && event.type !== "agent_settled") return;
          const turn = context.activeTurn;
          if (turn !== undefined && !turn.settled) turn.agentRunBegan = true;
        }).pipe(Effect.andThen(operationLock.withPermits(1)(handleNativeEvent(context, event)))),
      ),
    );

  const prepareModelSelection = Effect.fnUntraced(function* (
    context: SessionContext,
    selection:
      | ProviderSendTurnInput["modelSelection"]
      | ProviderSessionStartInput["modelSelection"],
  ): Effect.fn.Return<PreparedModelSelection, ProviderAdapterValidationError> {
    if (selection === undefined) {
      return {
        model: context.model,
        thinkingLevel: context.thinkingLevel,
        command: undefined,
      };
    }
    if (selection.instanceId !== options.instanceId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "modelSelection",
        issue: "The selected model belongs to another provider instance.",
      });
    }
    const parsed = parsePiModelSlug(selection.model);
    if (parsed === undefined) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "modelSelection",
        issue: "Pi models must use the full provider/modelId form.",
      });
    }
    return {
      model: `${parsed.provider}/${parsed.modelId}`,
      thinkingLevel: optionThinkingLevel(selection) ?? parsed.thinkingLevel,
      command: { provider: parsed.provider, modelId: parsed.modelId },
    };
  });

  // Model selection can execute extension hooks that wait for extension_ui_response.
  // Keep operation admission atomic, but never hold operationLock while awaiting Pi.
  const runModelSelection = Effect.fnUntraced(function* (
    context: SessionContext,
    selection: PreparedModelSelection,
  ) {
    if (selection.command === undefined) return;
    yield* context.rpc
      .request({
        type: "set_model",
        provider: selection.command.provider,
        modelId: selection.command.modelId,
      })
      .pipe(Effect.mapError((cause) => mapRequestError("set_model", cause)));
    if (selection.thinkingLevel !== undefined) {
      yield* context.rpc
        .request({ type: "set_thinking_level", level: selection.thinkingLevel })
        .pipe(Effect.mapError((cause) => mapRequestError("set_thinking_level", cause)));
    }
  });

  const commitModelSelection = Effect.fnUntraced(function* (
    context: SessionContext,
    selection: PreparedModelSelection,
  ) {
    if (selection.command === undefined) return;
    context.model = selection.model;
    context.thinkingLevel = selection.thinkingLevel;
    context.session = {
      ...context.session,
      model: selection.model,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };
  });

  const stopContext = Effect.fnUntraced(function* (context: SessionContext) {
    if (context.stopped) return;
    context.stopped = true;
    context.initializing = false;
    context.turnStarting = false;
    context.explicitScopeClose = true;
    sessions.delete(context.threadId);
    yield* settleTurn(context, { stopped: true });
    yield* settlePendingRequests(context);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    context.session = { ...context.session, status: "closed", updatedAt };
    yield* emit({
      ...(yield* eventBase(context)),
      type: "session.state.changed",
      payload: { state: "stopped", reason: "stopped" },
    });
    yield* emit({
      ...(yield* eventBase(context)),
      type: "session.exited",
      payload: { reason: "stopped", recoverable: false, exitKind: "graceful" },
    });
    yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
  });

  const startEventProcessing = Effect.fnUntraced(function* (context: SessionContext) {
    const eventFiber = yield* processEvents(context).pipe(Effect.forkIn(context.scope));
    yield* Fiber.await(eventFiber).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          context.explicitScopeClose ? Effect.void : Scope.close(context.scope, Exit.void),
        ),
      ),
      Effect.ignore,
      Effect.forkIn(adapterScope),
    );
  });

  const cleanupFailedStartup = Effect.fnUntraced(function* (context: SessionContext) {
    const shouldClose = yield* operationLock.withPermits(1)(
      Effect.gen(function* () {
        if (sessions.get(context.threadId) !== context || context.stopped) return false;
        context.stopped = true;
        context.initializing = false;
        context.explicitScopeClose = true;
        sessions.delete(context.threadId);
        yield* settlePendingRequests(context);
        return true;
      }),
    );
    if (shouldClose) yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
  });

  const startSession: Adapter["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.cwd === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Pi requires a workspace directory.",
        });
      }
      const cwd = options.normalizeWorkspaceCwd(input.cwd);
      const requestedCursor =
        input.resumeCursor === undefined
          ? undefined
          : yield* decodeResumeCursor(input.resumeCursor).pipe(
              Effect.mapError(
                () =>
                  new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "startSession",
                    issue: "Pi requires a valid versioned resume cursor.",
                  }),
              ),
            );
      if (requestedCursor?.providerInstanceId !== undefined) {
        if (requestedCursor.providerInstanceId !== options.instanceId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Pi resume cursors cannot be replayed across provider instances.",
          });
        }
        if (requestedCursor.cwd !== cwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Pi resume cursors cannot be replayed across workspaces.",
          });
        }
      }
      const startup = yield* operationLock.withPermits(1)(
        Effect.gen(function* () {
          const previous = sessions.get(input.threadId);
          if (previous?.initializing || previous?.rollbacking) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Pi cannot replace a session while a session identity change is running.",
            });
          }
          if (previous) yield* stopContext(previous);
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          if (
            mcpSession !== undefined &&
            (mcpSession.threadId !== input.threadId ||
              mcpSession.providerInstanceId !== options.instanceId)
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "The thread MCP credential is not bound to this Pi session.",
            });
          }
          const sessionScope = yield* Scope.make("sequential");
          const environment = {
            ...McpProviderSession.withAgentDeviceEnvironment(
              options.environment ?? process.env,
              mcpSession,
            ),
          };
          delete environment[PI_MCP_ENDPOINT_ENV];
          delete environment[PI_MCP_AUTHORIZATION_ENV];
          delete environment[PI_MCP_SCOPE_ENV];
          if (mcpSession !== undefined) {
            environment[PI_MCP_ENDPOINT_ENV] = mcpSession.endpoint;
            environment[PI_MCP_AUTHORIZATION_ENV] = mcpSession.authorizationHeader;
            environment[PI_MCP_SCOPE_ENV] = encodePiMcpScope({
              version: 1,
              environmentId: mcpSession.environmentId,
              threadId: mcpSession.threadId,
              providerSessionId: mcpSession.providerSessionId,
              providerInstanceId: mcpSession.providerInstanceId,
              runtimeMode: input.runtimeMode,
              capabilities: Array.from(mcpSession.capabilities).sort(),
            });
          }
          const rpc = yield* rpcFactory({
            binaryPath: options.binaryPath,
            cwd,
            ...(mcpSession === undefined
              ? {}
              : { args: ["--no-extensions", "--extension", options.mcpExtensionPath] }),
            ...(requestedCursor === undefined ? {} : { sessionId: requestedCursor.sessionId }),
            environment,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "The Pi RPC process could not be started.",
                  cause,
                }),
            ),
            Effect.onError(() => Scope.close(sessionScope, Exit.void)),
          );
          const stateResponse = yield* rpc.request({ type: "get_state" }).pipe(
            Effect.mapError((cause) => mapRequestError("get_state", cause)),
            Effect.onError(() => Scope.close(sessionScope, Exit.void)),
          );
          const { data: state } = yield* decodeStateResponse(stateResponse).pipe(
            Effect.mapError((cause) =>
              invalidResponse("get_state", "Pi returned an invalid session state.", cause),
            ),
            Effect.onError(() => Scope.close(sessionScope, Exit.void)),
          );
          if (requestedCursor !== undefined && state.sessionId !== requestedCursor.sessionId) {
            yield* Scope.close(sessionScope, Exit.void);
            return yield* invalidResponse(
              "get_state",
              "Pi resumed a different session than the requested cursor.",
            );
          }
          const resumeCursor = yield* makeResumeCursor(
            state.sessionId,
            options.instanceId,
            cwd,
            "get_state",
          ).pipe(Effect.onError(() => Scope.close(sessionScope, Exit.void)));
          const initialModel =
            state.model === null || state.model === undefined
              ? "pi/unselected"
              : `${state.model.provider}/${state.model.id}`;
          const initialThinking = Option.getOrUndefined(decodeThinkingLevel(state.thinkingLevel));
          const now = DateTime.formatIso(yield* DateTime.now);
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: initialModel,
            threadId: input.threadId,
            resumeCursor,
            createdAt: now,
            updatedAt: now,
          };
          const context: SessionContext = {
            threadId: input.threadId,
            scope: sessionScope,
            rpc,
            pendingApprovals: new Map(),
            pendingUserInputs: new Map(),
            session,
            model: initialModel,
            thinkingLevel: initialThinking,
            activeTurn: undefined,
            initializing: true,
            turnStarting: false,
            compacting: false,
            rollbacking: false,
            stopped: false,
            explicitScopeClose: false,
          };
          sessions.set(input.threadId, context);
          yield* startEventProcessing(context);
          return { context, state, resumeCursor };
        }),
      );

      return yield* Effect.gen(function* () {
        const resumedModel =
          startup.state.model === null || startup.state.model === undefined
            ? "pi/unselected"
            : `${startup.state.model.provider}/${startup.state.model.id}`;
        yield* operationLock.withPermits(1)(
          Effect.gen(function* () {
            if (
              startup.context.stopped ||
              sessions.get(startup.context.threadId) !== startup.context
            ) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId: startup.context.threadId,
              });
            }
            startup.context.model = resumedModel;
            startup.context.thinkingLevel = Option.getOrUndefined(
              decodeThinkingLevel(startup.state.thinkingLevel),
            );
            startup.context.session = {
              ...startup.context.session,
              model: resumedModel,
              resumeCursor: startup.resumeCursor,
            };
          }),
        );
        const selection = yield* prepareModelSelection(startup.context, input.modelSelection);
        yield* runModelSelection(startup.context, selection);
        return yield* operationLock.withPermits(1)(
          Effect.gen(function* () {
            if (
              startup.context.stopped ||
              sessions.get(startup.context.threadId) !== startup.context
            ) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId: startup.context.threadId,
              });
            }
            yield* commitModelSelection(startup.context, selection);
            startup.context.initializing = false;
            yield* emit({
              ...(yield* eventBase(startup.context)),
              type: "session.started",
              payload: {
                resume: {
                  version: startup.resumeCursor.version,
                  sessionId: startup.resumeCursor.sessionId,
                  providerInstanceId: startup.resumeCursor.providerInstanceId,
                  cwd: startup.resumeCursor.cwd,
                },
              },
            });
            yield* emit({
              ...(yield* eventBase(startup.context)),
              type: "thread.started",
              payload: { providerThreadId: startup.resumeCursor.sessionId },
            });
            yield* emit({
              ...(yield* eventBase(startup.context)),
              type: "session.state.changed",
              payload: { state: "ready" },
            });
            return { ...startup.context.session };
          }),
        );
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? cleanupFailedStartup(startup.context) : Effect.void,
        ),
      );
    });

  const resolveImages = Effect.fnUntraced(function* (input: ProviderSendTurnInput) {
    const images: Array<{
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }> = [];
    for (const attachment of input.attachments ?? []) {
      if (attachment.type !== "image") continue;
      if (!isProviderSendTurnSupportedImageMimeType(attachment.mimeType)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "prompt",
          detail: "Pi does not support this image attachment type.",
        });
      }
      const path = resolveAttachmentPath({ attachmentsDir: options.attachmentsDir, attachment });
      if (path === null) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "prompt",
          detail: "The image attachment identifier is invalid.",
        });
      }
      const bytes = yield* options.readFile(path).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "prompt",
              detail: "Pi could not read an image attachment.",
              cause,
            }),
        ),
      );
      images.push({
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType: attachment.mimeType,
      });
    }
    return images;
  });

  const sendTurn: Adapter["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const images = yield* resolveImages(input);
      const admission = yield* operationLock.withPermits(1)(
        Effect.gen(function* () {
          const context = yield* requireSession(input.threadId);
          if (
            context.initializing ||
            context.turnStarting ||
            context.activeTurn !== undefined ||
            context.compacting ||
            context.rollbacking
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: context.initializing
                ? "Pi session startup is still in progress."
                : context.compacting
                  ? "Pi cannot start a turn while context compaction is running."
                  : context.rollbacking
                    ? "Pi cannot start a turn while rollback is running."
                    : "Pi already has an active turn for this thread.",
            });
          }
          if ((input.input?.trim() ?? "").length === 0 && images.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or image attachments.",
            });
          }
          const selection = yield* prepareModelSelection(context, input.modelSelection);
          context.turnStarting = true;
          return { context, selection };
        }),
      );

      const { context, turn } = yield* Effect.gen(function* () {
        const configuration = yield* runModelSelection(admission.context, admission.selection).pipe(
          Effect.match({
            onFailure: (error) => ({ type: "failure" as const, error }),
            onSuccess: () => ({ type: "success" as const }),
          }),
        );
        if (configuration.type === "failure") return yield* configuration.error;

        return yield* operationLock.withPermits(1)(
          Effect.gen(function* () {
            const context = admission.context;
            if (context.stopped || sessions.get(input.threadId) !== context) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId: input.threadId,
              });
            }
            yield* commitModelSelection(context, admission.selection);
            context.turnStarting = false;
            turnSequence += 1;
            const turnId = TurnId.make(
              `pi:${options.instanceId}:${input.threadId}:${turnSequence}`,
            );
            const completion = yield* Deferred.make<void>();
            const turn: ActiveTurn = {
              turnId,
              completion,
              abortRequested: false,
              agentRunBegan: false,
              promptPending: true,
              settled: false,
              usage: emptyUsage(),
              usageByModel: new Map(),
              stopReason: undefined,
              errorMessage: undefined,
              model: admission.selection.model,
              thinkingLevel: admission.selection.thinkingLevel,
            };
            context.activeTurn = turn;
            context.session = {
              ...context.session,
              status: "running",
              activeTurnId: turnId,
              model: admission.selection.model,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            };
            yield* emit({
              ...(yield* eventBase(context)),
              type: "turn.started",
              turnId,
              payload: {
                model: admission.selection.model,
                ...(admission.selection.thinkingLevel === undefined
                  ? {}
                  : { effort: admission.selection.thinkingLevel }),
              },
            });
            return { context, turn };
          }),
        );
      }).pipe(
        Effect.ensuring(
          operationLock.withPermits(1)(
            Effect.sync(() => {
              admission.context.turnStarting = false;
            }),
          ),
        ),
      );

      const accepted = yield* context.rpc
        .request({
          type: "prompt",
          message: input.input ?? "",
          ...(images.length === 0 ? {} : { images }),
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(accepted)) {
        yield* operationLock.withPermits(1)(
          Effect.gen(function* () {
            turn.promptPending = false;
            if (context.activeTurn !== turn || turn.settled) return;
            turn.stopReason = "error";
            turn.errorMessage = "Pi rejected the prompt before it started.";
            yield* settleTurn(context);
          }),
        );
        return yield* mapRequestError("prompt", accepted.cause);
      }
      yield* operationLock.withPermits(1)(
        Effect.sync(() => {
          turn.promptPending = false;
        }),
      );

      const reconciliation = yield* context.rpc.request({ type: "get_state" }).pipe(
        Effect.mapError((cause) => mapRequestError("get_state", cause)),
        Effect.flatMap((response) =>
          decodeStateResponse(response).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "get_state",
                  detail: "Pi returned an invalid session state after accepting the prompt.",
                  cause,
                }),
            ),
          ),
        ),
        Effect.match({
          onFailure: (error) => ({ type: "failure" as const, error }),
          onSuccess: (state) => ({ type: "success" as const, state }),
        }),
      );
      // The RPC response and preceding native events are routed independently.
      // Yield once so agent_start/agent_settled can mark the turn before an
      // idle state is interpreted as a locally handled extension command.
      yield* Effect.yieldNow;
      const closedForReconciliationFailure = yield* operationLock.withPermits(1)(
        Effect.gen(function* () {
          if (context.stopped || context.activeTurn !== turn || turn.settled) return false;
          if (reconciliation.type === "failure") {
            if (turn.agentRunBegan) return false;
            context.stopped = true;
            context.explicitScopeClose = true;
            sessions.delete(context.threadId);
            yield* settleTurn(context, {
              transportFailure: "Pi could not reconcile prompt state.",
            });
            yield* settlePendingRequests(context);
            const updatedAt = DateTime.formatIso(yield* DateTime.now);
            context.session = {
              ...context.session,
              status: "error",
              updatedAt,
              lastError: "Pi could not reconcile prompt state.",
            };
            yield* emit({
              ...(yield* eventBase(context)),
              type: "session.state.changed",
              payload: { state: "error", reason: "prompt-state-reconciliation-failed" },
            });
            yield* emit({
              ...(yield* eventBase(context)),
              type: "session.exited",
              payload: {
                reason: "prompt-state-reconciliation-failed",
                recoverable: true,
                exitKind: "error",
              },
            });
            return true;
          }
          if (
            !turn.agentRunBegan &&
            !reconciliation.state.data.isStreaming &&
            !reconciliation.state.data.isCompacting
          ) {
            yield* settleTurn(context);
          }
          return false;
        }),
      );
      if (closedForReconciliationFailure) {
        yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
        if (reconciliation.type === "failure") return yield* reconciliation.error;
      }
      return {
        threadId: input.threadId,
        turnId: turn.turnId,
        resumeCursor: context.session.resumeCursor,
      };
    });

  const compactThread = Effect.fn("PiAdapter.compactThread")(function* (
    threadId: ThreadId,
    modelSelection?: ProviderSendTurnInput["modelSelection"],
  ) {
    const admission = yield* operationLock.withPermits(1)(
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (
          context.initializing ||
          context.turnStarting ||
          context.activeTurn !== undefined ||
          context.compacting ||
          context.rollbacking
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "compactThread",
            issue: context.compacting
              ? "Pi context compaction is already running."
              : "Pi cannot compact while another session operation is running.",
          });
        }
        const selection = yield* prepareModelSelection(context, modelSelection);
        context.compacting = true;
        return { context, selection };
      }),
    );

    yield* Effect.gen(function* () {
      yield* runModelSelection(admission.context, admission.selection);
      yield* operationLock.withPermits(1)(
        Effect.gen(function* () {
          if (admission.context.stopped || sessions.get(threadId) !== admission.context) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }
          yield* commitModelSelection(admission.context, admission.selection);
        }),
      );
      yield* admission.context.rpc.request({ type: "compact" }).pipe(
        Effect.mapError((cause) => mapRequestError("compact", cause)),
        Effect.asVoid,
      );
    }).pipe(
      Effect.ensuring(
        operationLock.withPermits(1)(
          Effect.sync(() => {
            admission.context.compacting = false;
          }),
        ),
      ),
    );
  });

  const closeMissingSettlement = Effect.fnUntraced(function* (
    context: SessionContext,
    turn: ActiveTurn,
  ) {
    const shouldClose = yield* operationLock.withPermits(1)(
      Effect.gen(function* () {
        if (context.stopped || context.activeTurn !== turn || turn.settled) return false;
        context.stopped = true;
        context.explicitScopeClose = true;
        sessions.delete(context.threadId);
        yield* settleTurn(context, { abortReason: "interrupt settlement timed out" });
        yield* settlePendingRequests(context);
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        context.session = {
          ...context.session,
          status: "error",
          updatedAt,
          lastError: "Pi did not settle after accepting the abort request.",
        };
        yield* emit({
          ...(yield* eventBase(context)),
          type: "session.state.changed",
          payload: { state: "error", reason: "interrupt-timeout" },
        });
        yield* emit({
          ...(yield* eventBase(context)),
          type: "session.exited",
          payload: {
            reason: "interrupt-timeout",
            recoverable: true,
            exitKind: "error",
          },
        });
        return true;
      }),
    );
    if (shouldClose) yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
  });

  const interruptTurn: Adapter["interruptTurn"] = (threadId, requestedTurnId) =>
    Effect.gen(function* () {
      const decision = yield* operationLock.withPermits(1)(
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          const turn = context.activeTurn;
          if (
            turn === undefined ||
            (requestedTurnId !== undefined && requestedTurnId !== turn.turnId)
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "interruptTurn",
              issue: "The requested Pi turn is not active.",
            });
          }
          if (!turn.agentRunBegan && turn.promptPending) {
            turn.abortRequested = true;
            context.stopped = true;
            context.turnStarting = false;
            context.explicitScopeClose = true;
            sessions.delete(context.threadId);
            yield* settleTurn(context, { abortReason: "interrupted-before-prompt" });
            yield* settlePendingRequests(context);
            const updatedAt = DateTime.formatIso(yield* DateTime.now);
            context.session = { ...context.session, status: "closed", updatedAt };
            yield* emit({
              ...(yield* eventBase(context)),
              type: "session.state.changed",
              payload: { state: "stopped", reason: "interrupted-before-prompt" },
            });
            yield* emit({
              ...(yield* eventBase(context)),
              type: "session.exited",
              payload: {
                reason: "interrupted-before-prompt",
                recoverable: false,
                exitKind: "graceful",
              },
            });
            return { type: "terminate" as const, context };
          }
          return { type: "abort" as const, context, turn };
        }),
      );
      if (decision.type === "terminate") {
        yield* Scope.close(decision.context.scope, Exit.void).pipe(Effect.ignore);
        return;
      }

      yield* decision.context.rpc
        .request({ type: "abort" })
        .pipe(Effect.mapError((cause) => mapRequestError("abort", cause)));
      const shouldAwait = yield* operationLock.withPermits(1)(
        Effect.sync(() => {
          if (
            decision.context.stopped ||
            decision.context.activeTurn !== decision.turn ||
            decision.turn.settled
          ) {
            return false;
          }
          decision.turn.abortRequested = true;
          return true;
        }),
      );
      if (!shouldAwait) return;
      const watchdog = yield* Deferred.await(decision.turn.completion).pipe(
        Effect.timeoutOption(
          options.interruptSettlementTimeout ?? DEFAULT_INTERRUPT_SETTLEMENT_TIMEOUT,
        ),
        Effect.flatMap(
          Option.match({
            onNone: () => closeMissingSettlement(decision.context, decision.turn),
            onSome: () => Effect.void,
          }),
        ),
        Effect.forkIn(adapterScope),
      );
      yield* Fiber.join(watchdog);
    });

  const respondToRequest: Adapter["respondToRequest"] = (threadId, requestId, decision) =>
    operationLock.withPermits(1)(
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (pending === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: "This Pi approval request is no longer pending.",
          });
        }
        yield* context.rpc
          .notify(
            decision === "cancel"
              ? { type: "extension_ui_response", id: requestId, cancelled: true }
              : {
                  type: "extension_ui_response",
                  id: requestId,
                  confirmed:
                    decision === "accept" ||
                    decision === "acceptForSession" ||
                    decision === "acceptAlways",
                },
          )
          .pipe(Effect.mapError((cause) => mapRequestError("extension_ui_response", cause)));
        context.pendingApprovals.delete(requestId);
        yield* interruptTimeout(pending.timeoutFiber);
        yield* emit({
          ...(yield* eventBase(context)),
          type: "request.resolved",
          requestId: RuntimeRequestId.make(requestId),
          ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
          payload: { requestType: "permission_approval", decision },
        });
      }),
    );

  const respondToUserInput: Adapter["respondToUserInput"] = (threadId, requestId, answers) =>
    operationLock.withPermits(1)(
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (pending === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: "This Pi user-input request is no longer pending.",
          });
        }
        const answer = answerValue(answers, requestId);
        const value =
          pending.method === "select" && answer !== undefined
            ? pending.selectValueByLabel?.get(answer)
            : answer;
        if (pending.method === "select" && answer !== undefined && value === undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: "Select one of Pi's offered choices.",
          });
        }
        yield* context.rpc
          .notify(
            value === undefined
              ? { type: "extension_ui_response", id: requestId, cancelled: true }
              : { type: "extension_ui_response", id: requestId, value },
          )
          .pipe(Effect.mapError((cause) => mapRequestError("extension_ui_response", cause)));
        context.pendingUserInputs.delete(requestId);
        yield* interruptTimeout(pending.timeoutFiber);
        yield* emit({
          ...(yield* eventBase(context)),
          type: "user-input.resolved",
          requestId: RuntimeRequestId.make(requestId),
          ...(context.activeTurn ? { turnId: context.activeTurn.turnId } : {}),
          payload: { answers },
        });
      }),
    );

  const readThread: Adapter["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* operationLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* requireSession(threadId);
          if (current.initializing || current.rollbacking) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "readThread",
              issue: "Pi cannot read history while session identity is changing.",
            });
          }
          return current;
        }),
      );
      const response = yield* context.rpc
        .request({ type: "get_entries" })
        .pipe(Effect.mapError((cause) => mapRequestError("get_entries", cause)));
      return (yield* historyFromEntriesResponse(response, threadId)).snapshot;
    });

  const closeReboundSession = Effect.fnUntraced(function* (
    context: SessionContext,
    reason: string,
  ) {
    const shouldClose = yield* operationLock.withPermits(1)(
      Effect.gen(function* () {
        if (context.stopped || sessions.get(context.threadId) !== context) return false;
        context.stopped = true;
        context.rollbacking = false;
        context.explicitScopeClose = true;
        sessions.delete(context.threadId);
        yield* settlePendingRequests(context);
        context.session = {
          ...context.session,
          status: "error",
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          lastError: "Pi rollback could not verify the replacement session.",
        };
        yield* emit({
          ...(yield* eventBase(context)),
          type: "session.state.changed",
          payload: { state: "error", reason },
        });
        yield* emit({
          ...(yield* eventBase(context)),
          type: "session.exited",
          payload: { reason, recoverable: true, exitKind: "error" },
        });
        return true;
      }),
    );
    if (shouldClose) yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
  });

  const rollbackThread: Adapter["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      if (!Number.isSafeInteger(numTurns) || numTurns <= 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Pi rollback requires a positive whole number of turns.",
        });
      }
      const admission = yield* operationLock.withPermits(1)(
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          if (
            context.initializing ||
            context.turnStarting ||
            context.activeTurn !== undefined ||
            context.compacting ||
            context.rollbacking ||
            context.pendingApprovals.size > 0 ||
            context.pendingUserInputs.size > 0
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "Pi rollback requires an idle session without pending requests.",
            });
          }
          const cursor = yield* decodeResumeCursor(context.session.resumeCursor).pipe(
            Effect.mapError(() =>
              invalidResponse("fork", "The active Pi session has an invalid resume cursor."),
            ),
          );
          context.rollbacking = true;
          return { context, cursor };
        }),
      );
      let forkStarted = false;
      let forkSettledWithoutReplacement = false;

      return yield* Effect.gen(function* () {
        const entriesResponse = yield* admission.context.rpc
          .request({ type: "get_entries" })
          .pipe(Effect.mapError((cause) => mapRequestError("get_entries", cause)));
        const history = yield* historyFromEntriesResponse(entriesResponse, threadId);
        if (numTurns > history.userEntryIds.length) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Pi cannot roll back more turns than exist on the active branch.",
          });
        }
        const entryId = history.userEntryIds.at(-numTurns);
        if (entryId === undefined) {
          return yield* invalidResponse("fork", "Pi could not select a rollback entry.");
        }

        forkStarted = true;
        const forkResponse = yield* admission.context.rpc.request({ type: "fork", entryId }).pipe(
          Effect.mapError((cause) => mapRequestError("fork", cause)),
          Effect.onError(() => closeReboundSession(admission.context, "rollback-fork-failed")),
        );
        const fork = yield* decodeForkResponse(forkResponse).pipe(
          Effect.mapError((cause) =>
            invalidResponse("fork", "Pi returned an invalid fork response.", cause),
          ),
          Effect.onError(() => closeReboundSession(admission.context, "rollback-fork-invalid")),
        );
        if (fork.data.cancelled) {
          forkSettledWithoutReplacement = true;
          return yield* invalidResponse("fork", "Pi cancelled the requested rollback.");
        }

        const stateResponse = yield* admission.context.rpc.request({ type: "get_state" }).pipe(
          Effect.mapError((cause) => mapRequestError("get_state", cause)),
          Effect.onError(() =>
            closeReboundSession(admission.context, "rollback-state-verification-failed"),
          ),
        );
        const { data: state } = yield* decodeStateResponse(stateResponse).pipe(
          Effect.mapError((cause) =>
            invalidResponse("get_state", "Pi returned invalid state after rollback.", cause),
          ),
          Effect.onError(() =>
            closeReboundSession(admission.context, "rollback-state-verification-failed"),
          ),
        );
        const resumeCursor = yield* makeResumeCursor(
          state.sessionId,
          options.instanceId,
          admission.cursor.cwd,
          "get_state",
        ).pipe(
          Effect.onError(() =>
            closeReboundSession(admission.context, "rollback-state-verification-failed"),
          ),
        );
        if (resumeCursor.sessionId === admission.cursor.sessionId) {
          yield* closeReboundSession(admission.context, "rollback-identity-mismatch");
          return yield* invalidResponse(
            "fork",
            "Pi did not replace the session identity during rollback.",
          );
        }
        const postEntriesResponse = yield* admission.context.rpc
          .request({ type: "get_entries" })
          .pipe(
            Effect.mapError((cause) => mapRequestError("get_entries", cause)),
            Effect.onError(() =>
              closeReboundSession(admission.context, "rollback-history-verification-failed"),
            ),
          );
        const postHistory = yield* historyFromEntriesResponse(postEntriesResponse, threadId).pipe(
          Effect.onError(() =>
            closeReboundSession(admission.context, "rollback-history-verification-failed"),
          ),
        );
        const expectedUserEntryIds = history.userEntryIds.slice(0, -numTurns);
        if (
          postHistory.userEntryIds.length !== expectedUserEntryIds.length ||
          postHistory.userEntryIds.some(
            (candidate, index) => candidate !== expectedUserEntryIds[index],
          )
        ) {
          yield* closeReboundSession(admission.context, "rollback-history-mismatch");
          return yield* invalidResponse(
            "get_entries",
            "Pi returned an unexpected active branch after rollback.",
          );
        }
        const model =
          state.model === null || state.model === undefined
            ? "pi/unselected"
            : `${state.model.provider}/${state.model.id}`;
        return yield* operationLock.withPermits(1)(
          Effect.gen(function* () {
            if (
              admission.context.stopped ||
              sessions.get(threadId) !== admission.context ||
              !admission.context.rollbacking
            ) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId,
              });
            }
            admission.context.model = model;
            admission.context.thinkingLevel = Option.getOrUndefined(
              decodeThinkingLevel(state.thinkingLevel),
            );
            admission.context.rollbacking = false;
            admission.context.session = {
              ...admission.context.session,
              model,
              status: "ready",
              resumeCursor,
              activeTurnId: undefined,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
              lastError: undefined,
            };
            return postHistory.snapshot;
          }),
        );
      }).pipe(
        Effect.onInterrupt(() =>
          forkStarted && !forkSettledWithoutReplacement
            ? closeReboundSession(admission.context, "rollback-interrupted")
            : Effect.void,
        ),
        Effect.ensuring(
          operationLock.withPermits(1)(
            Effect.sync(() => {
              if (sessions.get(threadId) === admission.context && !admission.context.stopped) {
                admission.context.rollbacking = false;
              }
            }),
          ),
        ),
      );
    });

  const stopSession: Adapter["stopSession"] = (threadId) =>
    operationLock.withPermits(1)(
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (context.initializing || context.rollbacking) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "stopSession",
            issue: "Pi cannot stop while session identity is changing.",
          });
        }
        yield* stopContext(context);
      }),
    );

  const stopAll: Adapter["stopAll"] = () =>
    operationLock.withPermits(1)(
      Effect.forEach([...sessions.values()], stopContext, { concurrency: 1, discard: true }),
    );

  yield* Scope.addFinalizer(
    adapterScope,
    stopAll().pipe(Effect.ignore, Effect.andThen(Queue.shutdown(runtimeEvents))),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: true },
    compaction: { type: "native", start: compactThread },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions: () =>
      Effect.sync(() => [...sessions.values()].map(({ session }) => ({ ...session }))),
    hasSession: (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      }),
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEvents),
  } satisfies Adapter;
});
