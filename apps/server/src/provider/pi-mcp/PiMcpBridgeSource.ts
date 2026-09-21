export const PI_MCP_ENDPOINT_ENV = "T3_PI_MCP_ENDPOINT";
export const PI_MCP_AUTHORIZATION_ENV = "T3_PI_MCP_AUTHORIZATION";
export const PI_MCP_SCOPE_ENV = "T3_PI_MCP_SCOPE";

const bridgeFactorySource = String.raw`
async function t3PiMcpExtension(pi, injectedRuntime) {
  const runtime = injectedRuntime ?? {
    env: process.env,
    fetch: globalThis.fetch.bind(globalThis),
    TextDecoder: globalThis.TextDecoder,
    TextEncoder: globalThis.TextEncoder,
  };
  const endpoint = runtime.env.T3_PI_MCP_ENDPOINT;
  const authorization = runtime.env.T3_PI_MCP_AUTHORIZATION;
  const rawScope = runtime.env.T3_PI_MCP_SCOPE;

  if (endpoint === undefined && authorization === undefined && rawScope === undefined) return;
  if (
    typeof endpoint !== "string" ||
    typeof authorization !== "string" ||
    typeof rawScope !== "string"
  ) {
    throw new Error("T3 MCP bridge startup failed.");
  }

  const isRecord = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const isJsonValue = (value, depth = 0) => {
    if (depth > 20) return false;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) return true;
    if (Array.isArray(value)) return value.length <= 10_000 && value.every((item) => isJsonValue(item, depth + 1));
    if (!isRecord(value) || Object.keys(value).length > 10_000) return false;
    return Object.entries(value).every(
      ([key, item]) => key.length <= 10_000 && isJsonValue(item, depth + 1),
    );
  };
  const parseJson = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("T3 MCP returned malformed protocol data.");
    }
  };
  if (endpoint.length > 4_096 || authorization.length > 16_384 || rawScope.length > 65_536) {
    throw new Error("T3 MCP bridge startup failed.");
  }
  const scope = parseJson(rawScope);
  const isBoundedIdentifier = (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 4_096;
  if (
    !isRecord(scope) ||
    scope.version !== 1 ||
    !isBoundedIdentifier(scope.environmentId) ||
    !isBoundedIdentifier(scope.threadId) ||
    !isBoundedIdentifier(scope.providerSessionId) ||
    !isBoundedIdentifier(scope.providerInstanceId) ||
    !["approval-required", "auto-accept-edits", "auto", "full-access"].includes(scope.runtimeMode) ||
    !Array.isArray(scope.capabilities) ||
    scope.capabilities.length > 64 ||
    !scope.capabilities.every(
      (capability) =>
        typeof capability === "string" && capability.length > 0 && capability.length <= 128,
    )
  ) {
    throw new Error("T3 MCP bridge startup failed.");
  }

  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error("T3 MCP bridge startup failed.");
  }
  if (
    (parsedEndpoint.protocol !== "http:" && parsedEndpoint.protocol !== "https:") ||
    parsedEndpoint.username.length > 0 ||
    parsedEndpoint.password.length > 0 ||
    !authorization.startsWith("Bearer ") ||
    authorization.length <= "Bearer ".length
  ) {
    throw new Error("T3 MCP bridge startup failed.");
  }

  const encoder = new runtime.TextEncoder();
  const decoder = new runtime.TextDecoder();
  const MAX_PROTOCOL_BYTES = 16 * 1024 * 1024;
  const MAX_REQUEST_BYTES = 1024 * 1024;
  const MAX_SCHEMA_BYTES = 256 * 1024;
  const MAX_TEXT_BYTES = 50 * 1024;
  const MAX_STRUCTURED_BYTES = 50 * 1024;
  const MAX_IMAGE_BASE64_CHARS = 14 * 1024 * 1024;
  const MAX_ERROR_CHARS = 1_024;
  const MAX_TOOLS = 256;
  const MAX_PAGES = 16;
  const supportedImageTypes = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ]);
  const sensitiveValues = [
    endpoint,
    authorization,
    authorization.slice("Bearer ".length),
    rawScope,
    scope.environmentId,
    scope.threadId,
    scope.providerSessionId,
    scope.providerInstanceId,
  ].filter((value) => typeof value === "string" && value.length > 0);
  const redact = (value) => {
    let redacted = String(value)
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/https?:\/\/[^\s)\]}>,]+/gi, "[redacted-url]");
    for (const sensitive of sensitiveValues) redacted = redacted.split(sensitive).join("[redacted]");
    return redacted;
  };
  const redactError = (value) => {
    const redacted = redact(value);
    return redacted.length <= MAX_ERROR_CHARS
      ? redacted
      : redacted.slice(0, MAX_ERROR_CHARS - 1) + "…";
  };
  const utf8Length = (value) => encoder.encode(value).byteLength;
  const sanitizeJson = (value) => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(sanitizeJson);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key), sanitizeJson(item)]),
    );
  };
  const truncateUtf8 = (value, maxBytes) => {
    if (utf8Length(value) <= maxBytes) return value;
    let low = 0;
    let high = value.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (utf8Length(value.slice(0, middle)) <= maxBytes - 3) low = middle;
      else high = middle - 1;
    }
    return value.slice(0, low) + "…";
  };
  const readBoundedBody = async (response) => {
    if (!response.body || typeof response.body.getReader !== "function") {
      const text = await response.text();
      if (utf8Length(text) > MAX_PROTOCOL_BYTES) {
        throw new Error("T3 MCP returned an oversized protocol response.");
      }
      return text;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) {
          throw new Error("T3 MCP returned malformed protocol data.");
        }
        total += next.value.byteLength;
        if (total > MAX_PROTOCOL_BYTES) {
          await reader.cancel();
          throw new Error("T3 MCP returned an oversized protocol response.");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock?.();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return decoder.decode(bytes);
  };
  const parseResponseBody = (body, contentType, expectedId) => {
    const payloads = contentType.includes("text/event-stream")
      ? body
          .split(/\r?\n\r?\n/)
          .map((event) =>
            event
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n"),
          )
          .filter((value) => value.length > 0)
      : [body];
    for (const payload of payloads) {
      const parsed = parseJson(payload);
      if (isRecord(parsed) && parsed.jsonrpc === "2.0" && parsed.id === expectedId) return parsed;
    }
    throw new Error("T3 MCP returned an unrelated protocol response.");
  };

  let sessionId;
  let requestId = 0;
  let closed = false;
  const send = async (method, params, signal, notification = false) => {
    if (closed) throw new Error("T3 MCP session is closed.");
    signal?.throwIfAborted?.();
    const id = notification ? undefined : ++requestId;
    const message = {
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      method,
      ...(params === undefined ? {} : { params }),
    };
    let requestBody;
    try {
      requestBody = JSON.stringify(message);
    } catch {
      throw new Error("T3 MCP request contained malformed protocol data.");
    }
    if (utf8Length(requestBody) > MAX_REQUEST_BYTES) {
      throw new Error("T3 MCP request exceeded the protocol limit.");
    }
    let response;
    try {
      response = await runtime.fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json, text/event-stream",
          authorization,
          "content-type": "application/json",
          ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
          ...(sessionId === undefined ? {} : { "mcp-protocol-version": "2025-06-18" }),
        },
        body: requestBody,
        signal,
      });
    } catch (error) {
      if (signal?.aborted || (isRecord(error) && error.name === "AbortError")) throw error;
      throw new Error("T3 MCP transport failed.");
    }
    if (!response.ok) throw new Error("T3 MCP request failed with status " + response.status + ".");
    if (sessionId === undefined) {
      const issuedSessionId = response.headers.get("mcp-session-id");
      if (typeof issuedSessionId === "string" && issuedSessionId.length > 0 && issuedSessionId.length <= 4_096) {
        sessionId = issuedSessionId;
      }
    }
    if (notification) return undefined;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
      throw new Error("T3 MCP returned an unsupported protocol response.");
    }
    const body = await readBoundedBody(response);
    const decoded = parseResponseBody(body, contentType, id);
    if (Object.hasOwn(decoded, "error")) {
      const protocolError = decoded.error;
      const code = isRecord(protocolError) && (typeof protocolError.code === "number" || typeof protocolError.code === "string")
        ? " (code " + redactError(String(protocolError.code)).slice(0, 64) + ")"
        : "";
      const messageText = isRecord(protocolError) && typeof protocolError.message === "string"
        ? ": " + redactError(protocolError.message)
        : "";
      throw new Error("T3 MCP request failed" + code + messageText + ".");
    }
    if (!Object.hasOwn(decoded, "result")) {
      throw new Error("T3 MCP returned malformed protocol data.");
    }
    return decoded.result;
  };

  const closeSession = async () => {
    if (closed) return;
    closed = true;
    if (sessionId === undefined) return;
    try {
      await runtime.fetch(endpoint, {
        method: "DELETE",
        redirect: "error",
        headers: {
          authorization,
          "mcp-protocol-version": "2025-06-18",
          "mcp-session-id": sessionId,
        },
      });
    } catch {
      // ProviderService owns credential revocation; transport cleanup is best-effort.
    }
  };

  let extensionReady = false;
  try {
  const initialize = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t3-code-pi-bridge", version: "1" },
  });
  if (
    sessionId === undefined ||
    !isRecord(initialize) ||
    initialize.protocolVersion !== "2025-06-18" ||
    !isRecord(initialize.capabilities) ||
    !isRecord(initialize.serverInfo) ||
    typeof initialize.serverInfo.name !== "string" ||
    typeof initialize.serverInfo.version !== "string"
  ) {
    throw new Error("T3 MCP bridge startup failed.");
  }
  await send("notifications/initialized", undefined, undefined, true);

  const cloneJsonSchema = (value) => {
    if (!isJsonValue(value)) throw new Error("T3 MCP returned an invalid tool schema.");
    const serialized = JSON.stringify(value);
    if (utf8Length(serialized) > MAX_SCHEMA_BYTES) {
      throw new Error("T3 MCP returned an oversized tool schema.");
    }
    return JSON.parse(serialized);
  };
  const tools = [];
  const seenCursors = new Set();
  let cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const listed = await send("tools/list", cursor === undefined ? {} : { cursor });
    if (!isRecord(listed) || !Array.isArray(listed.tools)) {
      throw new Error("T3 MCP returned a malformed tool list.");
    }
    for (const tool of listed.tools) {
      if (
        !isRecord(tool) ||
        typeof tool.name !== "string" ||
        !/^[A-Za-z0-9_.-]{1,123}$/.test(tool.name) ||
        sensitiveValues.includes(tool.name) ||
        (tool.title !== undefined && typeof tool.title !== "string") ||
        (tool.description !== undefined && typeof tool.description !== "string") ||
        !isRecord(tool.inputSchema)
      ) {
        throw new Error("T3 MCP returned a malformed tool definition.");
      }
      const inputSchema = sanitizeJson(cloneJsonSchema(tool.inputSchema));
      if (!isRecord(inputSchema) || (inputSchema.type !== undefined && inputSchema.type !== "object")) {
        throw new Error("T3 MCP returned a non-object tool schema.");
      }
      tools.push({
        name: "t3__" + tool.name,
        mcpName: tool.name,
        label: typeof tool.title === "string" ? truncateUtf8(redact(tool.title), 512) : tool.name,
        description:
          typeof tool.description === "string"
            ? truncateUtf8(redact(tool.description), 4_096)
            : "T3 Code MCP tool",
        parameters: inputSchema,
      });
      if (tools.length > MAX_TOOLS) throw new Error("T3 MCP returned too many tools.");
    }
    if (listed.nextCursor === undefined) break;
    if (
      typeof listed.nextCursor !== "string" ||
      listed.nextCursor.length === 0 ||
      listed.nextCursor.length > 4_096 ||
      seenCursors.has(listed.nextCursor)
    ) {
      throw new Error("T3 MCP returned an invalid tool cursor.");
    }
    seenCursors.add(listed.nextCursor);
    cursor = listed.nextCursor;
    if (page === MAX_PAGES - 1) throw new Error("T3 MCP returned too many tool pages.");
  }

  const names = new Set();
  const mcpToolNames = new Set();
  const mapResult = (result) => {
    if (
      !isRecord(result) ||
      !Array.isArray(result.content) ||
      result.content.length > 512
    ) {
      throw new Error("T3 MCP returned a malformed tool result.");
    }
    const content = [];
    let remainingTextBytes = MAX_TEXT_BYTES;
    for (const item of result.content) {
      if (!isRecord(item) || typeof item.type !== "string") {
        throw new Error("T3 MCP returned a malformed tool result.");
      }
      if (item.type === "text") {
        if (typeof item.text !== "string") throw new Error("T3 MCP returned malformed text.");
        if (remainingTextBytes <= 0) continue;
        const text = truncateUtf8(redact(item.text), remainingTextBytes);
        remainingTextBytes -= utf8Length(text);
        content.push({ type: "text", text });
        continue;
      }
      if (item.type === "image") {
        if (
          typeof item.mimeType !== "string" ||
          !supportedImageTypes.has(item.mimeType) ||
          typeof item.data !== "string" ||
          item.data.length > MAX_IMAGE_BASE64_CHARS ||
          item.data.length % 4 !== 0 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data)
        ) {
          throw new Error("T3 MCP returned an unsupported image.");
        }
        content.push({ type: "image", mimeType: item.mimeType, data: item.data });
      }
    }
    if (content.length === 0) content.push({ type: "text", text: "T3 MCP tool returned no supported content." });

    let structuredContent;
    if (result.structuredContent !== undefined) {
      if (!isJsonValue(result.structuredContent)) {
        throw new Error("T3 MCP returned malformed structured content.");
      }
      const serialized = JSON.stringify(result.structuredContent);
      const sanitized = sanitizeJson(JSON.parse(serialized));
      structuredContent = utf8Length(JSON.stringify(sanitized)) <= MAX_STRUCTURED_BYTES
        ? sanitized
        : { omitted: "T3 MCP structured content exceeded the output limit." };
    }
    if (result.isError !== undefined && typeof result.isError !== "boolean") {
      throw new Error("T3 MCP returned an invalid error marker.");
    }
    return {
      content,
      details: {
        __t3McpBridge: true,
        isError: result.isError === true,
        ...(structuredContent === undefined ? {} : { structuredContent }),
      },
    };
  };

  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error("T3 MCP returned duplicate tool names.");
    names.add(tool.name);
    mcpToolNames.add(tool.name);
    const { mcpName, ...definition } = tool;
    pi.registerTool({
      ...definition,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted?.();
        if (!isRecord(params) || !isJsonValue(params)) {
          throw new Error("T3 MCP tool arguments were malformed.");
        }
        if (scope.runtimeMode !== "full-access") {
          const approved = await ctx.ui.confirm(
            "Approve T3 tool",
            "Allow " + tool.label + " to run?",
            signal === undefined ? undefined : { signal },
          );
          signal?.throwIfAborted?.();
          if (!approved) {
            return mapResult({
              content: [{ type: "text", text: "T3 MCP tool call was not approved." }],
              isError: true,
            });
          }
        }
        return mapResult(await send("tools/call", { name: mcpName, arguments: params }, signal));
      },
    });
  }

  pi.on("tool_result", (event) => {
    if (!mcpToolNames.has(event.toolName) || !isRecord(event.details) || event.details.__t3McpBridge !== true) {
      return undefined;
    }
    const { __t3McpBridge: _marker, isError, ...details } = event.details;
    return { details, isError: isError === true };
  });

  pi.on("session_shutdown", closeSession);
  extensionReady = true;
  } finally {
    if (!extensionReady) await closeSession();
  }
}
`;

export const PI_MCP_EXTENSION_SOURCE = `${bridgeFactorySource}\nexport default t3PiMcpExtension;\n`;

export const __testing = {
  loadBridgeFactory: () =>
    Function(`"use strict"; ${bridgeFactorySource}; return t3PiMcpExtension;`)() as (
      pi: unknown,
      runtime: unknown,
    ) => Promise<void>,
};
