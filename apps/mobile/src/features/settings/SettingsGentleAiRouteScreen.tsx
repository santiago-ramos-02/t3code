import { useAtomValue } from "@effect/atom-react";
import {
  GENTLE_AI_JOB_LABELS,
  gentleAiAgentList,
  gentleAiModelAgent,
  gentleAiModelsAllDefault,
  gentleAiSyncNeeded,
} from "@t3tools/client-runtime/gentle-ai";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  PROVIDER_DISPLAY_NAMES,
  decodeGentleAiResult,
  EnvironmentId,
  type GentleAiActionInput,
  type GentleAiApiStatus,
  type GentleAiJob,
  type GentleAiJobMethod,
  type GentleAiModelAgent,
  type GentleAiParams,
  type GentleAiQueryMethod,
  type GentleAiResult,
  type GentleAiStatus,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ChoiceMenu } from "./GentleSddChoices";
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

// Keyed by the environments' ids so each set of environments shares one derived atom.
const installedOnAnyFamily = Atom.family((key: string) =>
  Atom.make((get) =>
    key
      .split("|")
      .filter((id) => id.length > 0)
      .some((environmentId) => {
        const status = get(
          serverEnvironment.gentleAiStatus({
            environmentId: EnvironmentId.make(environmentId),
            input: {},
          }),
        );
        return status._tag === "Success" && status.value.installed;
      }),
  ),
);

/** Whether gentle-ai is installed on any of these environments, even with nothing set up yet. */
export function useGentleAiInstalledOnAny(environmentIds: ReadonlyArray<EnvironmentId>): boolean {
  return useAtomValue(installedOnAnyFamily([...environmentIds].sort().join("|")));
}

/**
 * Gentle AI on each selected environment. With a gentle-ai that has the headless API this follows
 * the web page's layout as a remote control: status, then each agent with its model preset, then
 * backups. Setting agents up, per-phase models, and removal are on web and desktop.
 */
export function SettingsGentleAiRouteScreen() {
  const insets = useSafeAreaInsets();
  const { selectedTargets } = useSettingsEnvironmentFilter();
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
          {selectedTargets.map((target) => (
            <GentleAiEnvironmentSettings
              key={target.environmentId}
              target={target}
              showLabel={selectedTargets.length > 1}
            />
          ))}
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
  const status = useEnvironmentQuery(
    serverEnvironment.gentleAiStatus({ environmentId, input: {} }),
  ).data;
  if (status === null) return null;
  if (!status.installed && !environmentRunsGentleAi(props.target)) return null;
  const title = ["Gentle AI", status.version, props.showLabel ? props.target.label : null]
    .filter((part) => part !== null)
    .join(" · ");
  return status.apiVersion !== null ? (
    <GentleAiApiSettings environmentId={environmentId} title={title} />
  ) : (
    <GentleAiLegacySettings target={props.target} status={status} title={title} />
  );
}

function useGentleAiQuery<M extends GentleAiQueryMethod>(
  environmentId: EnvironmentId,
  method: M,
  params: GentleAiParams<M>,
) {
  const view = useEnvironmentQuery(
    serverEnvironment.gentleAiQuery({ environmentId, input: { method, params } }),
  );
  const data: GentleAiResult<M> | null =
    view.data === null ? null : Option.getOrNull(decodeGentleAiResult(method, view.data.data));
  return { ...view, data };
}

function GentleAiApiSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
}) {
  const { environmentId } = props;
  const status = useGentleAiQuery(environmentId, "status", {}).data;
  const updates = useGentleAiQuery(environmentId, "updates", {}).data;
  const backups = useGentleAiQuery(environmentId, "backups.list", {}).data;
  const job = useEnvironmentQuery(serverEnvironment.gentleAiJob({ environmentId, input: {} })).data;
  const start = useAtomCommand(serverEnvironment.startGentleAiJob, {
    reportFailure: false,
    reportDefect: false,
  });
  const running = job?.phase === "running";
  const startJob = <M extends GentleAiJobMethod>(method: M, params: GentleAiParams<M>) =>
    void start({ environmentId, input: { method, params } }).then((result) => {
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      Alert.alert("Gentle AI", failure instanceof Error ? failure.message : "Try again.");
    });
  const outdated = updates?.tools.filter((tool) => tool.updateAvailable) ?? [];

  return (
    <>
      {job ? <GentleAiJobSummary job={job} /> : null}
      <SettingsSection title={props.title}>
        <View className="gap-3 p-4">
          <Text className="text-sm text-foreground-muted">
            {updates === null
              ? "Checking for updates…"
              : outdated.length === 0
                ? "Gentle AI and its tools are up to date."
                : outdated.map((tool) => `${tool.name} → ${tool.latest ?? "?"}`).join(" · ")}
          </Text>
          {status && gentleAiSyncNeeded(status) ? (
            <Text className="text-sm text-foreground-muted">
              Gentle AI changed since it last updated your agents. Sync brings them up to date.
            </Text>
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            {outdated.length > 0 ? (
              <Action
                label="Update"
                disabled={running}
                onPress={() => startJob("upgrade", { sync: true })}
              />
            ) : null}
            <Action label="Sync" disabled={running} onPress={() => startJob("sync", {})} />
          </View>
        </View>
      </SettingsSection>
      {status ? (
        <GentleAiAgents
          environmentId={environmentId}
          status={status}
          disabled={running}
          onApply={(agent, preset) => startJob("models.set", { agent, preset })}
        />
      ) : null}
      {backups && backups.backups.length > 0 ? (
        <SettingsSection title="Backups">
          <View className="p-4">
            {backups.backups.map((backup) => (
              <Pressable
                key={backup.id}
                accessibilityRole="button"
                disabled={running}
                className="min-h-11 justify-center border-b border-border-subtle py-2 disabled:opacity-40"
                onPress={() =>
                  Alert.alert(backup.description || backup.source, `${backup.fileCount} files`, [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: backup.pinned ? "Unpin" : "Pin",
                      onPress: () =>
                        startJob("backups.pin", { id: backup.id, pinned: !backup.pinned }),
                    },
                    {
                      text: "Restore",
                      onPress: () => startJob("backups.restore", { id: backup.id }),
                    },
                    {
                      text: "Delete",
                      style: "destructive",
                      onPress: () => startJob("backups.delete", { id: backup.id }),
                    },
                  ])
                }
              >
                <Text className="text-sm text-foreground" numberOfLines={1}>
                  {backup.pinned ? "Pinned · " : ""}
                  {backup.description || backup.source}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {new Date(backup.createdAt).toLocaleString()} · {backup.fileCount} files
                </Text>
              </Pressable>
            ))}
          </View>
        </SettingsSection>
      ) : null}
    </>
  );
}

function GentleAiJobSummary({ job }: { readonly job: GentleAiJob }) {
  const done = job.steps.filter((step) => step.status === "succeeded").length;
  const title = GENTLE_AI_JOB_LABELS[job.method];
  return (
    <SettingsSection title={job.phase === "running" ? "In progress" : "Last change"}>
      <View className="flex-row items-center gap-3 p-4">
        {job.phase === "running" ? <ActivityIndicator /> : null}
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-sm font-t3-medium text-foreground">
            {job.phase === "running"
              ? title
              : job.phase === "succeeded"
                ? `${title}: done`
                : `${title}: failed`}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {job.error ??
              (job.steps.length > 0
                ? `${done} of ${job.steps.length} steps done`
                : (job.log.at(-1) ?? (job.phase === "running" ? "Working…" : "")))}
          </Text>
        </View>
      </View>
    </SettingsSection>
  );
}

const STATE_LABELS = {
  "set-up": "Set up",
  available: "Not set up",
  unsupported: "Not supported on this system",
} as const;

/**
 * Every agent Gentle AI set up or can set up, like the web page's Agents panel, with the model
 * preset for the ones it configures. Setting agents up and removing Gentle AI stay on web and
 * desktop, which have room for the review steps.
 */
function GentleAiAgents(props: {
  readonly environmentId: EnvironmentId;
  readonly status: GentleAiApiStatus;
  readonly disabled: boolean;
  readonly onApply: (agent: GentleAiModelAgent, preset: string) => void;
}) {
  const agents = gentleAiAgentList(props.status);
  return (
    <SettingsSection title="Agents">
      <View className="px-4 pb-2">
        {agents.length === 0 ? (
          <Text className="py-3 text-sm text-foreground-muted">
            No agents found on this environment.
          </Text>
        ) : (
          agents.map((agent) => {
            const modelAgent = agent.state === "set-up" ? gentleAiModelAgent(agent.id) : null;
            return (
              <View
                key={agent.id}
                className="min-h-11 flex-row items-center justify-between gap-3 border-b border-border-subtle py-2"
              >
                <View className="min-w-0 flex-1">
                  <Text className="text-sm text-foreground" numberOfLines={1}>
                    {agent.name}
                  </Text>
                  <Text className="text-xs text-foreground-muted">{STATE_LABELS[agent.state]}</Text>
                </View>
                {modelAgent === null ? null : (
                  <GentleAiModelPreset
                    environmentId={props.environmentId}
                    agent={modelAgent}
                    name={agent.name}
                    disabled={props.disabled}
                    onApply={props.onApply}
                  />
                )}
              </View>
            );
          })
        )}
        <Text className="py-3 text-xs text-foreground-muted">
          Set up agents, customize models per phase, and remove Gentle AI from T3 Code on web or
          desktop.
        </Text>
      </View>
    </SettingsSection>
  );
}

function GentleAiModelPreset(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: GentleAiModelAgent;
  readonly name: string;
  readonly disabled: boolean;
  readonly onApply: (agent: GentleAiModelAgent, preset: string) => void;
}) {
  const config = useGentleAiQuery(props.environmentId, "models.get", { agent: props.agent }).data;
  if (config === null) return <ActivityIndicator />;
  // gentle-ai reports no preset both for custom choices and for none at all.
  const noPreset = gentleAiModelsAllDefault(config.current) ? "Default" : "Custom";
  return (
    <ChoiceMenu
      label={`${props.name} models`}
      value={config.currentPreset ?? ""}
      choices={[
        ...config.presets.map((preset) => ({ value: preset.id, label: preset.label })),
        ...(config.currentPreset === null ? [{ value: "", label: noPreset }] : []),
      ]}
      disabled={props.disabled}
      onChange={(preset) => {
        if (preset !== "") props.onApply(props.agent, preset);
      }}
    />
  );
}

