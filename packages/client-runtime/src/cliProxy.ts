/**
 * Reading and shaping CLIProxyAPI's management data for web and mobile: accounts with their
 * usage limits, API-key providers, and failover pools.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// ---- Accounts ----------------------------------------------------------------------------------

const Signals = Schema.Record(Schema.String, Schema.String);
const Quota = Schema.Struct({ observed_at: Schema.optionalKey(Schema.String), signals: Signals });

export const CliProxyCredential = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  auth_index: Schema.optionalKey(Schema.String),
  provider: Schema.String,
  email: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  status_message: Schema.optionalKey(Schema.String),
  disabled: Schema.optionalKey(Schema.Boolean),
  unavailable: Schema.optionalKey(Schema.Boolean),
  next_retry_after: Schema.optionalKey(Schema.String),
  quota: Schema.optionalKey(Quota),
  cooldowns: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        scope: Schema.optionalKey(Schema.String),
        model_key: Schema.optionalKey(Schema.String),
        reason: Schema.optionalKey(Schema.String),
        retry_at: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
export type CliProxyCredential = typeof CliProxyCredential.Type;

const decodeCredentials = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Array(CliProxyCredential),
    Schema.Struct({ files: Schema.Array(CliProxyCredential) }),
  ]),
);

/** The proxy's accounts from `GET /v8/management/credentials`; empty when unreadable. */
export function cliProxyCredentials(data: unknown): ReadonlyArray<CliProxyCredential> {
  return Option.match(decodeCredentials(data), {
    onNone: () => [],
    onSome: (value) => ("files" in value ? value.files : value),
  });
}

export type CliProxyAccountState = "active" | "limited" | "disabled" | "error";

/** Whether an account serves requests, is waiting out a limit, is turned off, or failed. */
export function cliProxyAccountState(credential: CliProxyCredential): CliProxyAccountState {
  if (credential.disabled === true) return "disabled";
  if ((credential.cooldowns ?? []).length > 0 || credential.unavailable === true) return "limited";
  if (credential.status === "error") return "error";
  return "active";
}

export interface CliProxyUsageWindow {
  readonly label: string;
  /** 0 to 100. */
  readonly usedPercent: number;
  /** When the window resets, in epoch milliseconds, when known. */
  readonly resetsAt: number | null;
}

const epochSeconds = (value: string | undefined) => {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
};

/**
 * The usage windows an account's last response reported: Claude's 5-hour and weekly limits,
 * or Codex's primary and secondary ones. Empty until the account has served a request.
 */
export function cliProxyUsageWindows(
  credential: Pick<CliProxyCredential, "quota">,
): ReadonlyArray<CliProxyUsageWindow> {
  const signals = credential.quota?.signals ?? {};
  const lower = new Map(Object.entries(signals).map(([key, value]) => [key.toLowerCase(), value]));
  const windows: CliProxyUsageWindow[] = [];
  for (const [id, label] of [
    ["5h", "5-hour"],
    ["7d", "Weekly"],
  ] as const) {
    const utilization = Number(lower.get(`anthropic-ratelimit-unified-${id}-utilization`));
    if (Number.isFinite(utilization)) {
      windows.push({
        label,
        usedPercent: Math.round(Math.min(Math.max(utilization, 0), 1) * 100),
        resetsAt: epochSeconds(lower.get(`anthropic-ratelimit-unified-${id}-reset`)),
      });
    }
  }
  for (const [id, label] of [
    ["primary", "Primary"],
    ["secondary", "Secondary"],
  ] as const) {
    const used = Number(lower.get(`x-codex-${id}-used-percent`));
    if (Number.isFinite(used)) {
      windows.push({
        label,
        usedPercent: Math.round(Math.min(Math.max(used, 0), 100)),
        resetsAt: epochSeconds(lower.get(`x-codex-${id}-reset-at`)),
      });
    }
  }
  return windows;
}

/** When a limited account can serve again, in epoch milliseconds, when known. */
export function cliProxyRetryAt(credential: CliProxyCredential): number | null {
  const times = [
    credential.next_retry_after,
    ...(credential.cooldowns ?? []).map((cooldown) => cooldown.retry_at),
  ]
    .map((value) => (value === undefined ? Number.NaN : Date.parse(value)))
    .filter(Number.isFinite);
  return times.length === 0 ? null : Math.min(...times);
}

