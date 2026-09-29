import { useState } from "react";

import { Button } from "../../ui/button";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";
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

/** Routing between accounts, plugins, error logs, and the full configuration. */
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
  const routing = record(record(config.data).routing);
  const strategy = typeof routing.strategy === "string" ? routing.strategy : "round-robin";
  const retry = record(routing.retry)["request-retry"];
  const busy = disabled || saving || config.data === null;

  const patch = (value: unknown) => {
    setSaving(true);
    setError(null);
    void manage("PATCH", "/v8/management/config", value).then((result) => {
      setSaving(false);
      if ("error" in result) setError(result.error);
      config.reload();
    });
  };

  return (
    <>
      <SettingsSection title="Routing">
        {error ? <SettingsRow title={<span className="text-destructive">{error}</span>} /> : null}
        {config.data === null ? (
          <SettingsRow
            title={config.error ?? "Reading routing…"}
            control={config.error ? null : <Spinner className="size-3.5" />}
          />
        ) : (
          <>
            <SettingsRow
              title="Accounts"
              description={
                STRATEGIES.find((entry) => entry.id === strategy)?.description ??
                "How requests are spread across accounts of the same provider."
              }
              control={
                <Select
                  value={strategy}
                  onValueChange={(next) => next && patch({ routing: { strategy: next } })}
                  disabled={busy}
                >
                  <SelectTrigger size="sm" className="w-52" aria-label="Account routing">
                    <SelectValue>
                      {STRATEGIES.find((entry) => entry.id === strategy)?.label ?? strategy}
                    </SelectValue>
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
                  checked={routing["session-affinity"] === true}
                  disabled={busy}
                  onCheckedChange={(enabled) => patch({ routing: { "session-affinity": enabled } })}
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
                  value={typeof retry === "number" ? retry : 0}
                  disabled={busy}
                  onValueChange={(value) =>
                    value !== null && patch({ routing: { retry: { "request-retry": value } } })
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldInput aria-label="Retries" />
                  </NumberFieldGroup>
                </NumberField>
              }
            />
          </>
        )}
      </SettingsSection>
      <ModelProxyPlugins manage={manage} disabled={disabled} />
      <ModelProxyLogs manage={manage} />
      <ModelProxyRawConfig manage={manage} disabled={disabled} onSaved={config.reload} />
    </>
  );
}

function ModelProxyPlugins({
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
    <SettingsSection
      title="Plugins"
      headerAction={
        available.length > 0 ? (
          <div className="flex items-center gap-2">
            <Select value={choice} onValueChange={(next) => next !== null && setChoice(next)}>
              <SelectTrigger size="xs" className="w-48" aria-label="Plugin to install">
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
              size="xs"
              variant="outline"
              disabled={disabled || busy || choice === ""}
              onClick={() =>
                run("POST", `/v8/management/plugins/store/${encodeURIComponent(choice)}/install`)
              }
            >
              Install
            </Button>
          </div>
        ) : null
      }
    >
      {error ? <SettingsRow title={<span className="text-destructive">{error}</span>} /> : null}
      {installed.data === null ? (
        <SettingsRow
          title={installed.error ?? "Reading plugins…"}
          control={installed.error ? null : <Spinner className="size-3.5" />}
        />
      ) : plugins.length === 0 ? (
        <SettingsRow title="No plugins" />
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
                        {
                          enabled,
                        },
                      )
                    }
                  />
                </div>
              }
            />
          );
        })
      )}
    </SettingsSection>
  );
}

function ModelProxyLogs({ manage }: { readonly manage: ModelProxyManage }) {
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

  return (
    <SettingsSection
      title="Recent errors"
      headerAction={
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
      ) : files.length === 0 ? (
        <SettingsRow title="No errors" />
      ) : (
        files.map((entry) => {
          const name = String(entry.name);
          return (
            <SettingsRow
              key={name}
              title={<span className="font-mono text-xs">{name}</span>}
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
                  new Date(Number(entry.modified ?? 0) * 1000).toLocaleString()
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
    </SettingsSection>
  );
}

/** The whole configuration as JSON, for anything the sections above do not cover. */
function ModelProxyRawConfig({
  manage,
  disabled,
  onSaved,
}: {
  readonly manage: ModelProxyManage;
  readonly disabled: boolean;
  readonly onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const config = useManaged(manage, open ? "/v8/management/config" : null);
  // Unedited, the editor shows the configuration as loaded.
  const [edited, setEdited] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const draft = edited ?? (config.data === null ? null : JSON.stringify(config.data, null, 2));

  const save = () => {
    if (draft === null) return;
    let value: unknown;
    try {
      value = JSON.parse(draft);
    } catch {
      setError("That is not valid JSON.");
      return;
    }
    setSaving(true);
    setError(null);
    void manage("PUT", "/v8/management/config", value).then((result) => {
      setSaving(false);
      if ("error" in result) return setError(result.error);
      setEdited(null);
      config.reload();
      onSaved();
    });
  };

  return (
    <SettingsSection title="Full configuration">
      <SettingsRow
        title="Edit as JSON"
        description={
          error ??
          "Every setting CLIProxyAPI has, including ones this page does not show. It holds your keys; the proxy rejects an invalid configuration."
        }
        control={
          <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>
            {open ? "Close" : "Open"}
          </Button>
        }
      />
      {open ? (
        <div className="space-y-2 px-4 pb-4">
          {draft === null ? (
            <Spinner className="size-3.5" />
          ) : (
            <Textarea
              aria-label="CLIProxyAPI configuration"
              variant="code"
              spellCheck={false}
              value={draft}
              disabled={disabled || saving}
              onChange={(event) => setEdited(event.target.value)}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEdited(null)}>
              Revert
            </Button>
            <Button size="sm" disabled={disabled || saving || draft === null} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : null}
    </SettingsSection>
  );
}
