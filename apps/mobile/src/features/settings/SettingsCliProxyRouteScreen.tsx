import {
  cliProxyAccountState,
  cliProxyCredentials,
  cliProxyRetryAt,
  cliProxyUsageWindows,
} from "@t3tools/client-runtime/cli-proxy";
import type { CliProxyAction, EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const STATE_LABELS = {
  active: "Active",
  limited: "At its limit",
  disabled: "Turned off",
  error: "Failing",
} as const;

/** CLIProxyAPI on each selected environment; accounts, pools, and providers are edited on web or desktop. */
export function SettingsCliProxyRouteScreen() {
  const insets = useSafeAreaInsets();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="CLIProxyAPI" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {selectedTargets.map((target) => (
            <CliProxyEnvironment
              key={target.environmentId}
              environmentId={target.environmentId}
              label={selectedTargets.length > 1 ? target.label : null}
            />
          ))}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function CliProxyEnvironment(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const { environmentId } = props;
  const status = useEnvironmentQuery(
    serverEnvironment.cliProxyStatus({ environmentId, input: {} }),
  ).data;
  const runAction = useAtomCommand(serverEnvironment.runCliProxyAction, {
    reportFailure: false,
    reportDefect: false,
  });
  const management = useAtomCommand(serverEnvironment.cliProxyManagement, {
    reportFailure: false,
    reportDefect: false,
  });
  const [pending, setPending] = useState(false);
  const [credentials, setCredentials] = useState<unknown>(null);

  const readCredentials = useCallback(
    () =>
      void management({
        environmentId,
        input: { method: "GET", path: "/v8/management/credentials" },
      }).then((result) => {
        if (result._tag === "Success" && result.value.status === 200) {
          setCredentials(result.value.data);
        }
      }),
    [environmentId, management],
  );
  const manageable = status?.running === true && status.managementReady;
  useEffect(() => {
    if (manageable) readCredentials();
  }, [manageable, readCredentials]);

  const act = (action: CliProxyAction) => {
    setPending(true);
    void runAction({ environmentId, input: { action } }).then((result) => {
      setPending(false);
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      Alert.alert("CLIProxyAPI", failure instanceof Error ? failure.message : "Try again.");
    });
  };

  if (status === null) return <ActivityIndicator />;
  const title = ["CLIProxyAPI", status.version ? `v${status.version}` : null, props.label]
    .filter((part) => part !== null)
    .join(" · ");
  const updateAvailable =
    status.installed && status.latestVersion !== null && status.version !== status.latestVersion;
  const accounts = cliProxyCredentials(credentials);

  if (!status.supported) {
    return (
      <SettingsSection title={title}>
        <Text className="p-4 text-sm text-foreground-muted">
          CLIProxyAPI has no build for this environment's system.
        </Text>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection title={title}>
        {!status.installed || updateAvailable ? (
          <View className="gap-3 p-4">
            <Text className="text-sm text-foreground-muted">
              {status.installed
                ? `Version ${status.latestVersion} is available.`
                : "A local proxy that gives agents one endpoint for your subscriptions and API keys."}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={pending}
              onPress={() => act({ type: "update" })}
              className="min-h-11 items-center justify-center self-start rounded-full bg-subtle-strong px-4 disabled:opacity-40"
            >
              <Text className="text-sm font-t3-medium text-foreground">
                {pending ? "Working…" : status.installed ? "Update" : "Install"}
              </Text>
            </Pressable>
          </View>
        ) : null}
        {status.installed ? (
          <>
            <SettingsSwitchRow
              icon="server.rack"
              label="Running"
              subtitle={status.running ? `Serving at ${status.url}` : "Stopped"}
              value={status.running}
              disabled={pending}
              onValueChange={(running) => act({ type: running ? "start" : "stop" })}
            />
            {status.startAtLogin === null ? null : (
              <SettingsSwitchRow
                icon="arrow.clockwise"
                label="Start when I sign in"
                value={status.startAtLogin}
                disabled={pending}
                onValueChange={(enabled) => act({ type: "setStartAtLogin", enabled })}
              />
            )}
            <SettingsSwitchRow
              icon="bolt.circle"
              label="Use in T3 Code"
              subtitle="Adds a CLIProxyAPI provider with every model and failover model it serves."
              value={status.connected}
              disabled={pending || (!status.connected && !manageable)}
              onValueChange={(enabled) => act({ type: "setConnected", enabled })}
            />
          </>
        ) : null}
      </SettingsSection>
      {manageable ? (
        <SettingsSection title="Accounts">
          {accounts.length === 0 ? (
            <Text className="p-4 text-sm text-foreground-muted">No accounts yet.</Text>
          ) : (
            accounts.map((credential) => {
              const state = cliProxyAccountState(credential);
              const retryAt = state === "limited" ? cliProxyRetryAt(credential) : null;
              const windows = cliProxyUsageWindows(credential)
                .map((window) => `${window.label} ${window.usedPercent}%`)
                .join(" · ");
              return (
                <SettingsSwitchRow
                  key={credential.id}
                  icon="person.crop.circle"
                  label={credential.email ?? credential.label ?? credential.name}
                  subtitle={[
                    credential.provider,
                    retryAt === null
                      ? STATE_LABELS[state]
                      : `At its limit until ${new Date(retryAt).toLocaleString()}`,
                    windows,
                  ]
                    .filter((part) => part !== "")
                    .join(" · ")}
                  value={state !== "disabled"}
                  disabled={pending}
                  onValueChange={(enabled) =>
                    void management({
                      environmentId,
                      input: {
                        method: "PATCH",
                        path: "/v8/management/credentials/status",
                        body: { name: credential.name, disabled: !enabled },
                      },
                    }).then(readCredentials)
                  }
                />
              );
            })
          )}
          <Text className="px-4 py-3 text-xs text-foreground-muted">
            Add accounts, API keys, and failover models from T3 Code on web or desktop.
          </Text>
        </SettingsSection>
      ) : null}
    </>
  );
}
