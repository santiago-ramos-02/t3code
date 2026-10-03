/**
 * Engram's memory tools as agents call them, read for the activity log and the Memory page.
 * Providers name MCP tools differently (`mcp__engram__mem_save`, `mcp__plugin_engram_engram__mem_save`,
 * `engram.mem_save`, or a bare `mem_save` from a Pi extension), so only the tool part decides.
 */

export type EngramToolCall =
  | { readonly kind: "save"; readonly title: string | undefined }
  | { readonly kind: "update"; readonly id: number | undefined; readonly title: string | undefined }
  | { readonly kind: "search"; readonly query: string | undefined }
  | { readonly kind: "read"; readonly id: number | undefined }
  | { readonly kind: "other"; readonly tool: EngramToolName };

const TOOL_LABELS = {
  mem_save: "Save memory",
  mem_update: "Update memory",
  mem_search: "Search memory",
  mem_get_observation: "Read memory",
  mem_context: "Read recent memory",
  mem_session_summary: "Save session summary to memory",
  mem_save_prompt: "Save prompt to memory",
  mem_session_start: "Start memory session",
  mem_session_end: "End memory session",
  mem_current_project: "Check memory project",
  mem_list_projects: "List memory projects",
  mem_suggest_topic_key: "Suggest memory topic",
  mem_judge: "Judge a memory conflict",
  mem_compare: "Compare memories",
  mem_review: "Review memory",
  mem_pin: "Pin memory",
  mem_unpin: "Unpin memory",
  mem_doctor: "Check memory health",
  mem_capture_passive: "Capture learnings to memory",
} as const;

export type EngramToolName = keyof typeof TOOL_LABELS;

const isEngramToolName = (value: string): value is EngramToolName =>
  Object.hasOwn(TOOL_LABELS, value);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : undefined;
}

function asId(value: unknown): number | undefined {
  const id = typeof value === "string" ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** The Engram tool a provider's tool name refers to, or undefined for any other tool. */
export function engramToolName(toolName: string | null | undefined): EngramToolName | undefined {
  if (!toolName) return undefined;
  const match = /^(?:(?<server>.*?)(?:__|[.:/]))?(?<tool>mem_[a-z_]+)$/i.exec(toolName.trim());
  const server = match?.groups?.server;
  const tool = match?.groups?.tool?.toLowerCase();
  if (tool === undefined || !isEngramToolName(tool)) return undefined;
  // A bare `mem_save` is Engram's; a prefixed one must name Engram's server.
  return server === undefined || /engram/i.test(server) ? tool : undefined;
}

/** What an Engram tool call did, read from its input. */
export function engramToolCall(
  toolName: string | null | undefined,
  input: unknown,
): EngramToolCall | undefined {
  const tool = engramToolName(toolName);
  if (tool === undefined) return undefined;
  const record = asRecord(input);
  switch (tool) {
    case "mem_save":
      return { kind: "save", title: asText(record?.title) };
    case "mem_update":
      return { kind: "update", id: asId(record?.id), title: asText(record?.title) };
    case "mem_search":
      return { kind: "search", query: asText(record?.query) };
    case "mem_get_observation":
      return { kind: "read", id: asId(record?.id) };
    default:
      return { kind: "other", tool };
  }
}

/** The activity log heading for an Engram tool call, e.g. `Save memory: Switched to JWT`. */
export function engramToolTitle(
  toolName: string | null | undefined,
  input: unknown,
): string | undefined {
  const call = engramToolCall(toolName, input);
  if (call === undefined) return undefined;
  switch (call.kind) {
    case "save":
      return call.title ? `Save memory: ${call.title}` : TOOL_LABELS.mem_save;
    case "update":
      return call.title
        ? `Update memory: ${call.title}`
        : call.id
          ? `Update memory #${call.id}`
          : TOOL_LABELS.mem_update;
    case "search":
      return call.query ? `Search memory: “${call.query}”` : TOOL_LABELS.mem_search;
    case "read":
      return call.id ? `Read memory #${call.id}` : TOOL_LABELS.mem_get_observation;
    case "other":
      return TOOL_LABELS[call.tool];
  }
}

/** The text of a tool's output, whether a provider passed a string or MCP content blocks. */
function outputText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  const blocks = Array.isArray(output) ? output : asRecord(output)?.content;
  if (!Array.isArray(blocks)) return undefined;
  const texts = blocks.flatMap((block) => {
    const text = asRecord(block)?.text;
    return typeof text === "string" ? [text] : [];
  });
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function outputRecord(output: unknown): Record<string, unknown> | undefined {
  const text = outputText(output);
  if (text === undefined) return Array.isArray(output) ? undefined : asRecord(output);
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * What an Engram tool answered: the memory a save or update wrote, and how many memories a search
 * found. Reads Engram's JSON answer, or the compact form the server sends clients; anything else
 * reads as nothing known.
 */
export function engramToolResult(output: unknown): {
  readonly id: number | undefined;
  readonly found: number | undefined;
} {
  const record = outputRecord(output);
  const results = record?.results;
  const found = record?.found;
  return {
    id: asId(record?.memoryId ?? record?.id),
    found:
      typeof found === "number" && Number.isSafeInteger(found) && found >= 0
        ? found
        : Array.isArray(results)
          ? results.length
          : undefined,
  };
}

// The input fields clients read; a memory's content stays on the server.
const WIRE_INPUT_KEYS = ["title", "query", "id", "type", "project"] as const;

/**
 * An Engram call as the server sends it to clients: the input without the memory's content, which
 * can be far larger than the activity log needs, and only the memory id and result count from its
 * answer. Undefined for any other tool.
 */
export function compactEngramToolCall(
  toolName: string | null | undefined,
  input: unknown,
  output: unknown,
):
  | {
      readonly input: Readonly<Record<string, string | number>>;
      readonly output: { readonly memoryId?: number; readonly found?: number };
    }
  | undefined {
  if (engramToolName(toolName) === undefined) return undefined;
  const record = asRecord(input);
  const compactInput: Record<string, string | number> = {};
  for (const key of WIRE_INPUT_KEYS) {
    const value = record?.[key];
    if (typeof value === "string") compactInput[key] = value.slice(0, 300);
    else if (typeof value === "number" && Number.isFinite(value)) compactInput[key] = value;
  }
  const { id, found } = engramToolResult(output);
  return {
    input: compactInput,
    output: {
      ...(id === undefined ? {} : { memoryId: id }),
      ...(found === undefined ? {} : { found }),
    },
  };
}
