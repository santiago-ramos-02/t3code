import { cliProxyErrorEndpoint } from "@t3tools/client-runtime/cli-proxy";
import { CopyIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../ui/button";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";
import { FoldedSettingsSection } from "../FoldedSettingsSection";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { useManaged, type ModelProxyManage } from "./useModelProxy";

const STRATEGIES = [
  { id: "round-robin", label: "Take turns", description: "Spreads requests across accounts." },
  {
    id: "fill-first",
    label: "Use one until its limit",
    description: "Keeps using the first account until it is limited, then moves on.",
  },
  {
    id: "weighted-round-robin",
    label: "Take turns by weight",
    description: "Spreads requests by each account's weight.",
  },
] as const;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const mask = (key: string) => (key.length <= 12 ? "••••" : `${key.slice(0, 7)}…${key.slice(-4)}`);

function newClientKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `sk-t3-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function clientKeys(config: unknown): ReadonlyArray<string> {
  const keys = record(record(config).access)["api-keys"];
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
}

/**
 * What most people set once or never: how requests spread across accounts, the keys other
 * tools use, plugins, recent errors, and the whole configuration. Each folds closed with a
 * one-line summary.
 */
export function ModelProxyAdvanced({
  manage,
  disabled,
}: {
  readonly manage: ModelProxyManage;
  readonly disabled: boolean;
}) {
  const config = useManaged(manage, "/v8/management/config");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = disabled || saving || config.data === null;

  const write = (method: "PATCH" | "PUT", path: string, value: unknown) => {
    setSaving(true);
    setError(null);
    void manage(method, path, value).then((result) => {
      setSaving(false);
      if ("error" in result) setError(result.error);
      config.reload();
    });
  };

  return (
    <SettingsSection title="Advanced" variant="plain">
      {error ? (
        <p role="alert" className="px-3 text-destructive text-sm sm:px-4">
          {error}
        </p>
      ) : null}
      <RoutingFold
        config={config.data}
        busy={busy}
        onPatch={(value) => write("PATCH", "/v8/management/config", value)}
      />
      <ClientKeysFold
        keys={clientKeys(config.data)}
        busy={busy}
        onChange={(keys) => write("PUT", "/v8/management/config/access/api-keys", keys)}
      />
      <PluginsFold manage={manage} disabled={disabled} />
      <ErrorsFold manage={manage} />
      <ConfigFold
        config={config.data}
        busy={busy}
        onSave={(value) => write("PUT", "/v8/management/config", value)}
      />
    </SettingsSection>
  );
}

function RoutingFold({
  config,
  busy,
  onPatch,
}: {
  readonly config: unknown;
  readonly busy: boolean;
  readonly onPatch: (value: unknown) => void;
}) {
  const routing = record(record(config).routing);
  const strategy = typeof routing.strategy === "string" ? routing.strategy : "round-robin";
  const retry = record(routing.retry)["request-retry"];
  const retries = typeof retry === "number" ? retry : 0;
  const affinity = routing["session-affinity"] === true;
  const strategyLabel = STRATEGIES.find((entry) => entry.id === strategy)?.label ?? strategy;

  return (
    <FoldedSettingsSection
      id="cli-proxy-routing"
      title="Routing"
      summary={
        config === null
          ? null
          : [
              strategyLabel,
              affinity ? "conversations stay on one account" : null,
              `${retries} ${retries === 1 ? "retry" : "retries"}`,
            ]
              .filter((part) => part !== null)
              .join(" · ")
      }
    >
      <SettingsRow
        title="Accounts"
        description={
          STRATEGIES.find((entry) => entry.id === strategy)?.description ??
          "How requests are spread across accounts of the same provider."
        }
        control={
          <Select
            value={strategy}
            onValueChange={(next) => next && onPatch({ routing: { strategy: next } })}
            disabled={busy}
          >
            <SelectTrigger size="sm" className="w-52" aria-label="Account routing">
              <SelectValue>{strategyLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              {STRATEGIES.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Keep a conversation on one account"
        description="Reuses an account's prompt cache, which is faster and cheaper; it still moves on when that account is limited."
        control={
          <Switch
            aria-label="Keep a conversation on one account"
            checked={affinity}
            disabled={busy}
            onCheckedChange={(enabled) => onPatch({ routing: { "session-affinity": enabled } })}
          />
        }
      />
      <SettingsRow
        title="Retries"
        description="Extra attempts on another account when a request fails."
        control={
          <NumberField
            className="w-24"
            min={0}
            max={10}
            value={retries}
            disabled={busy}
            onValueChange={(value) =>
              value !== null && onPatch({ routing: { retry: { "request-retry": value } } })
            }
          >
            <NumberFieldGroup>
              <NumberFieldInput aria-label="Retries" />
            </NumberFieldGroup>
          </NumberField>
        }
      />
    </FoldedSettingsSection>
  );
}

function ClientKeysFold({
  keys,
  busy,
  onChange,
}: {
  readonly keys: ReadonlyArray<string>;
  readonly busy: boolean;
  readonly onChange: (keys: ReadonlyArray<string>) => void;
}) {
  return (
    <FoldedSettingsSection
      id="cli-proxy-client-keys"
      title="Client keys"
      summary={
        keys.length === 0
          ? "None. Clients cannot reach the proxy."
          : `${keys.length} ${keys.length === 1 ? "key" : "keys"} other tools use to reach the proxy`
      }
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => onChange([...keys, newClientKey()])}
        >
          <PlusIcon className="size-3" aria-hidden />
          New key
        </Button>
      }
    >
      {keys.map((key, index) => (
        <SettingsRow
          key={key}
          title={<span className="font-mono">{mask(key)}</span>}
          description={
            index === 0
              ? "T3 Code and failover models use this key."
              : "For other tools on this computer or network."
          }
          control={
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                aria-label="Copy key"
                onClick={() => void navigator.clipboard.writeText(key)}
              >
                <CopyIcon className="size-3.5" />
                Copy
              </Button>
              {index === 0 ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("Remove this key? Tools using it lose access.")) {
                      onChange(keys.filter((entry) => entry !== key));
                    }
                  }}
                >
                  Remove
                </Button>
              )}
            </div>
          }
        />
      ))}
    </FoldedSettingsSection>
  );
}

function PluginsFold({
  manage,
  disabled,
}: {
  readonly manage: ModelProxyManage;
  readonly disabled: boolean;
}) {
  const installed = useManaged(manage, "/v8/management/plugins");
  const store = useManaged(manage, "/v8/management/plugins/store");
  const [choice, setChoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const plugins = (() => {
    const list = record(installed.data).plugins;
    return Array.isArray(list) ? list.map(record) : [];
  })();
  const installedIds = new Set(plugins.map((plugin) => String(plugin.id)));
  const available = (() => {
    const list = record(store.data).plugins;
    return (Array.isArray(list) ? list.map(record) : []).filter(
      (plugin) => typeof plugin.id === "string" && !installedIds.has(plugin.id),
    );
  })();
  const enabledCount = plugins.filter((plugin) => plugin.enabled === true).length;
  const run = (method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    void manage(method, path, body).then((result) => {
      setBusy(false);
      if ("error" in result) setError(result.error);
      installed.reload();
    });
  };

  return (
    <FoldedSettingsSection
      id="cli-proxy-plugins"
      title="Plugins"
      summary={
        installed.data === null
          ? null
          : plugins.length === 0
            ? "None installed"
            : `${plugins.length} installed, ${enabledCount} on`
      }
    >
      {error ? <SettingsRow title={<span className="text-destructive">{error}</span>} /> : null}
      {available.length > 0 ? (
        <SettingsRow
          title="Install a plugin"
          description="From CLIProxyAPI's plugin store."
          control={
            <div className="flex items-center gap-2">
              <Select value={choice} onValueChange={(next) => next !== null && setChoice(next)}>
                <SelectTrigger size="sm" className="w-48" aria-label="Plugin to install">
                  <SelectValue>
                    {available.find((plugin) => plugin.id === choice)?.name?.toString() ??
                      "Choose a plugin"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  {available.map((plugin) => (
                    <SelectItem key={String(plugin.id)} value={String(plugin.id)}>
                      {String(plugin.name ?? plugin.id)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || busy || choice === ""}
                onClick={() =>
                  run("POST", `/v8/management/plugins/store/${encodeURIComponent(choice)}/install`)
                }
              >
                Install
              </Button>
            </div>
          }
        />
      ) : null}
      {installed.data === null ? (
        <SettingsRow
          title={installed.error ?? "Reading plugins…"}
          control={installed.error ? null : <Spinner className="size-3.5" />}
        />
      ) : (
        plugins.map((plugin) => {
          const id = String(plugin.id);
          const metadata = record(plugin.metadata);
          return (
            <SettingsRow
              key={id}
              title={String(metadata.name ?? id)}
              description={[metadata.version ? `v${metadata.version}` : null, metadata.author]
                .filter(Boolean)
                .join(" · ")}
              control={
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || busy}
                    onClick={() => {
                      if (window.confirm(`Delete the plugin ${id}?`)) {
                        run("DELETE", `/v8/management/plugins/${encodeURIComponent(id)}`);
                      }
                    }}
                  >
                    Delete
                  </Button>
                  <Switch
                    aria-label={`Enable ${id}`}
                    checked={plugin.enabled === true}
                    disabled={disabled || busy}
                    onCheckedChange={(enabled) =>
                      run(
                        "PATCH",
                        `/v8/management/config/plugins/configs/${encodeURIComponent(id)}`,
                        { enabled },
                      )
                    }
                  />
                </div>
              }
            />
          );
        })
      )}
    </FoldedSettingsSection>
  );
}

function ErrorsFold({ manage }: { readonly manage: ModelProxyManage }) {
  const errors = useManaged(manage, "/v8/management/observability/logs/errors");
  const [open, setOpen] = useState<string | null>(null);
  const file = useManaged(
    manage,
    open === null ? null : `/v8/management/observability/logs/errors/${encodeURIComponent(open)}`,
  );
  const files = (() => {
    const list = record(errors.data).files;
    return (Array.isArray(list) ? list.map(record) : [])
      .filter((entry) => typeof entry.name === "string")
      .toSorted((left, right) => Number(right.modified ?? 0) - Number(left.modified ?? 0))
      .slice(0, 8);
  })();
  const when = (entry: Record<string, unknown>) =>
    new Date(Number(entry.modified ?? 0) * 1000).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const latest = files[0];

  return (
    <FoldedSettingsSection
      id="cli-proxy-errors"
      title="Recent errors"
      summary={
        errors.data === null
          ? null
          : latest === undefined
            ? "None"
            : `${files.length === 8 ? "8+" : files.length}, latest ${when(latest)}`
      }
      control={
        <Button size="xs" variant="ghost" onClick={errors.reload}>
          Refresh
        </Button>
      }
    >
      {errors.data === null ? (
        <SettingsRow
          title={errors.error ?? "Reading errors…"}
          control={errors.error ? null : <Spinner className="size-3.5" />}
        />
      ) : (
        files.map((entry) => {
          const name = String(entry.name);
          return (
            <SettingsRow
              key={name}
              title={
                <span className="font-mono text-xs">{cliProxyErrorEndpoint(name) ?? name}</span>
              }
              description={
                open === name ? (
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">
                    {file.data === null
                      ? (file.error ?? "Reading…")
                      : typeof file.data === "string"
                        ? file.data
                        : JSON.stringify(file.data, null, 2)}
                  </pre>
                ) : (
                  when(entry)
                )
              }
              control={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setOpen(open === name ? null : name)}
                >
                  {open === name ? "Hide" : "Show"}
                </Button>
              }
            />
          );
        })
      )}
    </FoldedSettingsSection>
  );
}

/** The whole configuration as JSON, for anything the sections above do not cover. */
function ConfigFold({
  config,
  busy,
  onSave,
}: {
  readonly config: unknown;
  readonly busy: boolean;
  readonly onSave: (value: unknown) => void;
}) {
  // Unedited, the editor shows the configuration as loaded.
  const [edited, setEdited] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const draft = edited ?? (config === null ? null : JSON.stringify(config, null, 2));

  const save = () => {
    if (draft === null) return;
    let value: unknown;
    try {
      value = JSON.parse(draft);
    } catch {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setEdited(null);
    onSave(value);
  };

  return (
    <FoldedSettingsSection
      id="cli-proxy-config"
      title="Full configuration"
      summary="Every setting, as JSON. It holds your keys."
    >
      <div className="space-y-2 p-4">
        {invalid ? <p className="text-destructive text-sm">That is not valid JSON.</p> : null}
        {draft === null ? (
          <Spinner className="size-3.5" />
        ) : (
          <Textarea
            aria-label="CLIProxyAPI configuration"
            variant="code"
            spellCheck={false}
            value={draft}
            disabled={busy}
            onChange={(event) => setEdited(event.target.value)}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={edited === null}
            onClick={() => {
              setEdited(null);
              setInvalid(false);
            }}
          >
            Revert
          </Button>
          <Button size="sm" disabled={busy || edited === null} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </FoldedSettingsSection>
  );
}