/** Providers a new account can sign in with, as CLIProxyAPI names them. */
export const CLI_PROXY_SIGN_IN_PROVIDERS = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "ChatGPT / Codex" },
  { id: "antigravity", label: "Antigravity" },
  { id: "kimi", label: "Kimi" },
  { id: "xai", label: "xAI / Grok" },
  { id: "meta", label: "Meta" },
  { id: "devin", label: "Devin" },
] as const;

// ---- Models ------------------------------------------------------------------------------------

const ModelList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      display_name: Schema.optionalKey(Schema.String),
      owned_by: Schema.optionalKey(Schema.String),
    }),
  ),
});
const decodeModelList = Schema.decodeUnknownOption(ModelList);

export interface CliProxyModel {
  /** The ID a client sends, as `/v1/models` names it. */
  readonly id: string;
  readonly label: string;
  readonly owner: string | null;
}

/** The models the proxy serves, from `GET /v1/models`, named by `labels` where it knows them. */
export function cliProxyModels(
  data: unknown,
  labels: ReadonlyMap<string, string> = new Map(),
): ReadonlyArray<CliProxyModel> {
  return Option.match(decodeModelList(data), {
    onNone: () => [],
    onSome: ({ data: models }) =>
      models
        .map((model) => ({
          id: model.id,
          label: model.display_name ?? labels.get(model.id) ?? model.id,
          owner: model.owned_by ?? null,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
  });
}

// ---- Providers and pools -----------------------------------------------------------------------

export interface CliProxyGroupModel {
  readonly name: string;
  readonly alias?: string;
  readonly "display-name"?: string;
}

/** One upstream group under `api-keys.<kind>` in the v8 config. */
export interface CliProxyGroup {
  readonly name: string;
  readonly "base-url"?: string;
  readonly priority?: number;
  readonly keys?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly models?: ReadonlyArray<CliProxyGroupModel>;
  readonly [field: string]: unknown;
}

export type CliProxyGroups = Readonly<Record<string, ReadonlyArray<CliProxyGroup>>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The upstream groups in a v8 config (`GET /v8/management/config`), by provider kind. */
export function cliProxyGroups(config: unknown): CliProxyGroups {
  const groups = isRecord(config) ? config["api-keys"] : undefined;
  if (!isRecord(groups)) return {};
  return Object.fromEntries(
    Object.entries(groups).flatMap(([kind, list]) =>
      Array.isArray(list)
        ? [[kind, list.filter((group): group is CliProxyGroup => isRecord(group))]]
        : [],
    ),
  );
}

/** A failover pool: one model name clients use, served by its members in order. */
export interface CliProxyPool {
  readonly alias: string;
  readonly label: string;
  /** Model names on this proxy, first choice first. */
  readonly members: ReadonlyArray<string>;
}

const POOL_PREFIX = "pool-";
const isLoopback = (url: string | undefined) =>
  url !== undefined && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/v1\/?$/.test(url);

/**
 * The failover pools in the OpenAI-compatible groups: groups that call this proxy itself,
 * one per member, where the higher priority serves first.
 */
export function cliProxyPools(groups: CliProxyGroups): ReadonlyArray<CliProxyPool> {
  const byAlias = new Map<
    string,
    { label: string; members: { name: string; priority: number }[] }
  >();
  for (const group of groups["openai-compatibility"] ?? []) {
    if (!isLoopback(group["base-url"])) continue;
    for (const model of group.models ?? []) {
      const alias = model.alias ?? model.name;
      const entry = byAlias.get(alias) ?? { label: alias, members: [] };
      if (model["display-name"] !== undefined) entry.label = model["display-name"];
      entry.members.push({ name: model.name, priority: group.priority ?? 0 });
      byAlias.set(alias, entry);
    }
  }
  return [...byAlias.entries()].map(([alias, entry]) => ({
    alias,
    label: entry.label,
    members: entry.members
      .sort((left, right) => right.priority - left.priority)
      .map((member) => member.name),
  }));
}

/** Whether an OpenAI-compatible group belongs to a pool rather than an outside provider. */
export function cliProxyIsPoolGroup(group: CliProxyGroup): boolean {
  return isLoopback(group["base-url"]);
}

/**
 * The OpenAI-compatible groups with `pools` written in place of the existing pools: one group
 * per member, calling this proxy with `clientKey`, prioritized in member order.
 */
export function cliProxyWithPools(
  groups: CliProxyGroups,
  pools: ReadonlyArray<CliProxyPool>,
  input: { readonly proxyUrl: string; readonly clientKey: string },
): ReadonlyArray<CliProxyGroup> {
  const outside = (groups["openai-compatibility"] ?? []).filter(
    (group) => !cliProxyIsPoolGroup(group),
  );
  const poolGroups = pools.flatMap((pool) =>
    pool.members.map((member, index) => {
      const priority = pool.members.length - index;
      return {
        name: `${POOL_PREFIX}${pool.alias}-${index + 1}`,
        priority,
        "base-url": `${input.proxyUrl.replace(/\/$/, "")}/v1`,
        // Priority belongs to the group; CLIProxyAPI rejects it on a key.
        keys: [{ "api-key": input.clientKey }],
        models: [
          {
            name: member,
            alias: pool.alias,
            // Every member names the pool: the model list shows whichever it finds.
            "display-name": pool.label,
          },
        ],
      } satisfies CliProxyGroup;
    }),
  );
  return [...outside, ...poolGroups];
}

/** Channels whose model definitions name the models accounts serve. */
export const CLI_PROXY_MODEL_CHANNELS = [
  "claude",
  "codex",
  "antigravity",
  "gemini",
  "xai",
  "kimi",
  "meta",
] as const;

const Definitions = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({ id: Schema.String, display_name: Schema.optionalKey(Schema.String) }),
  ),
});
const decodeDefinitions = Schema.decodeUnknownOption(Definitions);

