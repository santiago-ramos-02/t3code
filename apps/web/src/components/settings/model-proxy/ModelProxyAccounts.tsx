import {
  CLI_PROXY_SIGN_IN_PROVIDERS,
  cliProxyAccountState,
  cliProxyCredentials,
  cliProxyRetryAt,
  cliProxyUsageWindows,
  type CliProxyCredential,
} from "@t3tools/client-runtime/cli-proxy";
import { PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ensureLocalApi } from "../../../localApi";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
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

function formatWhen(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function accountSummary(credential: CliProxyCredential): string {
  const state = cliProxyAccountState(credential);
  const retryAt = state === "limited" ? cliProxyRetryAt(credential) : null;
  const windows = cliProxyUsageWindows(credential)
    .map((window) => `${window.label} ${window.usedPercent}%`)
    .join(" · ");
  return [
    PROVIDER_LABELS[credential.provider] ?? credential.provider,
    retryAt === null ? STATE_LABELS[state] : `At its limit until ${formatWhen(retryAt)}`,
    windows,
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

/** The subscription accounts the proxy pools: their limits, and adding, pausing, or removing one. */
export function ModelProxyAccounts({
  manage,
  disabled,
}: {
  readonly manage: ModelProxyManage;
  readonly disabled: boolean;
}) {
  const credentials = useManaged(manage, "/v8/management/credentials");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const accounts = cliProxyCredentials(credentials.data);

  const change = (id: string, run: () => Promise<{ data: unknown } | { error: string }>) => {
    setBusy(id);
    setError(null);
    void run().then((result) => {
      setBusy(null);
      if ("error" in result) setError(result.error);
      credentials.reload();
    });
  };

  return (
    <SettingsSection
      title="Accounts"
      headerAction={
        <Button size="xs" variant="outline" disabled={disabled} onClick={() => setAdding(true)}>
          <PlusIcon className="size-3" aria-hidden />
          Add account
        </Button>
      }
    >
      {error ? <SettingsRow title={<span className="text-destructive">{error}</span>} /> : null}
      {adding ? (
        <AddAccount
          manage={manage}
          onDone={() => {
            setAdding(false);
            credentials.reload();
          }}
        />
      ) : null}
      {credentials.data === null ? (
        <SettingsRow
          title={credentials.error ?? "Reading accounts…"}
          control={credentials.error ? null : <Spinner className="size-3.5" />}
        />
      ) : accounts.length === 0 ? (
        <SettingsRow
          title="No accounts yet"
          description="Sign in a Claude, ChatGPT, or other subscription to share it through the proxy."
        />
      ) : (
        accounts.map((credential) => {
          const state = cliProxyAccountState(credential);
          const rowBusy = disabled || busy !== null;
          return (
            <SettingsRow
              key={credential.id}
              title={credential.email ?? credential.label ?? credential.name}
              description={accountSummary(credential)}
              control={
                <div className="flex items-center gap-2">
                  {state === "limited" && credential.auth_index !== undefined ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={rowBusy}
                      onClick={() =>
                        change(credential.id, () =>
                          manage("POST", "/v8/management/routing/cooldown/reset", {
                            auth_index: credential.auth_index,
                          }),
                        )
                      }
                    >
                      Retry now
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={rowBusy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remove ${credential.email ?? credential.name} from the proxy?`,
                        )
                      ) {
                        change(credential.id, () =>
                          manage("DELETE", "/v8/management/credentials", { name: credential.name }),
                        );
                      }
                    }}
                  >
                    Remove
                  </Button>
                  <Switch
                    aria-label={`Use ${credential.email ?? credential.name}`}
                    checked={state !== "disabled"}
                    disabled={rowBusy}
                    onCheckedChange={(enabled) =>
                      change(credential.id, () =>
                        manage("PATCH", "/v8/management/credentials/status", {
                          name: credential.name,
                          disabled: !enabled,
                        }),
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
