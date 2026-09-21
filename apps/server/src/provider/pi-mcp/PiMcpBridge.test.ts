// @effect-diagnostics globalFetch:off globalFetchInEffect:off - This suite exercises the bridge's native fetch transport and skips Unix permission attacks where Windows cannot create the fixture symlinks.
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import { PI_MCP_EXTENSION_DIGEST, materializePiMcpExtension } from "./PiMcpBridgeMaterializer.ts";
import {
  __testing,
  PI_MCP_AUTHORIZATION_ENV,
  PI_MCP_ENDPOINT_ENV,
  PI_MCP_EXTENSION_SOURCE,
  PI_MCP_SCOPE_ENV,
} from "./PiMcpBridgeSource.ts";

interface RegisteredTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly execute: (
    toolCallId: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: { readonly ui: { readonly confirm: () => Promise<boolean> } },
  ) => Promise<{
    readonly content: ReadonlyArray<Readonly<Record<string, unknown>>>;
    readonly details: Readonly<Record<string, unknown>>;
  }>;
}

type Handler = (event: Readonly<Record<string, unknown>>) => unknown;

function makePi(confirm = true) {
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, Handler[]>();
  return {
    tools,
    handlers,
    api: {
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
      on(event: string, handler: Handler) {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      },
    },
    context: { ui: { confirm: () => Promise.resolve(confirm) } },
  };
}

function scope(runtimeMode = "full-access") {
  return JSON.stringify({
    version: 1,
    environmentId: "environment-test",
    threadId: "thread-test",
    providerSessionId: "provider-session-test",
    providerInstanceId: "pi-test",
    runtimeMode,
    capabilities: ["preview", "pull-requests"],
  });
}

function environment(
  input: {
    readonly endpoint?: string;
    readonly authorization?: string;
    readonly scope?: string;
  } = {},
) {
  return {
    [PI_MCP_ENDPOINT_ENV]: input.endpoint ?? "http://127.0.0.1:3773/mcp",
    [PI_MCP_AUTHORIZATION_ENV]: input.authorization ?? "Bearer secret-token",
    [PI_MCP_SCOPE_ENV]: input.scope ?? scope(),
  };
}

function jsonResponse(
  body: unknown,
  options: { readonly sessionId?: string; readonly status?: number } = {},
) {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(options.sessionId === undefined ? {} : { "mcp-session-id": options.sessionId }),
    },
  });
}

function protocolFetch(input: {
  readonly toolResult?: unknown;
  readonly toolError?: unknown;
  readonly toolDefinition?: unknown;
  readonly authorization?: string;
  readonly requests?: Array<{ readonly url: string; readonly init: RequestInit }>;
}) {
  return async (url: string, init: RequestInit) => {
    input.requests?.push({ url, init });
    if (input.authorization !== undefined) {
      expect(new Headers(init.headers).get("authorization")).toBe(input.authorization);
    }
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const message = JSON.parse(String(init.body)) as {
      readonly id?: number;
      readonly method: string;
      readonly params?: unknown;
    };
    if (message.method === "initialize") {
      return jsonResponse(
        {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "T3 Code", version: "test" },
          },
        },
        { sessionId: "mcp-session-test" },
      );
    }
    if (message.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (message.method === "tools/list") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            input.toolDefinition ?? {
              name: "preview_snapshot",
              title: "Preview snapshot",
              description: "Inspect the current preview",
              inputSchema: {
                type: "object",
                properties: { includeImage: { type: "boolean" } },
                additionalProperties: false,
              },
            },
          ],
        },
      });
    }
    if (message.method === "tools/call") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: message.id,
        ...(input.toolError === undefined
          ? {
              result: input.toolResult ?? {
                content: [
                  { type: "text", text: "snapshot ready" },
                  { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
                ],
                structuredContent: { available: true },
                isError: false,
              },
            }
          : { error: input.toolError }),
      });
    }
    throw new Error(`Unexpected method ${message.method}`);
  };
}

function runtime(
  env: Readonly<Record<string, string>>,
  fetch: (url: string, init: RequestInit) => Promise<Response>,
) {
  return { env, fetch, TextDecoder, TextEncoder };
}

