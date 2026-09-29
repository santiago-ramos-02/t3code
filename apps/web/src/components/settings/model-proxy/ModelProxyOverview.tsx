import type { CliProxyAction, CliProxyStatus } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { ensureLocalApi } from "../../../localApi";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { SettingsRow, SettingsSection } from "../settingsLayout";

type Act = (action: CliProxyAction) => Promise<string | null>;

/** Installing, updating, and running CLIProxyAPI, and pointing Claude Code at it. */
export function ModelProxyOverview({
  status,
  act,
  disabled,
}: {
  readonly status: CliProxyStatus;
  readonly act: Act;
  readonly disabled: boolean;
}) {
  const [pending, setPending] = useState<CliProxyAction["type"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const run = (action: CliProxyAction) => {
    if (pending) return;
    setPending(action.type);
    setError(null);
    void act(action).then((failure) => {
      setPending(null);
      setError(failure);
      if (failure === null && action.type === "setManagementKey") setKey("");
    });
  };
  const busy = disabled || pending !== null;
  const updateAvailable =
    status.installed &&
    status.version !== null &&
    status.latestVersion !== null &&
    status.version !== status.latestVersion;

  if (!status.supported) {
    return (
      <SettingsSection title="CLIProxyAPI">
        <SettingsRow
          title="Not available on this system"
          description="CLIProxyAPI publishes builds for Windows, macOS, and Linux on x64 and ARM."
        />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title="CLIProxyAPI"
      headerAction={
        status.version ? (
          <span className="font-mono text-xs text-muted-foreground">v{status.version}</span>
        ) : null
      }
    >
      {error ? <SettingsRow title={<span className="text-destructive">{error}</span>} /> : null}
      {!status.installed ? (
        <SettingsRow
          title="Install CLIProxyAPI"
          description={`A local proxy that gives agents one endpoint for your subscriptions and API keys. It installs to ${status.installDir}.`}
          control={
            <Button size="sm" disabled={busy} onClick={() => run({ type: "update" })}>
              {pending === "update" ? <Spinner className="size-3.5" /> : null}
              {pending === "update" ? "Installing…" : "Install"}
            </Button>
          }
        />
      ) : (
        <>
          <SettingsRow
            title="Version"
            description={
              updateAvailable
                ? `Version ${status.latestVersion} is available. The current version is kept, so you can go back.`
                : status.latestVersion === null
                  ? "The latest release could not be checked."
                  : "Up to date."
            }
            control={
              updateAvailable || pending === "update" ? (
                <Button size="sm" disabled={busy} onClick={() => run({ type: "update" })}>
                  {pending === "update" ? <Spinner className="size-3.5" /> : null}
                  {pending === "update" ? "Updating…" : "Update"}
                </Button>
              ) : null
            }
          />
          <SettingsRow
            title="Running"
            description={
              status.running
                ? `Serving at ${status.url}.`
                : "Stopped. Agents routed through it cannot reach their models."
            }
            control={
              <div className="flex items-center gap-2">
                {status.running ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => run({ type: "restart" })}
                  >
                    {pending === "restart" ? "Restarting…" : "Restart"}
                  </Button>
                ) : null}
                <Switch
                  aria-label="CLIProxyAPI running"
                  checked={status.running}
                  disabled={busy}
                  onCheckedChange={(checked) => run({ type: checked ? "start" : "stop" })}
                />
              </div>
            }
          />
          {status.startAtLogin === null ? null : (
            <SettingsRow
              title="Start at login"
              description="Keeps it running in the background whenever you are signed in to this computer."
              control={
                <Switch
                  aria-label="Start CLIProxyAPI at login"
                  checked={status.startAtLogin}
                  disabled={busy}
                  onCheckedChange={(enabled) => run({ type: "setStartAtLogin", enabled })}
                />
              }
            />
          )}
          <SettingsRow
            title="Use in T3 Code"
            description={
              status.connected
                ? "Threads can run on the CLIProxyAPI provider, with every model it serves, and its accounts' limits show in Usage. Your other Claude Code threads are unchanged. Sync after adding models or pools."
                : "Adds a CLIProxyAPI provider: Claude Code running through the proxy, with every model it serves and your pools. Your other providers are unchanged."
            }
            control={
              <div className="flex items-center gap-2">
                {status.connected ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || !status.running}
                    onClick={() => run({ type: "setConnected", enabled: true })}
                  >
                    {pending === "setConnected" ? "Syncing…" : "Sync models"}
                  </Button>
                ) : null}
                <Switch
                  aria-label="Use CLIProxyAPI in T3 Code"
                  checked={status.connected}
                  disabled={
                    busy || (!status.connected && (!status.running || !status.managementReady))
                  }
                  onCheckedChange={(enabled) => run({ type: "setConnected", enabled })}
                />
              </div>
            }
          />
          {status.managementReady ? null : (
            <SettingsRow
              title="Management key"
              description="T3 Code needs the key set as remote-management's secret-key in the proxy's config to show and change accounts, models, and settings."
              control={
                <div className="flex items-center gap-2">
                  <Input
                    size="sm"
                    type="password"
                    aria-label="Management key"
                    placeholder="Management key"
                    value={key}
                    disabled={busy}
                    onChange={(event) => setKey(event.target.value)}
                  />
                  <Button
                    size="sm"
                    disabled={busy || key.trim() === ""}
                    onClick={() => run({ type: "setManagementKey", key })}
                  >
                    Save
                  </Button>
                </div>
              }
            />
          )}
          {status.controlPanelUrl ? (
            <SettingsRow
              title="Control panel"
              description="CLIProxyAPI's own management page, in your browser on this computer."
              control={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const url = status.controlPanelUrl;
                    if (url) void ensureLocalApi().shell.openExternal(url);
                  }}
                >
                  <ExternalLinkIcon className="size-3.5" />
                  Open
                </Button>
              }
            />
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}
