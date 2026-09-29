import type { CliProxyAction, CliProxyStatus } from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";

import { ensureLocalApi } from "../../../localApi";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../../ui/menu";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { SettingsRow, SettingsSection } from "../settingsLayout";

type Act = (action: CliProxyAction) => Promise<string | null>;

const PENDING_LABELS: Partial<Record<CliProxyAction["type"], string>> = {
  update: "Updating…",
  start: "Starting…",
  stop: "Stopping…",
  restart: "Restarting…",
  setConnected: "Updating T3 Code…",
  setStartAtLogin: "Saving…",
  setManagementKey: "Checking the key…",
};

/**
 * CLIProxyAPI at a glance: whether it runs, whether T3 Code uses it, and anything that needs
 * fixing. Running it and the rarer controls sit in one menu.
 */
export function ModelProxyHeader({
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
  const errorRow = error ? (
    <SettingsRow title={<span className="text-destructive">{error}</span>} />
  ) : null;

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

  if (!status.installed) {
    return (
      <SettingsSection title="CLIProxyAPI">
        {errorRow}
        <SettingsRow
          title="Install CLIProxyAPI"
          description={`One local endpoint for your subscriptions and API keys, with failover when an account hits its limit. It installs to ${status.installDir}.`}
          control={
            <Button size="sm" disabled={busy} onClick={() => run({ type: "update" })}>
              {pending === "update" ? <Spinner className="size-3.5" /> : null}
              {pending === "update" ? "Installing…" : "Install"}
            </Button>
          }
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
      {errorRow}
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                status.running ? "bg-success" : "bg-muted-foreground/50",
              )}
            />
            {pending !== null
              ? (PENDING_LABELS[pending] ?? "Working…")
              : status.running
                ? "Running"
                : "Stopped"}
          </span>
        }
        description={
          status.running
            ? `Serving at ${status.url}${status.startAtLogin ? ", and starts when you sign in" : ""}.`
            : "Agents routed through it cannot reach their models until it starts."
        }
        control={
          <div className="flex items-center gap-2">
            {status.running ? null : (
              <Button size="sm" disabled={busy} onClick={() => run({ type: "start" })}>
                Start
              </Button>
            )}
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label="More CLIProxyAPI actions"
                  />
                }
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                {status.running ? (
                  <>
                    <MenuItem onClick={() => run({ type: "restart" })}>Restart</MenuItem>
                    <MenuItem onClick={() => run({ type: "stop" })}>Stop</MenuItem>
                  </>
                ) : (
                  <MenuItem onClick={() => run({ type: "start" })}>Start</MenuItem>
                )}
                {status.startAtLogin === null ? null : (
                  <MenuCheckboxItem
                    checked={status.startAtLogin}
                    onCheckedChange={(enabled) => run({ type: "setStartAtLogin", enabled })}
                  >
                    Start when I sign in
                  </MenuCheckboxItem>
                )}
                {status.connected ? (
                  <MenuItem
                    disabled={!status.running}
                    onClick={() => run({ type: "setConnected", enabled: true })}
                  >
                    Sync models to T3 Code
                  </MenuItem>
                ) : null}
                {status.controlPanelUrl ? (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      onClick={() => {
                        const url = status.controlPanelUrl;
                        if (url) void ensureLocalApi().shell.openExternal(url);
                      }}
                    >
                      Open its control panel
                    </MenuItem>
                  </>
                ) : null}
              </MenuPopup>
            </Menu>
          </div>
        }
      />
      <SettingsRow
        title="Use in T3 Code"
        description={
          status.connected
            ? "The CLIProxyAPI provider has every model it serves. Your other providers are unchanged."
            : "Adds a CLIProxyAPI provider with every model it serves. Your other providers are unchanged."
        }
        control={
          <Switch
            aria-label="Use CLIProxyAPI in T3 Code"
            checked={status.connected}
            disabled={busy || (!status.connected && (!status.running || !status.managementReady))}
            onCheckedChange={(enabled) => run({ type: "setConnected", enabled })}
          />
        }
      />
      {updateAvailable ? (
        <SettingsRow
          title={`Version ${status.latestVersion} is available`}
          description="The current version is kept beside it, so you can go back."
          control={
            <Button size="sm" disabled={busy} onClick={() => run({ type: "update" })}>
              {pending === "update" ? <Spinner className="size-3.5" /> : null}
              {pending === "update" ? "Updating…" : "Update"}
            </Button>
          }
        />
      ) : null}
      {status.running && !status.managementReady ? (
        <SettingsRow
          title="Management key needed"
          description="The proxy's remote-management secret-key, so T3 Code can manage its accounts and models."
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
      ) : null}
    </SettingsSection>
  );
}