/**
 * Readable names for model IDs: from the proxy's model definitions
 * (`GET /v8/management/routing/model-definitions/<channel>`) and the display names its
 * API-key providers give their models.
 */
export function cliProxyModelLabels(
  definitions: ReadonlyArray<unknown>,
  groups: CliProxyGroups,
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const data of definitions) {
    for (const model of Option.getOrNull(decodeDefinitions(data))?.models ?? []) {
      if (model.display_name !== undefined) labels.set(model.id, model.display_name);
    }
  }
  for (const group of Object.values(groups).flat()) {
    for (const model of group.models ?? []) {
      const label = model["display-name"];
      if (label !== undefined) labels.set(model.alias ?? model.name, label);
    }
  }
  return labels;
}

// ---- Presentation ------------------------------------------------------------------------------

const OWNER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Claude",
  openai: "OpenAI",
  google: "Gemini",
  xai: "xAI",
  meta: "Meta",
  moonshot: "Kimi",
  antigravity: "Antigravity",
};

/** A provider name for a model's `owned_by`, for grouping the models the proxy serves. */
export function cliProxyOwnerLabel(owner: string | null): string {
  if (owner === null || owner.trim() === "") return "Other";
  return OWNER_LABELS[owner.toLowerCase()] ?? owner.charAt(0).toUpperCase() + owner.slice(1);
}

/** The models the proxy serves by provider, the provider with the most models first. */
export function cliProxyModelsByProvider(
  models: ReadonlyArray<CliProxyModel>,
): ReadonlyArray<{ readonly label: string; readonly models: ReadonlyArray<CliProxyModel> }> {
  const groups = new Map<string, CliProxyModel[]>();
  for (const model of models) {
    const label = cliProxyOwnerLabel(model.owner);
    groups.set(label, [...(groups.get(label) ?? []), model]);
  }
  return [...groups]
    .map(([label, list]) => ({ label, models: list }))
    .sort(
      (left, right) =>
        right.models.length - left.models.length || left.label.localeCompare(right.label),
    );
}

/**
 * The request an error log is about, from its file name: `error-v1-chat-completions-<time>.log`
 * is `/v1/chat/completions`. Null for a name in another shape.
 */
export function cliProxyErrorEndpoint(fileName: string): string | null {
  const match = /^error-(.+?)-\d{4}-\d{2}-\d{2}T\d{6}(?:-[0-9a-f]+)?\.log$/i.exec(fileName);
  return match?.[1] ? `/${match[1].replaceAll("-", "/")}` : null;
}
