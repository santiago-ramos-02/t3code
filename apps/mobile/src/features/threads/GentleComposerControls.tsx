import { GENTLE_AI_OPTION_ID, gentleAiEnabled } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ModelSelection,
  PiGentleComposerState,
  ServerProvider,
} from "@t3tools/contracts";
import {
  GENTLE_ODD_NEW_SPEC_PROMPT,
  gentleOddContinuePrompt,
  gentleOddFeatureSummary,
  gentleOddMenuFeatures,
  gentleOddThreadFeaturePaths,
} from "@t3tools/client-runtime/gentle-ai";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Alert, View } from "react-native";

import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { ControlPillMenu } from "../../components/ControlPill";
import type { RemoteClientConnectionState } from "../../lib/connection";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  createNewTaskDraft,
  setComposerDraftText,
  updateComposerDraftSettings,
} from "../../state/use-composer-drafts";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useGentleAiQuery } from "../settings/SettingsGentleAiRouteScreen";
import { GentleRoseIcon } from "./GentleRoseIcon";
import { useGentleProfileMenu } from "./useGentleProfileMenu";

/**
 * The thread composer's Gentle AI pill, for a provider Gentle AI is set up for. Its menu turns
 * Gentle AI on or off while the thread is new, switches the profile, and starts a task from the
 * project's ODD feature documents. Kept out of ThreadComposer so the fork's change there stays a
 * single element.
 */
