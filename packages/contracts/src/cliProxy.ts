import * as Schema from "effect/Schema";

/**
 * CLIProxyAPI on an environment: a local proxy that lets agents reach models from several
 * subscriptions and API keys through one endpoint.
 */
export const CliProxyStatus = Schema.Struct({
  // Whether CLIProxyAPI publishes a build for this environment's system.
  supported: Schema.Boolean,
  installed: Schema.Boolean,
  installDir: Schema.String,
  version: Schema.NullOr(Schema.String),
  // The newest release, when it could be checked.
  latestVersion: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
  // Where clients reach it, such as http://127.0.0.1:8317.
  url: Schema.NullOr(Schema.String),
  // CLIProxyAPI's own management page, for anything T3 Code does not show.
  controlPanelUrl: Schema.NullOr(Schema.String),
  // Whether T3 Code holds a management key the proxy accepts; the management views need it.
  managementReady: Schema.Boolean,
  // Starting with the user's login; null where T3 Code cannot manage that on this system.
  startAtLogin: Schema.NullOr(Schema.Boolean),
  // Whether T3 Code has the proxy as a provider, whose threads run Claude Code through it, and
  // reads its accounts' usage limits.
  connected: Schema.Boolean,
  // Why something above could not be read, for the user.
  problem: Schema.optionalKey(Schema.String),
});
export type CliProxyStatus = typeof CliProxyStatus.Type;

export const CliProxyAction = Schema.Union([
  // Installs when missing, otherwise moves to the latest release, keeping the previous one.
  Schema.Struct({ type: Schema.Literal("update") }),
  Schema.Struct({ type: Schema.Literal("start") }),
  Schema.Struct({ type: Schema.Literal("stop") }),
  Schema.Struct({ type: Schema.Literal("restart") }),
  Schema.Struct({ type: Schema.Literal("setStartAtLogin"), enabled: Schema.Boolean }),
  // Adds or removes the proxy as a T3 Code provider and usage source; adding again re-reads its
  // models into the provider's model list.
  Schema.Struct({ type: Schema.Literal("setConnected"), enabled: Schema.Boolean }),
  // For an install T3 Code did not make: the management key its config was given.
  Schema.Struct({ type: Schema.Literal("setManagementKey"), key: Schema.String }),
]);
export type CliProxyAction = typeof CliProxyAction.Type;

export const CliProxyActionInput = Schema.Struct({ action: CliProxyAction });

/**
 * One call to CLIProxyAPI's management API (`/v8/management/...` or `/v0/management/...`),
 * or its model list (`/v1/models`), made by the server with the keys it holds.
 */
export const CliProxyManagementInput = Schema.Struct({
  method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: Schema.String,
  body: Schema.optionalKey(Schema.Unknown),
});
export const CliProxyManagementResult = Schema.Struct({
  status: Schema.Number,
  data: Schema.Unknown,
});

export class CliProxyError extends Schema.TaggedError<CliProxyError>()("CliProxyError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
