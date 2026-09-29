import {
  CLI_PROXY_SIGN_IN_PROVIDERS,
  cliProxyAccountState,
  cliProxyCredentials,
  cliProxyGroups,
  cliProxyIsPoolGroup,
  cliProxyRetryAt,
  cliProxyUsageWindows,
  type CliProxyCredential,
  type CliProxyGroup,
  type CliProxyUsageWindow,
} from "@t3tools/client-runtime/cli-proxy";
import { EllipsisIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ensureLocalApi } from "../../../localApi";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { useManaged, type ModelProxyManage } from "./useModelProxy";

const STATE_LABELS = {
  active: "Active",
  limited: "At its limit",
  disabled: "Turned off",
  error: "Failing",
} as const;

const PROVIDER_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  CLI_PROXY_SIGN_IN_PROVIDERS.map((provider) => [provider.id, provider.label]),
);

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

function formatWhen(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function accountState(credential: CliProxyCredential): string {
  const state = cliProxyAccountState(credential);
  const retryAt = state === "limited" ? cliProxyRetryAt(credential) : null;
  return [
    PROVIDER_LABELS[credential.provider] ?? credential.provider,
    retryAt === null ? STATE_LABELS[state] : `At its limit until ${formatWhen(retryAt)}`,
  ].join(" · ");
}

/** One usage window as a small static bar of what is used; hover for when it resets. */
function UsageMeter({ usage }: { readonly usage: CliProxyUsageWindow }) {
  const resets = usage.resetsAt === null ? null : `Resets ${formatWhen(usage.resetsAt)}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            tabIndex={0}
            aria-label={`${usage.label}: ${usage.usedPercent}% used${resets ? `. ${resets}` : ""}`}
            className="inline-flex cursor-default items-center gap-1.5 rounded-sm text-muted-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        {usage.label}
        <span className="relative h-1.5 w-14 overflow-hidden rounded-full bg-muted">
          <span
            className={
              usage.usedPercent >= 90
                ? "absolute inset-y-0 left-0 bg-destructive"
                : "absolute inset-y-0 left-0 bg-foreground/60"
            }
            style={{ width: `${usage.usedPercent}%` }}
          />
        </span>
        <span className="tabular-nums">{usage.usedPercent}%</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {usage.usedPercent}% used{resets ? ` · ${resets}` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

type Adding = "account" | "key" | null;

/**
 * Where the proxy's models come from: subscription accounts it signed in, with their limits,
 * and providers it reaches with an API key. Adding either starts here.
 */
export function ModelProxySources({
  manage,
  disabled,
  onChanged,
}: {
  readonly manage: ModelProxyManage;
  readonly disabled: boolean;
  /** After API-key providers change, so T3 Code's provider lists their models. */
  readonly onChanged: () => void;
}) {
  const credentials = useManaged(manage, "/v8/management/credentials");
  const config = useManaged(manage, "/v8/management/config");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<Adding>(null);
  const accounts = cliProxyCredentials(credentials.data);
  const groups = config.data === null ? {} : cliProxyGroups(config.data);
  const keyProviders = Object.entries(groups).flatMap(([kind, list]) =>
    list
      .map((group, index) => ({ kind, group, index }))
      .filter(({ group }) => !cliProxyIsPoolGroup(group)),
  );
  const locked = disabled || busy;

  const change = (
    run: () => Promise<{ data: unknown } | { error: string }>,
    after?: () => void,
  ) => {
    setBusy(true);
    setError(null);
    void run().then((result) => {
      setBusy(false);
      if ("error" in result) setError(result.error);
      else after?.();
      credentials.reload();
      config.reload();
    });
  };
  const putKeyProviders = (kind: string, list: ReadonlyArray<CliProxyGroup>, after?: () => void) =>
    change(
      () => manage("PUT", `/v8/management/config/api-keys/${kind}`, list),
      () => {
        after?.();
        onChanged();
      },
    );

  const loading = credentials.data === null || config.data === null;
  const readError = credentials.error ?? config.error;

  return (
    <SettingsSection
      title="Accounts and keys"
      headerAction={
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="outline" disabled={locked || loading} />}>
            <PlusIcon className="size-3" aria-hidden />
            Add
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => setAdding("account")}>Sign in to an account</MenuItem>
            <MenuItem onClick={() => setAdding("key")}>Add a provider by API key</MenuItem>
          </MenuPopup>
        </Menu>
      }
    >
      {error ? <SettingsRow title={<span className="text-destructive">{error}</span>} /> : null}
      {adding === "account" ? (
        <AddAccount
          manage={manage}
          onDone={() => {
            setAdding(null);
            credentials.reload();
          }}
        />
      ) : adding === "key" ? (
        <AddProvider
          saving={busy}
          onCancel={() => setAdding(null)}
          onSave={(kind, group) =>
            putKeyProviders(kind, [...(groups[kind] ?? []), group], () => setAdding(null))
          }
        />
      ) : null}
      {loading ? (
        <SettingsRow
          title={readError ?? "Reading accounts and keys…"}
          control={readError ? null : <Spinner className="size-3.5" />}
        />
      ) : accounts.length === 0 && keyProviders.length === 0 ? (
        <SettingsRow
          title="Nothing to serve models yet"
          description="Sign in to a Claude, ChatGPT, or other subscription, or add a provider you pay for by API key, such as OpenCode Go or OpenRouter."
        />
      ) : (
        <>
          {accounts.map((credential) => {
            const state = cliProxyAccountState(credential);
            const name = credential.email ?? credential.label ?? credential.name;
            const windows = cliProxyUsageWindows(credential);
            return (
              <SettingsRow
                key={credential.id}
                title={name}
                description={accountState(credential)}
                status={
                  windows.length === 0 ? null : (
                    <span className="flex flex-wrap gap-x-4 gap-y-1">
                      {windows.map((usage) => (
                        <UsageMeter key={usage.label} usage={usage} />
                      ))}
                    </span>
                  )
                }
                control={
                  <div className="flex items-center gap-2">
                    <Switch
                      aria-label={`Use ${name}`}
                      checked={state !== "disabled"}
                      disabled={locked}
                      onCheckedChange={(enabled) =>
                        change(() =>
                          manage("PATCH", "/v8/management/credentials/status", {
                            name: credential.name,
                            disabled: !enabled,
                          }),
                        )
                      }
                    />
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            disabled={locked}
                            aria-label={`More actions for ${name}`}
                          />
                        }
                      >
                        <EllipsisIcon />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        {state === "limited" && credential.auth_index !== undefined ? (
                          <MenuItem
                            onClick={() =>
                              change(() =>
                                manage("POST", "/v8/management/routing/cooldown/reset", {
                                  auth_index: credential.auth_index,
                                }),
                              )
                            }
                          >
                            Try it again now
                          </MenuItem>
                        ) : null}
                        <MenuItem
                          variant="destructive"
                          onClick={() => {
                            if (window.confirm(`Sign ${name} out of the proxy?`)) {
                              change(() =>
                                manage("DELETE", "/v8/management/credentials", {
                                  name: credential.name,
                                }),
                              );
                            }
                          }}
                        >
                          Sign out
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </div>
                }
              />
            );
          })}
          {keyProviders.map(({ kind, group, index }) => (
            <SettingsRow
              key={`${kind}:${group.name}:${index}`}
              title={group.name}
              description={[
                `API key · ${KIND_LABELS[kind] ?? kind}`,
                (group.models ?? [])
                  .map((model) => model["display-name"] ?? model.alias ?? model.name)
                  .join(", "),
              ]
                .filter((part) => part !== "")
                .join(" · ")}
              control={
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={locked}
                        aria-label={`More actions for ${group.name}`}
                      />
                    }
                  >
                    <EllipsisIcon />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem
                      variant="destructive"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Remove ${group.name}? Its API key is deleted from the proxy.`,
                          )
                        ) {
                          putKeyProviders(
                            kind,
                            (groups[kind] ?? []).filter((_, position) => position !== index),
                          );
                        }
                      }}
                    >
                      Remove
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              }
            />
          ))}
        </>
      )}
    </SettingsSection>
  );
}