/** A gentle-ai without the headless API: its basic commands. */
function GentleAiLegacySettings(props: {
  readonly target: SettingsTarget;
  readonly status: GentleAiStatus;
  readonly title: string;
}) {
  const environmentId = props.target.environmentId;
  const runAction = useAtomCommand(serverEnvironment.runGentleAiAction, {
    reportFailure: false,
    reportDefect: false,
  });
  const [pending, setPending] = useState<GentleAiAction | null>(null);
  const act = (action: GentleAiAction, title: string) => {
    if (pending) return;
    setPending(action);
    void runAction({ environmentId, input: { action } }).then((result) => {
      setPending(null);
      if (result._tag === "Success") {
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

  return (
    <SettingsSection title={props.title}>
      <View className="gap-3 p-4">
        {providers.length > 0 ? (
          <Text className="text-sm text-foreground-muted">Runs with {providers.join(", ")}</Text>
        ) : null}
        {!props.status.installed ? (
          <Text className="text-sm text-foreground-muted">
            gentle-ai was not found on this environment. Set its binary path in web or desktop
            settings for ecosystem commands.
          </Text>
        ) : (
          <>
            {props.status.syncNeeded ? (
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
            <Text className="text-sm text-foreground-muted">
              Upgrade gentle-ai to manage its full setup from T3 Code.
            </Text>
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