describe("Pi MCP bridge source", () => {
  it("stays dormant when no credential environment is present", async () => {
    const pi = makePi();
    let fetchCount = 0;

    await __testing.loadBridgeFactory()(
      pi.api,
      runtime({}, () => {
        fetchCount += 1;
        return Promise.reject(new Error("fetch must not run"));
      }),
    );

    expect(pi.tools).toEqual([]);
    expect(pi.handlers.size).toBe(0);
    expect(fetchCount).toBe(0);
  });

  it("initializes, registers discovered tools, maps results, and closes its HTTP session", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const pi = makePi();
    const fetch = protocolFetch({ requests, authorization: "Bearer secret-token" });

    await __testing.loadBridgeFactory()(pi.api, runtime(environment(), fetch));

    expect(pi.tools).toHaveLength(1);
    expect(pi.tools[0]).toMatchObject({
      name: "t3__preview_snapshot",
      parameters: { type: "object" },
    });
    expect(requests.map(({ init }) => JSON.parse(String(init.body)).method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);

    const result = await pi.tools[0]!.execute(
      "call-1",
      { includeImage: true },
      undefined,
      undefined,
      pi.context,
    );
    expect(
      requests
        .map(({ init }) => JSON.parse(String(init.body)))
        .find((message) => message.method === "tools/call")?.params,
    ).toEqual({ name: "preview_snapshot", arguments: { includeImage: true } });
    expect(result).toEqual({
      content: [
        { type: "text", text: "snapshot ready" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      ],
      details: {
        __t3McpBridge: true,
        isError: false,
        structuredContent: { available: true },
      },
    });
    const projected = pi.handlers.get("tool_result")?.[0]?.({
      toolName: "t3__preview_snapshot",
      details: result.details,
    });
    expect(projected).toEqual({
      details: { structuredContent: { available: true } },
      isError: false,
    });

    await pi.handlers.get("session_shutdown")?.[0]?.({});
    await pi.handlers.get("session_shutdown")?.[0]?.({});
    expect(requests.filter(({ init }) => init.method === "DELETE")).toHaveLength(1);
  });

  it("namespaces every MCP tool so server names cannot override Pi built-ins", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const pi = makePi();
    const fetch = protocolFetch({
      requests,
      toolDefinition: {
        name: "bash",
        title: "Server bash collision",
        description: "Must not replace Pi's built-in bash tool",
        inputSchema: { type: "object", properties: {} },
      },
    });

    await __testing.loadBridgeFactory()(pi.api, runtime(environment(), fetch));

    expect(pi.tools.map(({ name }) => name)).toEqual(["t3__bash"]);
    await pi.tools[0]!.execute("call-1", {}, undefined, undefined, pi.context);
    const call = requests
      .map(({ init }) => (init.method === "DELETE" ? undefined : JSON.parse(String(init.body))))
      .find((message) => message?.method === "tools/call");
    expect(call?.params).toEqual({ name: "bash", arguments: {} });
  });

  it("preserves MCP isError while keeping bounded text and structured content", async () => {
    const pi = makePi();
    const fetch = protocolFetch({
      toolResult: {
        content: [{ type: "text", text: `thread-test ${"x".repeat(80_000)}` }],
        structuredContent: {
          reason: "denied",
          threadId: "thread-test",
          endpoint: "http://127.0.0.1:3773/mcp",
        },
        isError: true,
      },
    });
    await __testing.loadBridgeFactory()(pi.api, runtime(environment(), fetch));

    const result = await pi.tools[0]!.execute("call-1", {}, undefined, undefined, pi.context);
    expect(
      new TextEncoder().encode(String(result.content[0]?.text)).byteLength,
    ).toBeLessThanOrEqual(50 * 1024);
    expect(String(result.content[0]?.text)).not.toContain("thread-test");
    expect(
      pi.handlers.get("tool_result")?.[0]?.({
        toolName: "t3__preview_snapshot",
        details: result.details,
      }),
    ).toEqual({
      details: {
        structuredContent: {
          reason: "denied",
          threadId: "[redacted]",
          endpoint: "[redacted-url]",
        },
      },
      isError: true,
    });
  });

  it("rejects malformed discovery payloads without exposing endpoint or authorization", async () => {
    const endpoint = "http://127.0.0.1:4999/private-mcp";
    const authorization = "Bearer private-authorization";
    const pi = makePi();
    const fetch = protocolFetch({
      toolDefinition: { name: "broken", inputSchema: "not-an-object" },
    });

    await expect(
      __testing.loadBridgeFactory()(
        pi.api,
        runtime(environment({ endpoint, authorization }), fetch),
      ),
    ).rejects.not.toThrow(endpoint);
    await expect(
      __testing.loadBridgeFactory()(
        pi.api,
        runtime(environment({ endpoint, authorization }), fetch),
      ),
    ).rejects.not.toThrow(authorization);
  });

  it("bounds and redacts private protocol errors", async () => {
    const endpoint = "http://127.0.0.1:4999/private-mcp";
    const authorization = "Bearer private-authorization";
    const pi = makePi();
    const fetch = protocolFetch({
      toolError: {
        code: "private-authorization",
        message: `${endpoint} ${authorization} ${"x".repeat(4_000)}`,
      },
    });
    await __testing.loadBridgeFactory()(
      pi.api,
      runtime(environment({ endpoint, authorization }), fetch),
    );

    const error = await pi.tools[0]!.execute("call-1", {}, undefined, undefined, pi.context).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    const rendered = String(error);
    expect(rendered).toContain("T3 MCP request failed");
    expect(rendered).not.toContain(endpoint);
    expect(rendered).not.toContain(authorization);
    expect(rendered).not.toContain("private-authorization");
    expect(rendered.length).toBeLessThan(1_200);
  });

  it("propagates abort without retrying an uncertain tool execution", async () => {
    const pi = makePi();
    let callCount = 0;
    const baseFetch = protocolFetch({});
    const fetch = async (url: string, init: RequestInit) => {
      const message = JSON.parse(String(init.body)) as { readonly method: string };
      if (message.method !== "tools/call") return baseFetch(url, init);
      callCount += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    };
    await __testing.loadBridgeFactory()(pi.api, runtime(environment(), fetch));
    const controller = new AbortController();
    const execution = pi.tools[0]!.execute("call-1", {}, controller.signal, undefined, pi.context);
    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(callCount).toBe(1);
  });

  it("keeps concurrent bridge instances credential-isolated and honors approval mode", async () => {
    const firstRequests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const secondRequests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const first = makePi();
    const second = makePi(false);
    const firstAuthorization = "Bearer first-private-token";
    const secondAuthorization = "Bearer second-private-token";

    await Promise.all([
      __testing.loadBridgeFactory()(
        first.api,
        runtime(
          environment({ authorization: firstAuthorization, scope: scope("full-access") }),
          protocolFetch({ requests: firstRequests, authorization: firstAuthorization }),
        ),
      ),
      __testing.loadBridgeFactory()(
        second.api,
        runtime(
          environment({ authorization: secondAuthorization, scope: scope("approval-required") }),
          protocolFetch({ requests: secondRequests, authorization: secondAuthorization }),
        ),
      ),
    ]);

    await Promise.all([
      first.tools[0]!.execute("first", {}, undefined, undefined, first.context),
      second.tools[0]!.execute("second", {}, undefined, undefined, second.context),
    ]);
    expect(firstRequests.some(({ init }) => String(init.body).includes("tools/call"))).toBe(true);
    expect(secondRequests.some(({ init }) => String(init.body).includes("tools/call"))).toBe(false);
    expect(JSON.stringify(firstRequests)).not.toContain("second-private-token");
    expect(JSON.stringify(secondRequests)).not.toContain("first-private-token");
  });
});