/**
 * Signs a new account in through the proxy: the provider's sign-in page opens in the browser,
 * and the proxy picks the result up itself. When the browser runs on another device, the
 * address it lands on can be pasted instead.
 */
function AddAccount({
  manage,
  onDone,
}: {
  readonly manage: ModelProxyManage;
  readonly onDone: () => void;
}) {
  const [provider, setProvider] = useState<string>("claude");
  const [session, setSession] = useState<{ readonly state: string; readonly url: string } | null>(
    null,
  );
  const [callback, setCallback] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  // Poll the login until the proxy reports it finished.
  useEffect(() => {
    if (session === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () =>
      void manage(
        "GET",
        `/v8/management/oauth/status?state=${encodeURIComponent(session.state)}`,
      ).then((result) => {
        if (stopped) return;
        const status =
          "data" in result && typeof result.data === "object" && result.data !== null
            ? (result.data as Record<string, unknown>).status
            : null;
        if (status === "ok") return onDone();
        if (status === "error" || "error" in result) {
          setMessage("The sign-in did not finish. Try again.");
          setSession(null);
          return;
        }
        timer = setTimeout(check, 2000);
      });
    check();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [manage, onDone, session]);

  const start = () => {
    setMessage(null);
    void manage(
      "GET",
      `/v8/management/oauth/auth-url?provider=${encodeURIComponent(provider)}`,
    ).then((result) => {
      if (!live.current) return;
      const data =
        "data" in result && typeof result.data === "object" && result.data !== null
          ? (result.data as Record<string, unknown>)
          : null;
      if (data === null || typeof data.url !== "string" || typeof data.state !== "string") {
        setMessage("error" in result ? result.error : "The proxy did not return a sign-in page.");
        return;
      }
      setSession({ state: data.state, url: data.url });
      void ensureLocalApi().shell.openExternal(data.url);
    });
  };

  const cancel = () => {
    if (session !== null) {
      void manage(
        "DELETE",
        `/v8/management/oauth/session?state=${encodeURIComponent(session.state)}`,
      );
    }
    onDone();
  };

  return (
    <SettingsRow
      title={session === null ? "Sign in an account" : "Finish signing in in your browser"}
      description={
        message ??
        (session === null
          ? "The provider's sign-in page opens in your browser."
          : "If your browser is on another device and shows an error page after signing in, paste that page's address here.")
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {session === null ? (
            <>
              <Select value={provider} onValueChange={(next) => next && setProvider(next)}>
                <SelectTrigger size="sm" className="w-44" aria-label="Account provider">
                  <SelectValue>{PROVIDER_LABELS[provider] ?? provider}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {CLI_PROXY_SIGN_IN_PROVIDERS.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button size="sm" onClick={start}>
                Sign in
              </Button>
            </>
          ) : (
            <>
              <Spinner className="size-3.5" />
              <Input
                size="sm"
                aria-label="Address after signing in"
                placeholder="http://localhost:…/callback?code=…"
                value={callback}
                onChange={(event) => setCallback(event.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={callback.trim() === ""}
                onClick={() =>
                  void manage("POST", "/v8/management/oauth/callback", {
                    state: session.state,
                    redirect_url: callback.trim(),
                  }).then((result) => {
                    if ("error" in result) setMessage(result.error);
                  })
                }
              >
                Submit
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        </div>
      }
    />
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
