import {
  cliProxyGroups,
  cliProxyIsPoolGroup,
  type CliProxyGroup,
} from "@t3tools/client-runtime/cli-proxy";
import { CopyIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { useManaged, type ModelProxyManage } from "./useModelProxy";

/** The API shapes an API-key provider can speak, as CLIProxyAPI groups them. */
const KINDS = [
  { id: "openai-compatibility", label: "OpenAI chat completions" },
  { id: "codex", label: "OpenAI Responses" },
  { id: "claude", label: "Anthropic messages" },
] as const;
type Kind = (typeof KINDS)[number]["id"];

const KIND_LABELS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(KINDS.map((kind) => [kind.id, kind.label])),
  gemini: "Gemini",
  vertex: "Vertex",
  xai: "xAI",
  meta: "Meta",
};

const mask = (key: string) => (key.length <= 12 ? "••••" : `${key.slice(0, 7)}…${key.slice(-4)}`);

function newClientKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `sk-t3-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Providers the proxy reaches with an API key, such as OpenCode Go or OpenRouter, and the keys
 * clients use to reach the proxy.
 */
export function ModelProxyProviders({
  manage,
  disabled,
  onChanged,
}: {
  readonly manage: ModelProxyManage;
  readonly disabled: boolean;
  /** After providers change, so T3 Code's provider lists their models. */
  readonly onChanged: () => void;
}) {
  const config = useManaged(manage, "/v8/management/config");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const groups = config.data === null ? {} : cliProxyGroups(config.data);
  const providers = Object.entries(groups).flatMap(([kind, list]) =>
    list
      .map((group, index) => ({ kind, group, index }))
      .filter(({ group }) => !cliProxyIsPoolGroup(group)),
  );
  const access =
    typeof config.data === "object" && config.data !== null
      ? (config.data as Record<string, unknown>).access
      : null;
  const rawKeys =
    typeof access === "object" && access !== null
      ? (access as Record<string, unknown>)["api-keys"]
      : null;
  const clientKeys = Array.isArray(rawKeys)
    ? rawKeys.filter((key): key is string => typeof key === "string")
    : [];

  const put = (path: string, value: unknown, after?: () => void) => {
    setSaving(true);
    setError(null);
    void manage("PUT", path, value).then((result) => {
      setSaving(false);
      if ("error" in result) return setError(result.error);
      after?.();
      config.reload();
    });
  };
  const busy = disabled || saving || config.data === null;

  return (
    <>
      <SettingsSection
        title="API-key providers"
        headerAction={
          <Button size="xs" variant="outline" disabled={busy} onClick={() => setAdding(true)}>
            <PlusIcon className="size-3" aria-hidden />
            Add provider
          </Button>
        }
      >
        {error ? <SettingsRow title={<span className="text-destructive">{error}</span>} /> : null}
        {adding ? (
          <AddProvider
            saving={saving}
            onCancel={() => setAdding(false)}
            onSave={(kind, group) =>
              put(
                `/v8/management/config/api-keys/${kind}`,
                [...(groups[kind] ?? []), group],
                () => {
                  setAdding(false);
                  onChanged();
                },
              )
            }
          />
        ) : null}
        {config.data === null ? (
          <SettingsRow
            title={config.error ?? "Reading providers…"}
            control={config.error ? null : <Spinner className="size-3.5" />}
          />
        ) : providers.length === 0 ? (
          <SettingsRow
            title="No API-key providers"
            description="Add a provider you pay for by key, such as OpenCode Go or OpenRouter, so its models run through the proxy too."
          />
        ) : (
          providers.map(({ kind, group, index }) => (
            <SettingsRow
              key={`${kind}:${group.name}:${index}`}
              title={group.name}
              description={[
                KIND_LABELS[kind] ?? kind,
                group["base-url"],
                (group.models ?? [])
                  .map((model) => model["display-name"] ?? model.alias ?? model.name)
                  .join(", "),
              ]
                .filter((part) => part !== undefined && part !== "")
                .join(" · ")}
              control={
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(`Remove ${group.name}? Its API key is deleted from the proxy.`)
                    ) {
                      put(
                        `/v8/management/config/api-keys/${kind}`,
                        (groups[kind] ?? []).filter((_, position) => position !== index),
                        onChanged,
                      );
                    }
                  }}
                >
                  Remove
                </Button>
              }
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection
        title="Client keys"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() =>
              put("/v8/management/config/access/api-keys", [...clientKeys, newClientKey()])
            }
          >
            <PlusIcon className="size-3" aria-hidden />
            New key
          </Button>
        }
      >
        {clientKeys.length === 0 ? (
          <SettingsRow
            title="No client keys"
            description="Clients cannot reach the proxy without one."
          />
        ) : (
          clientKeys.map((key, index) => (
            <SettingsRow
              key={key}
              title={<span className="font-mono">{mask(key)}</span>}
              description={
                index === 0
                  ? "T3 Code and pools use this key."
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
                          put(
                            "/v8/management/config/access/api-keys",
                            clientKeys.filter((entry) => entry !== key),
                          );
                        }
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              }
            />
          ))
        )}
      </SettingsSection>
    </>
  );
}

function AddProvider({
  saving,
  onCancel,
  onSave,
}: {
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onSave: (kind: Kind, group: CliProxyGroup) => void;
}) {
  const [kind, setKind] = useState<Kind>("openai-compatibility");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState("");
  // "model" or "model = Display name", one per line or comma-separated.
  const parsedModels = models
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [id = "", label] = entry.split("=").map((part) => part.trim());
      return label ? { name: id, alias: id, "display-name": label } : { name: id };
    });
  const canSave =
    !saving &&
    name.trim() !== "" &&
    /^https?:\/\//.test(baseUrl.trim()) &&
    apiKey.trim() !== "" &&
    parsedModels.length > 0;

  return (
    <SettingsRow
      title="New API-key provider"
      description="Models as IDs, optionally named: muse-spark-1.3-contributor = Muse Spark 1.3"
      control={
        <div className="flex w-full min-w-72 flex-col gap-2">
          <Select value={kind} onValueChange={(next) => next && setKind(next as Kind)}>
            <SelectTrigger size="sm" aria-label="Provider API">
              <SelectValue>{KIND_LABELS[kind]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {KINDS.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Input
            size="sm"
            aria-label="Provider name"
            placeholder="Name, e.g. opencode-go"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            size="sm"
            aria-label="Base URL"
            placeholder="https://opencode.ai/zen/go/v1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <Input
            size="sm"
            type="password"
            aria-label="API key"
            placeholder="API key"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <Input
            size="sm"
            aria-label="Models"
            placeholder="model-id = Name, other-model"
            value={models}
            onChange={(event) => setModels(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!canSave}
              onClick={() =>
                onSave(kind, {
                  name: name.trim(),
                  "base-url": baseUrl.trim(),
                  keys: [{ "api-key": apiKey.trim() }],
                  models: parsedModels,
                })
              }
            >
              {saving ? "Saving…" : "Add"}
            </Button>
          </div>
        </div>
      }
    />
  );
}
