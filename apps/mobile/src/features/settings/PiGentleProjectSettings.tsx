import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PiGentleSddPreferences,
  PiGentleState,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { canMaintainEnvironment } from "./environment-maintenance";

const DEFAULT_SDD: PiGentleSddPreferences = {
  executionMode: "auto",
  artifactStore: "openspec",
  chainedPrStrategy: "ask-on-risk",
  reviewBudgetLines: 400,
};

type ProjectAction =
  | { readonly type: "create" | "pin"; readonly name: string }
  | { readonly type: "activate"; readonly name: string }
  | { readonly type: "clearPin" }
  | { readonly type: "setPersona"; readonly mode: "gentleman" | "neutral" | null }
  | { readonly type: "saveSdd"; readonly preferences: PiGentleSddPreferences };

function ChoiceMenu<Value extends string>(props: {
  readonly label: string;
  readonly value: Value;
  readonly choices: ReadonlyArray<{ value: Value; label: string }>;
  readonly disabled: boolean;
  readonly onChange: (value: Value) => void;
}) {
  const selected = props.choices.find((choice) => choice.value === props.value);
  return (
    <ControlPillMenu
      accessible
      accessibilityRole="button"
      accessibilityLabel={props.label}
      title={props.label}
      actions={props.choices.map((choice) => ({
        id: choice.value,
        title: choice.label,
        state: choice.value === props.value ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => {
        const choice = props.choices.find((entry) => entry.value === nativeEvent.event);
        if (choice) props.onChange(choice.value);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}: ${selected?.label ?? props.value}`}
        disabled={props.disabled}
        className="min-h-11 flex-row items-center justify-between gap-3 border-b border-border-subtle py-2 disabled:opacity-40"
      >
        <Text className="text-sm text-foreground-muted">{props.label}</Text>
        <Text className="min-w-0 flex-1 text-right text-sm text-foreground" numberOfLines={2}>
          {selected?.label ?? props.value}
        </Text>
      </Pressable>
    </ControlPillMenu>
  );
}

export function PiGentleProjectSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly environmentLabel: string;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  return config?.providers
    .filter((provider) => provider.driver === "pi" && provider.enabled)
    .map((provider) => (
      <PiGentleInstanceSettings
        key={provider.instanceId}
        {...props}
        instanceId={provider.instanceId}
        instanceName={provider.displayName ?? "Pi"}
      />
    ));
}

function PiGentleInstanceSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly instanceName: string;
}) {
  const session = useAtomValue(environmentSession.sessionStateValueAtom(props.environmentId));
  const sessionResult = useAtomValue(environmentSession.sessionStateAtom(props.environmentId));
  const instanceId = props.instanceId;
  const canEdit = !AsyncResult.isFailure(sessionResult) && canMaintainEnvironment(session, true);
  const read = useAtomCommand(serverEnvironment.readPiGentle, {
    reportFailure: false,
    reportDefect: false,
  });
  const update = useAtomCommand(serverEnvironment.updatePiGentle, {
    reportFailure: false,
    reportDefect: false,
  });
  const [state, setState] = useState<PiGentleState | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [sddDraft, setSddDraft] = useState<PiGentleSddPreferences | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null);

  useEffect(() => {
    const requestKey = JSON.stringify([
      props.environmentId,
      instanceId,
      props.workspaceRoot,
      refresh,
    ]);
    let activeRequest: string | null = requestKey;
    void read({
      environmentId: props.environmentId,
      input: { instanceId, cwd: props.workspaceRoot },
    }).then((result) => {
      if (activeRequest !== requestKey) return;
      if (result._tag === "Success") {
        setState(result.value);
        setSelectedProfile(result.value.project?.pinned ?? result.value.active);
        setError(null);
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not load Gentle AI settings.");
      }
    });
    return () => {
      activeRequest = null;
    };
  }, [instanceId, props.environmentId, props.workspaceRoot, read, refresh]);

  if (state?.available === false) return null;

  const sdd = sddDraft ?? state?.project?.sdd ?? DEFAULT_SDD;
  const budget = budgetDraft ?? String(sdd.reviewBudgetLines);
  const parsedBudget = Number(budget);
  const budgetValid = Number.isInteger(parsedBudget) && parsedBudget > 0;
  const savedSdd = state?.project?.sdd;
  const sddChanged =
    !savedSdd ||
    savedSdd.executionMode !== sdd.executionMode ||
    savedSdd.artifactStore !== sdd.artifactStore ||
    savedSdd.chainedPrStrategy !== sdd.chainedPrStrategy ||
    savedSdd.reviewBudgetLines !== parsedBudget;
  const editable = canEdit && !pending;

  async function act(action: ProjectAction) {
    if (pending) return;
    setPending(true);
    setError(null);
    const request = { ...action, cwd: props.workspaceRoot };
    try {
      const result = await update({
        environmentId: props.environmentId,
        input: { instanceId, action: request },
      });
      if (result._tag === "Success") {
        setState(result.value);
        if (action.type === "create") {
          setSelectedProfile(action.name);
          setNewName("");
        }
        if (action.type === "saveSdd") {
          setSddDraft(null);
          setBudgetDraft(null);
        }
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error ? failure.message : "Could not update Gentle AI settings.",
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update Gentle AI settings.");
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsSection
      title={`Gentle AI${state?.version ? ` · ${state.version}` : ""} · ${props.environmentLabel}${props.instanceName === "Pi" ? "" : ` · ${props.instanceName}`}`}
    >
      <View className="gap-3 p-4">
        {state === null ? (
          error ? (
            <View className="gap-2">
              <Text className="text-sm text-danger-foreground">{error}</Text>
              <Action
                label="Retry"
                disabled={false}
                onPress={() => {
                  setError(null);
                  setRefresh((value) => value + 1);
                }}
              />
            </View>
          ) : (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator />
              <Text className="text-sm text-foreground-muted">Checking Gentle AI</Text>
            </View>
          )
        ) : (
          <>
            <Text className="text-sm text-foreground">
              Model profile: {state.project?.pinned ?? `Global (${state.active ?? "none"})`}
            </Text>
            {state.project?.pinned ? (
              <Text className="text-sm text-foreground-muted">
                Global profile: {state.active ?? "none"}
              </Text>
            ) : null}
            <ChoiceMenu
              label="Profile to pin"
              value={selectedProfile ?? ""}
              choices={state.profiles.map((profile) => ({
                value: profile.name,
                label: profile.name,
              }))}
              disabled={!editable || !state.project?.pinAvailable || state.profiles.length === 0}
              onChange={setSelectedProfile}
            />
            <View className="flex-row flex-wrap gap-2">
              {selectedProfile ? (
                <Action
                  label="Use globally"
                  disabled={!editable || state.active === selectedProfile}
                  onPress={() => void act({ type: "activate", name: selectedProfile })}
                />
              ) : null}
              {selectedProfile && state.project?.pinAvailable ? (
                <Action
                  label="Use for checkout"
                  disabled={!editable || state.project.pinned === selectedProfile}
                  onPress={() => void act({ type: "pin", name: selectedProfile })}
                />
              ) : null}
              {state.project?.pinSource === "local" ? (
                <Action
                  label="Remove pin"
                  disabled={!editable}
                  onPress={() => void act({ type: "clearPin" })}
                />
              ) : null}
            </View>
            {!state.project?.pinAvailable ? (
              <Text className="text-sm text-foreground-muted">
                Profile pins require a Git repository.
              </Text>
            ) : null}
            {state.project ? (
              <>
                <ChoiceMenu
                  label="Persona for this project"
                  value={state.project.persona.override ?? "global"}
                  choices={[
                    { value: "global", label: `Use global (${state.project.persona.global})` },
                    { value: "gentleman", label: "Gentleman" },
                    { value: "neutral", label: "Neutral" },
                  ]}
                  disabled={!editable}
                  onChange={(value) =>
                    void act({ type: "setPersona", mode: value === "global" ? null : value })
                  }
                />
                <Text className="text-xs text-foreground-muted">
                  Applies when a new Pi session starts.
                </Text>
              </>
            ) : null}
            <View className="flex-row items-center gap-2">
              <AppTextInput
                accessibilityLabel="New Gentle AI profile name"
                placeholder="New profile name"
                value={newName}
                onChangeText={setNewName}
                editable={editable}
                className="min-h-11 min-w-0 flex-1 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
              />
              <Action
                label="Create"
                disabled={!editable || !newName.trim()}
                onPress={() => void act({ type: "create", name: newName.trim() })}
              />
            </View>
            <View className="pt-3">
              <Text className="text-base font-t3-semibold text-foreground">SDD setup</Text>
              <Text className="text-sm text-foreground-muted">
                Saved choices guide Gentle AI in this checkout.
              </Text>
            </View>
            <ChoiceMenu
              label="Execution mode"
              value={sdd.executionMode}
              choices={[
                { value: "auto", label: "Automatic" },
                { value: "interactive", label: "Confirm each phase" },
              ]}
              disabled={!editable}
              onChange={(value) => setSddDraft({ ...sdd, executionMode: value })}
            />
            <ChoiceMenu
              label="Artifact store"
              value={sdd.artifactStore}
              choices={[
                { value: "openspec", label: "OpenSpec project files" },
                { value: "engram", label: "Engram memory" },
                { value: "hybrid", label: "Project files + Engram" },
                { value: "none", label: "No saved artifacts" },
              ]}
              disabled={!editable}
              onChange={(value) => setSddDraft({ ...sdd, artifactStore: value })}
            />
            <ChoiceMenu
              label="Delivery strategy"
              value={sdd.chainedPrStrategy}
              choices={[
                { value: "ask-on-risk", label: "Ask when over budget" },
                { value: "auto-chain", label: "Chain large changes" },
                { value: "single-pr", label: "One pull request" },
              ]}
              disabled={!editable}
              onChange={(value) => setSddDraft({ ...sdd, chainedPrStrategy: value })}
            />
            <View className="flex-row items-center gap-3">
              <Text className="flex-1 text-sm text-foreground-muted">Review budget (lines)</Text>
              <AppTextInput
                accessibilityLabel="Review budget in lines"
                keyboardType="number-pad"
                value={budget}
                editable={editable}
                onChangeText={setBudgetDraft}
                className="min-h-11 w-24 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
              />
            </View>
            <Action
              label={pending ? "Saving…" : "Save SDD choices"}
              disabled={!editable || !budgetValid || !sddChanged}
              onPress={() =>
                void act({
                  type: "saveSdd",
                  preferences: { ...sdd, reviewBudgetLines: parsedBudget },
                })
              }
            />
            {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
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
