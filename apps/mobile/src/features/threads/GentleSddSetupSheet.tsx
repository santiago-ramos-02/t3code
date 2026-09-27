import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  GENTLE_SDD_DEFAULTS,
  gentleSddSetupNotice,
} from "@t3tools/client-runtime/piGentleComposer";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProviderInstanceId, type PiGentleSddPreferences } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { GentleSddChoices } from "../settings/GentleSddChoices";
import { SheetActionButton } from "./git/gitSheetComponents";

type GentleSddSetupSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly instanceId: string;
  readonly cwd: string;
}>;

/**
 * SDD preflight for a project, opened from a Pi thread's Gentle AI menu: the user confirms or
 * changes Gentle AI's suggested choices, and setup saves them before Gentle AI prepares the
 * project. Matches the web composer's setup dialog.
 */
export function GentleSddSetupSheet(props: GentleSddSetupSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const instanceId = ProviderInstanceId.make(props.route.params.instanceId);
  const cwd = props.route.params.cwd;
  const read = useAtomCommand(serverEnvironment.readPiGentleComposer, {
    reportFailure: false,
    reportDefect: false,
  });
  const initialize = useAtomCommand(serverEnvironment.initializePiGentleSdd, {
    reportFailure: false,
    reportDefect: false,
  });
  const [loaded, setLoaded] = useState<{
    readonly setUp: boolean;
    readonly draft: PiGentleSddPreferences;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void read({ environmentId, input: { instanceId, cwd } }).then((result) => {
      if (!current) return;
      if (result._tag === "Success") {
        setLoaded({
          setUp: !result.value.projectInitNeeded,
          draft: result.value.sdd ?? GENTLE_SDD_DEFAULTS,
        });
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not read SDD preferences.");
      }
    });
    return () => {
      current = false;
    };
  }, [cwd, environmentId, instanceId, read]);

  const submit = (preferences: PiGentleSddPreferences) => {
    setPending(true);
    setError(null);
    void initialize({ environmentId, input: { instanceId, cwd, preferences } }).then((result) => {
      setPending(false);
      if (result._tag === "Success") {
        const notice = gentleSddSetupNotice(preferences, result.value.sdd);
        if (notice) Alert.alert("SDD set up", notice);
        navigation.goBack();
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not set up SDD.");
      }
    });
  };

  const title = loaded?.setUp ? "SDD preferences" : "Set up SDD";
  return (
    <View collapsable={false} className="bg-sheet flex-1">
      {Platform.OS === "android" ? (
        <AndroidSheetHeader title={title} onBack={() => navigation.goBack()} hideBottomBorder />
      ) : (
        <View className="min-h-4 pt-2" />
      )}
      <MaterialScreenContent>
        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="gap-3 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 8 }}
        >
          {Platform.OS !== "android" ? (
            <Text className="text-2xl font-t3-bold text-foreground">{title}</Text>
          ) : null}
          <Text className="text-sm text-foreground-muted">
            Saved in .pi/gentle-ai/sdd-preflight.json. Gentle AI asks you to confirm them the first
            time each thread uses SDD.
          </Text>
          {loaded === null ? (
            error ? null : (
              <View className="flex-row items-center gap-2 py-2">
                <ActivityIndicator />
                <Text className="text-sm text-foreground-muted">Reading SDD preferences</Text>
              </View>
            )
          ) : (
            <>
              <GentleSddChoices
                value={loaded.draft}
                disabled={pending}
                onChange={(patch) =>
                  setLoaded((current) =>
                    current === null
                      ? current
                      : { ...current, draft: { ...current.draft, ...patch } },
                  )
                }
              />
              <View className="pt-2">
                <SheetActionButton
                  icon="checkmark.circle"
                  label={pending ? "Setting up…" : loaded.setUp ? "Save" : "Set up"}
                  tone="primary"
                  disabled={pending}
                  onPress={() => submit(loaded.draft)}
                />
              </View>
            </>
          )}
          {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