export function GentleComposerControls(props: {
  readonly environmentId: EnvironmentId;
  readonly selectedThread: EnvironmentThreadShell;
  /** The thread's feed, to tell which feature documents it works on. */
  readonly threadFeed: ReadonlyArray<ThreadFeedEntry>;
  readonly projectCwd: string | null;
  readonly connectionState: RemoteClientConnectionState;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly onUpdateModelSelection: (selection: ModelSelection) => void;
  /** Whether the composer has room for it: expanded, and not dictating. */
  readonly shown: boolean;
  readonly onVisibilityChange?: ((visible: boolean) => void) | undefined;
}) {
  const navigation = useNavigation();
  const { themeVariables: materialTheme } = useAppearancePreferences();
  const { selectedProviderStatus } = props;
  const currentModelSelection = props.selectedThread.modelSelection;
  const isPiThread = selectedProviderStatus?.driver === "pi";
  const gentleProvider = selectedProviderStatus?.gentleAi === true;
  const gentleKey = `${props.environmentId}:${props.selectedThread.id}:${props.selectedThread.latestRun?.runId ?? ""}:${currentModelSelection.instanceId}:${props.projectCwd ?? ""}`;
  const readGentle = useAtomCommand(serverEnvironment.readPiGentleComposer, {
    reportFailure: false,
    reportDefect: false,
  });
  const [gentleLoaded, setGentleLoaded] = useState<{
    key: string;
    value: PiGentleComposerState;
  } | null>(null);
  const [gentleError, setGentleError] = useState<{ key: string; message: string } | null>(null);
  const gentleAiStatus = useEnvironmentQuery(
    serverEnvironment.gentleAiStatus({ environmentId: props.environmentId, input: {} }),
  ).data;
  // Native menus cannot load after opening, so the ODD feature documents are read up front.
  const gentleOddListed =
    gentleProvider && gentleAiStatus?.oddFeatures === true && props.projectCwd !== null;
  const gentleOdd = useGentleAiQuery(
    props.environmentId,
    "odd.features",
    { cwd: props.projectCwd ?? "" },
    { enabled: gentleOddListed },
  );
  // Finished documents drop out; the ones this thread works on come first.
  const gentleOddMenu = useMemo(() => {
    const features = gentleOdd.data?.features ?? [];
    if (features.length === 0) return [];
    const trail = {
      messages: props.threadFeed.flatMap((entry) =>
        entry.type === "message" ? [{ text: entry.message.text }] : [],
      ),
      records: props.threadFeed.flatMap((entry) =>
        entry.type === "activity-group" ? entry.activities.map((activity) => activity.detail) : [],
      ),
    };
    return gentleOddMenuFeatures(
      features,
      gentleOddThreadFeaturePaths(
        trail,
        features.map((feature) => feature.path),
      ),
    );
  }, [gentleOdd.data, props.threadFeed]);
  const [gentleRefresh, setGentleRefresh] = useState(0);
  useEffect(() => {
    if (!isPiThread || props.connectionState !== "connected" || props.projectCwd === null) return;
    let current = true;
    void readGentle({
      environmentId: props.environmentId,
      input: { instanceId: currentModelSelection.instanceId, cwd: props.projectCwd },
    }).then((result) => {
      if (!current) return;
      if (result._tag === "Success") {
        setGentleLoaded({ key: gentleKey, value: result.value });
        setGentleError(null);
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setGentleLoaded(null);
        setGentleError({
          key: gentleKey,
          message: failure instanceof Error ? failure.message : "Could not read Gentle AI status.",
        });
      }
    });
    return () => {
      current = false;
    };
  }, [
    currentModelSelection.instanceId,
    isPiThread,
    gentleKey,
    gentleRefresh,
    props.connectionState,
    props.environmentId,
    props.projectCwd,
    readGentle,
  ]);
  const gentleState = gentleLoaded?.key === gentleKey ? gentleLoaded.value : null;
  const gentleAvailable = gentleState?.available === true;
  const gentleEnabled = gentleAiEnabled(currentModelSelection.options);
  const canChangeGentle = props.selectedThread.latestRun === null;
  const showGentleControls =
    gentleProvider &&
    props.connectionState === "connected" &&
    // In Pi, nothing Gentle-related shows unless the server confirms Pi loads gentle-pi here.
    (!isPiThread || gentleAvailable) &&
    // A thread that started without Gentle AI keeps it off, so it has nothing to offer.
    (gentleEnabled || canChangeGentle);
  // Hands a Gentle AI step to a new task draft in this project with Gentle on; the user sends it.
  const startGentleTask = (prompt: string) => {
    const draftKey = createNewTaskDraft({
      environmentId: props.environmentId,
      projectId: props.selectedThread.projectId,
    });
    updateComposerDraftSettings(draftKey, {
      modelSelection: {
        ...currentModelSelection,
        options: [
          ...(currentModelSelection.options?.filter(
            (option) => option.id !== GENTLE_AI_OPTION_ID,
          ) ?? []),
          { id: GENTLE_AI_OPTION_ID, value: true },
        ],
      },
    });
    setComposerDraftText(draftKey, prompt);
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId: String(props.environmentId),
        projectId: String(props.selectedThread.projectId),
        draftId: draftKey,
      },
    });
  };
  const gentleProfiles = useGentleProfileMenu({
    environmentId: props.environmentId,
    cwd: props.projectCwd,
    state: gentleState,
    enabled: gentleEnabled,
    selection: currentModelSelection,
    models: selectedProviderStatus?.models ?? [],
    onModelSelectionChange: props.onUpdateModelSelection,
    onApplied: () => setGentleRefresh((value) => value + 1),
  });
  const gentleMenuActions: MenuAction[] = [
    ...(canChangeGentle
      ? [
          {
            id: "enable",
            title: "Gentle AI",
            state: gentleEnabled ? ("on" as const) : ("off" as const),
          },
        ]
      : []),
    ...(gentleProfiles.action === null ? [] : [gentleProfiles.action]),
    ...(gentleOddListed
      ? [
          {
            id: "odd",
            title: "Feature documents",
            image: "doc.text",
            subactions: [
              ...gentleOddMenu.map(({ feature, inThread }) => ({
                id: `odd:${feature.path}`,
                title: feature.title,
                subtitle: inThread
                  ? `In this thread · ${gentleOddFeatureSummary(feature)}`
                  : gentleOddFeatureSummary(feature),
              })),
              ...(gentleOdd.data === null
                ? [
                    {
                      id: "odd-unavailable",
                      title: gentleOdd.error ? "Unavailable" : "Reading…",
                      ...(gentleOdd.error ? { subtitle: gentleOdd.error } : {}),
                      attributes: { disabled: true },
                    },
                  ]
                : gentleOddMenu.length === 0
                  ? [
                      {
                        id: "odd-empty",
                        title: gentleOdd.data.features.length === 0 ? "None yet" : "All done",
                        attributes: { disabled: true },
                      },
                    ]
                  : []),
              { id: "odd-new", title: "New spec", image: "plus" },
            ],
          },
        ]
      : []),
    ...(gentleError?.key === gentleKey
      ? [{ id: "error", title: "Show error", image: "exclamationmark.triangle" }]
      : []),
    { id: "refresh", title: "Refresh", image: "arrow.clockwise" },
  ];
  const visible = props.shown && showGentleControls;
  const { onVisibilityChange } = props;
  useEffect(() => {
    onVisibilityChange?.(visible);
    return () => onVisibilityChange?.(false);
  }, [visible, onVisibilityChange]);
  if (!visible) return null;
  return (
    <View className="flex-row items-center justify-end gap-1 px-2 pb-1">
      <ControlPillMenu
        actions={gentleMenuActions}
        onPressAction={({ nativeEvent }) => {
          if (gentleProfiles.handle(nativeEvent.event)) return;
          if (nativeEvent.event === "enable" && canChangeGentle) {
            props.onUpdateModelSelection({
              ...currentModelSelection,
              options: [
                ...(currentModelSelection.options?.filter(
                  (option) => option.id !== GENTLE_AI_OPTION_ID,
                ) ?? []),
                { id: GENTLE_AI_OPTION_ID, value: !gentleEnabled },
              ],
            });
          }
          if (nativeEvent.event === "odd-new") startGentleTask(GENTLE_ODD_NEW_SPEC_PROMPT);
          if (nativeEvent.event.startsWith("odd:")) {
            const feature = gentleOdd.data?.features.find(
              (entry) => `odd:${entry.path}` === nativeEvent.event,
            );
            if (feature) startGentleTask(gentleOddContinuePrompt(feature));
          }
          if (nativeEvent.event === "error" && gentleError?.key === gentleKey) {
            Alert.alert("Gentle AI", gentleError.message);
          }
          if (nativeEvent.event === "refresh") setGentleRefresh((value) => value + 1);
        }}
      >
        <ComposerInlineControl
          // On or off, and the profile in use, show in the menu.
          label="Gentle AI"
          accessibilityLabel={
            gentleEnabled
              ? `Gentle AI${gentleState?.effectiveProfile ? `, profile ${gentleState.effectiveProfile.name}` : ""}`
              : "Gentle AI off"
          }
          renderIcon={(size) => (
            <GentleRoseIcon color={materialTheme["--color-foreground"]} size={size} />
          )}
          maxWidth={125}
        />
      </ControlPillMenu>
    </View>
  );
}
