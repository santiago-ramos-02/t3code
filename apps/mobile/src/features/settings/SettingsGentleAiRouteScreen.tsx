import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  PROVIDER_DISPLAY_NAMES,
  type GentleAiActionInput,
  type GentleAiStatus,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

type GentleAiAction = GentleAiActionInput["action"];

/** Whether Gentle AI runs with any provider on an environment. */
export function environmentRunsGentleAi(target: SettingsTarget): boolean {
  return target.serverConfig.providers.some((provider) => provider.gentleAi === true);
}

/**
 * Gentle AI on each selected environment: what it runs with and its ecosystem commands. Matches
 * the web Gentle AI settings page; per-project gentle-pi choices stay in Project overview.
 */
export function SettingsGentleAiRouteScreen() {
  const insets = useSafeAreaInsets();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const targets = selectedTargets.filter(environmentRunsGentleAi);
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Gentle AI" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {targets.length === 0 ? (
            <Text className="px-2 text-base text-foreground-muted">
              No provider on the selected environments runs with Gentle AI.
            </Text>
          ) : (
            targets.map((target) => (
              <GentleAiEnvironmentSettings
                key={target.environmentId}
                target={target}
                showLabel={targets.length > 1}
              />
            ))
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function GentleAiEnvironmentSettings(props: {
  readonly target: SettingsTarget;
  readonly showLabel: boolean;
}) {
  const environmentId = props.target.environmentId;
  const read = useAtomCommand(serverEnvironment.readGentleAi, {
    reportFailure: false,
    reportDefect: false,
  });
  const runAction = useAtomCommand(serverEnvironment.runGentleAiAction, {
    reportFailure: false,
    reportDefect: false,
  });
  const [status, setStatus] = useState<GentleAiStatus | null>(null);
  const [pending, setPending] = useState<GentleAiAction | null>(null);

  useEffect(() => {
    let current = true;
    void read({ environmentId, input: {} }).then((result) => {
      if (current && result._tag === "Success") setStatus(result.value);
    });
    return () => {
      current = false;
    };
  }, [environmentId, read]);

  const act = (action: GentleAiAction, title: string) => {
    if (pending) return;
    setPending(action);
    void runAction({ environmentId, input: { action } }).then((result) => {
      setPending(null);
      if (result._tag === "Success") {
        setStatus(result.value.status);
        if (result.value.output) Alert.alert(title, result.value.output);
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        Alert.alert(title, failure instanceof Error ? failure.message : "Try again.");
      }
    });
  };

  const providers = props.target.serverConfig.providers
    .filter((provider) => provider.gentleAi === true)
    .map(
      (provider) =>
        provider.displayName ?? PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver,
    );
  const title = [
    "Gentle AI",
    status?.version ? status.version : null,
    props.showLabel ? props.target.label : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <SettingsSection title={title}>
      <View className="gap-3 p-4">
        <Text className="text-sm text-foreground-muted">Runs with {providers.join(", ")}</Text>
        {status === null ? (
          <View className="flex-row items-center gap-2">
            <ActivityIndicator />
            <Text className="text-sm text-foreground-muted">Reading Gentle AI</Text>
          </View>
        ) : !status.installed ? (
          <Text className="text-sm text-foreground-muted">
            gentle-ai was not found on this environment. Set its binary path in web or desktop
            settings for ecosystem commands.
          </Text>
        ) : (
          <>
            {status.syncNeeded ? (
              <Text className="text-sm text-foreground-muted">
                gentle-ai changed since it last updated the agents it set up.
              </Text>
            ) : null}
            <View className="flex-row flex-wrap gap-2">
              <Action
                label={pending === "sync" ? "Syncing…" : "Sync"}
                disabled={pending !== null}
                onPress={() => act("sync", "Gentle AI sync")}
              />
              <Action
                label={pending === "update" ? "Checking…" : "Check for updates"}
                disabled={pending !== null}
                onPress={() => act("update", "Gentle AI updates")}
              />
              <Action
                label={pending === "doctor" ? "Checking…" : "Run doctor"}
                disabled={pending !== null}
                onPress={() => act("doctor", "Gentle AI doctor")}
              />
            </View>
          </>
        )}
      </View>
    </SettingsSection>
  );
}

function Action(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-11 justify-center rounded-full bg-subtle-strong px-4 disabled:opacity-40"
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}
