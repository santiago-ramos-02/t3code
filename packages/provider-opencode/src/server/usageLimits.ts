import * as NodeSqlite from "node:sqlite";

import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";

const AuthFile = Schema.Struct({ "opencode-go": Schema.optionalKey(Schema.Unknown) });
const ApiAuth = Schema.Struct({ type: Schema.Literal("api"), key: Schema.String });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeApiAuth = Schema.decodeUnknownOption(ApiAuth);
const StoredMetadata = Schema.optionalKey(
  Schema.NullOr(
    Schema.Struct({
      server: Schema.optionalKey(Schema.Unknown),
      orgID: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);
// OpenCode 2's database tags a stored key "key"; auth.json tags it "api". A Console sign-in
// stores an OAuth token instead, which Go accepts for the workspace the sign-in chose.
const StoredCredential = Schema.Union([
  Schema.Struct({ type: Schema.Literal("key"), key: Schema.String, metadata: StoredMetadata }),
  Schema.Struct({
    type: Schema.Literal("oauth"),
    access: Schema.String,
    expires: Schema.Finite,
    metadata: StoredMetadata,
  }),
]);
const decodeStoredCredential = Schema.decodeOption(Schema.fromJsonString(StoredCredential));

/** A Go credential: a key, or a Console sign-in's token with the workspace it is for. */
interface GoCredential {
  readonly token: string;
  readonly workspaceId?: string;
}
const UsageWindow = Schema.Struct({
  percent: Schema.Finite,
  resetsAt: Schema.DateTimeUtcFromString,
});
const UsageResponse = Schema.Struct({
  usage: Schema.Struct({ rolling: UsageWindow, weekly: UsageWindow, monthly: UsageWindow }),
});

// Select before decoding so an OAuth or self-hosted connection cannot fall
// through to another stored account. NULL-active rows predate the selection flag.
const readStoredCredential = (
  databasePath: string,
  integrationId: "opencode" | "opencode-go",
  nowMs: number,
) =>
  Effect.try((): GoCredential | undefined => {
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout = 100");
      const row = database
        .prepare(
          `SELECT value FROM credential
           WHERE integration_id = ? AND active IS NOT 0
           ORDER BY active DESC, time_created DESC, id DESC LIMIT 1`,
        )
        .get(integrationId);
      const stored =
        typeof row?.value === "string"
          ? Option.getOrUndefined(decodeStoredCredential(row.value))
          : undefined;
      if (stored === undefined) return undefined;
      const server = stored.metadata?.server;
      if (typeof server === "string") {
        const url = new URL(server);
        if (`${url.origin}${url.pathname.replace(/\/+$/, "")}` !== "https://opencode.ai/console")
          return undefined;
      }
      if (stored.type === "key") return { token: stored.key.trim() };
      // OpenCode refreshes an expired token on its next request; until then it reads nothing.
      const workspaceId = stored.metadata?.orgID;
      if (typeof server !== "string" || typeof workspaceId !== "string") return undefined;
      return stored.expires > nowMs ? { token: stored.access, workspaceId } : undefined;
    } finally {
      database.close();
    }
  }).pipe(Effect.orElseSucceed(() => undefined));

/** External OpenCode servers own their credentials; never read the host's account for them. */
export const readOpenCodeGoUsageLimits = Effect.fn("readOpenCodeGoUsageLimits")(function* (input: {
  readonly enabled: boolean;
  readonly serverUrl: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  if (!input.enabled || input.serverUrl.trim()) return unsupported;

  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = input.environment;
    const dataHome =
      env.XDG_DATA_HOME ||
      path.join(
        env.HOME || env.USERPROFILE || (yield* HostProcess.HomeDirectory),
        ".local",
        "share",
      );
    const authPath = path.join(dataHome, "opencode", "auth.json");
    const contents =
      env.OPENCODE_AUTH_CONTENT ||
      (yield* fs.readFileString(authPath).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
        }),
      ));
    const auth = yield* decodeAuthFile(contents);
    const apiAuth = decodeApiAuth(auth["opencode-go"]);
    // OpenCode overlays stored API credentials after environment credentials.
    const goKey = (Option.isSome(apiAuth) ? apiAuth.value.key : env.OPENCODE_API_KEY)?.trim();
    // Console supplies Go credentials in OpenCode 2. Inline auth explicitly
    // overrides local credentials, including the Console connection.
    const databaseFile = env.OPENCODE_DB ?? "opencode.db";
    const databasePath = path.resolve(dataHome, "opencode", databaseFile);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const storedCredentials =
      env.OPENCODE_AUTH_CONTENT || databaseFile === ":memory:"
        ? []
        : [
            yield* readStoredCredential(databasePath, "opencode", nowMs),
            // OpenCode 2 imports auth.json once, so a replaced Go key only exists here.
            yield* readStoredCredential(databasePath, "opencode-go", nowMs),
          ];
    const credentials = [...storedCredentials, goKey ? { token: goKey } : undefined].filter(
      (credential, index, all): credential is GoCredential =>
        Boolean(credential?.token) &&
        all.findIndex((other) => other?.token === credential?.token) === index,
    );
    let credential = credentials[0];
    if (credential === undefined) return unsupported;

    const client = yield* HttpClient.HttpClient;
    const readUsage = ({ token, workspaceId }: GoCredential) =>
      client.execute(
        HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
          HttpClientRequest.bearerToken(token),
          workspaceId === undefined
            ? (request) => request
            : HttpClientRequest.setHeader("x-opencode-org-id", workspaceId),
        ),
      );
    let response = yield* readUsage(credential);
    for (const next of credentials.slice(1)) {
      if (response.status !== 401 && response.status !== 403) break;
      credential = next;
      response = yield* readUsage(credential);
    }
    // A valid Zen key can exist without a Go subscription.
    if (response.status === 403) return unsupported;
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(UsageResponse)),
    );
    const windows: ServerProviderUsageWindow[] = [
      {
        id: "go_rolling",
        kind: "session",
        label: "Go · Session",
        windowDurationMins: 5 * 60,
        usedPercent: clampPercent(body.usage.rolling.percent),
        resetsAt: DateTime.formatIso(body.usage.rolling.resetsAt),
      },
      {
        id: "go_weekly",
        kind: "weekly",
        label: "Go · Weekly",
        windowDurationMins: 7 * 24 * 60,
        usedPercent: clampPercent(body.usage.weekly.percent),
        resetsAt: DateTime.formatIso(body.usage.weekly.resetsAt),
      },
      {
        id: "go_monthly",
        kind: "monthly",
        label: "Go · Monthly",
        usedPercent: clampPercent(body.usage.monthly.percent),
        resetsAt: DateTime.formatIso(body.usage.monthly.resetsAt),
      },
    ];
    const digest = yield* Digest.Digest;
    // Unkeyed hashes match across environments; random Go keys resist offline guessing.
    const fingerprintSource =
      credential.workspaceId === undefined
        ? `opencode-go\0${credential.token}`
        : `opencode-go-workspace\0${credential.workspaceId}`;
    const credentialFingerprint = yield* digest
      .digest(Digest.sha256, new TextEncoder().encode(fingerprintSource))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
    return {
      ...makeUsageLimits({ checkedAt, windows }),
      credentialFingerprint,
    };
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "OpenCode Go could not read usage.",
      }),
    ),
  );
});