it.layer(NodeHttpServer.layerTest)("Pi MCP bridge HTTP transport", (it) => {
  it.effect("uses the Effect MCP session lifecycle for initialize, list, call, and teardown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registration = Layer.effectDiscard(
          Effect.gen(function* () {
            const server = yield* McpServer.McpServer;
            yield* server.addTool({
              tool: new McpSchema.Tool({
                name: "bash",
                description: "Collision test tool",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
              }),
              annotations: Context.empty(),
              handle: () =>
                Effect.succeed(
                  new McpSchema.CallToolResult({
                    content: [{ type: "text", text: "actual server result" }],
                    isError: false,
                  }),
                ),
            });
          }),
        );
        const transport = McpServer.layerHttp({
          name: "Pi bridge transport test",
          version: "1.0.0",
          path: "/mcp",
          protocols: [McpProtocol.v2025_06_18],
        });
        yield* HttpRouter.serve(registration.pipe(Layer.provideMerge(transport)), {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);
        const server = yield* HttpServer.HttpServer;
        if (!NetAddress.isInetAddress(server.address)) {
          return yield* Effect.die("Expected an inet test server");
        }
        const endpoint = `http://127.0.0.1:${server.address.port}/mcp`;
        const exchanges: Array<{ readonly method: string; readonly status: number }> = [];
        let issuedSessionId: string | null = null;
        const fetch = async (url: string, init: RequestInit) => {
          const response = await globalThis.fetch(url, init);
          exchanges.push({ method: init.method ?? "GET", status: response.status });
          issuedSessionId ??= response.headers.get("mcp-session-id");
          return response;
        };
        const pi = makePi();

        yield* Effect.promise(() =>
          __testing.loadBridgeFactory()(pi.api, runtime(environment({ endpoint }), fetch)),
        );
        expect(pi.tools.map(({ name }) => name)).toEqual(["t3__bash"]);
        const result = yield* Effect.promise(() =>
          pi.tools[0]!.execute("call-1", {}, undefined, undefined, pi.context),
        );
        expect(result.content).toEqual([{ type: "text", text: "actual server result" }]);
        yield* Effect.promise(() =>
          Promise.resolve(pi.handlers.get("session_shutdown")?.[0]?.({})),
        );

        expect(exchanges.map(({ method, status }) => [method, status])).toEqual([
          ["POST", 200],
          ["POST", 202],
          ["POST", 200],
          ["POST", 200],
          ["DELETE", 204],
        ]);
        const reused = yield* Effect.promise(() =>
          globalThis.fetch(endpoint, {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              "mcp-protocol-version": "2025-06-18",
              "mcp-session-id": issuedSessionId ?? "missing-session",
            },
            body: '{"jsonrpc":"2.0","id":99,"method":"ping","params":{}}',
          }),
        );
        expect(reused.status).toBe(404);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("Pi MCP bridge materialization", (it) => {
  it.effect("writes deterministic content-addressed source with restrictive permissions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-mcp-" });

        const first = yield* materializePiMcpExtension(stateDir);
        const second = yield* materializePiMcpExtension(stateDir);
        const directory = path.dirname(first);
        const fileInfo = yield* fileSystem.stat(first);
        const directoryInfo = yield* fileSystem.stat(directory);

        expect(first).toBe(second);
        expect(path.isAbsolute(first)).toBe(true);
        expect(path.basename(first)).toBe(`t3-mcp-${PI_MCP_EXTENSION_DIGEST}.mjs`);
        expect(yield* fileSystem.readFileString(first)).toBe(PI_MCP_EXTENSION_SOURCE);
        expect(fileInfo.mode & 0o777).toBe(0o600);
        expect(directoryInfo.mode & 0o777).toBe(0o700);
      }),
    ),
  );

  it.effect("publishes one verified inode under concurrent materialization", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-mcp-race-" });

        const paths = yield* Effect.all(
          Array.from({ length: 16 }, () => materializePiMcpExtension(stateDir)),
          { concurrency: "unbounded" },
        );
        const entries = yield* fileSystem.readDirectory(path.dirname(paths[0]!));

        expect(new Set(paths).size).toBe(1);
        expect(entries).toEqual([path.basename(paths[0]!)]);
        expect(yield* fileSystem.readFileString(paths[0]!)).toBe(PI_MCP_EXTENSION_SOURCE);
      }),
    ),
  );

  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "rejects a symlink target without reading or chmodding its victim",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const stateDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-pi-mcp-target-link-",
          });
          const directory = path.join(stateDir, "runtime", "pi-mcp");
          const extensionPath = path.join(directory, `t3-mcp-${PI_MCP_EXTENSION_DIGEST}.mjs`);
          const victimPath = path.join(stateDir, "victim.mjs");
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* fileSystem.chmod(directory, 0o700);
          yield* fileSystem.writeFileString(victimPath, "private victim");
          yield* fileSystem.chmod(victimPath, 0o644);
          yield* fileSystem.symlink(victimPath, extensionPath);

          const outcome = yield* materializePiMcpExtension(stateDir).pipe(Effect.exit);
          const victimInfo = yield* fileSystem.stat(victimPath);

          expect(Exit.isFailure(outcome)).toBe(true);
          expect(yield* fileSystem.readFileString(victimPath)).toBe("private victim");
          expect(victimInfo.mode & 0o777).toBe(0o644);
        }),
      ),
  );

  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "rejects a symlinked private directory without chmodding its target",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const stateDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-pi-mcp-directory-link-",
          });
          const runtimeDirectory = path.join(stateDir, "runtime");
          const victimDirectory = path.join(stateDir, "victim-directory");
          yield* fileSystem.makeDirectory(runtimeDirectory);
          yield* fileSystem.makeDirectory(victimDirectory);
          yield* fileSystem.chmod(victimDirectory, 0o755);
          yield* fileSystem.symlink(victimDirectory, path.join(runtimeDirectory, "pi-mcp"));

          const outcome = yield* materializePiMcpExtension(stateDir).pipe(Effect.exit);
          const victimInfo = yield* fileSystem.stat(victimDirectory);

          expect(Exit.isFailure(outcome)).toBe(true);
          expect(victimInfo.mode & 0o777).toBe(0o755);
          expect(yield* fileSystem.readDirectory(victimDirectory)).toEqual([]);
        }),
      ),
  );
});
