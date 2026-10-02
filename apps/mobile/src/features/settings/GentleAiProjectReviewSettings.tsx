import { useAtomValue } from "@effect/atom-react";
import {
  gentleAiProjectReview,
  gentleAiReviewHistoryLabel,
  gentleAiReviewStoreSummary,
} from "@t3tools/client-runtime/gentle-ai";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, GentleAiJobMethod, GentleAiParams } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { Alert, Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsControlRow } from "./components/SettingsControlRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { canMaintainEnvironment } from "./environment-maintenance";
import { useGentleAiQuery } from "./SettingsGentleAiRouteScreen";

/**
 * Gentle AI's review for one project checkout, like the web project section: review here
 * follows the switch for every project unless turned off, and the checkout's review history.
 */
export function GentleAiProjectReviewSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly environmentLabel: string;
}) {
  const status = useEnvironmentQuery(
    serverEnvironment.gentleAiStatus({ environmentId: props.environmentId, input: {} }),
  ).data;
  // Review needs a gentle-ai with the API, set up in some agent.
  if (status?.apiVersion == null || status.agents.length === 0) return null;
  return <ProjectReview {...props} />;
}

function ProjectReview(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly environmentLabel: string;
}) {
  const { environmentId, workspaceRoot: cwd } = props;
  const session = useAtomValue(environmentSession.sessionStateValueAtom(environmentId));
  const sessionResult = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const mode = useGentleAiQuery(environmentId, "review.status", { cwd });
  const store = useGentleAiQuery(environmentId, "reviewStore.survey", { cwd });
  const job = useEnvironmentQuery(serverEnvironment.gentleAiJob({ environmentId, input: {} })).data;
  const start = useAtomCommand(serverEnvironment.startGentleAiJob, {
    reportFailure: false,
    reportDefect: false,
  });
  const disabled =
    job?.phase === "running" ||
    AsyncResult.isFailure(sessionResult) ||
    !canMaintainEnvironment(session, true);
  const startJob = <M extends GentleAiJobMethod>(method: M, params: GentleAiParams<M>) =>
    void start({ environmentId, input: { method, params } }).then((result) => {
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      Alert.alert("Gentle AI", failure instanceof Error ? failure.message : "Try again.");
    });

  const review = mode.data === null ? null : gentleAiProjectReview(mode.data);
  const counts = store.data === null ? null : gentleAiReviewStoreSummary(store.data);
  const canClear = counts !== null && (counts.removable > 0 || counts.inFlight > 0);

  return (
    <SettingsSection title={`Gentle AI · ${props.environmentLabel}`}>
      <SettingsSwitchRow
        icon="checkmark.circle"
        label="Review before delivery"
        subtitle={
          mode.error ??
          (review === null
            ? "Reading…"
            : review.overridden
              ? "Off in this project only."
              : review.canTurnOn
                ? "Follows the setting for every project."
                : "Off for every project. Turn it on from Gentle AI settings.")
        }
        value={review?.checked ?? false}
        disabled={disabled || review === null || (!review.checked && !review.canTurnOn)}
        onValueChange={(enabled) => startJob("review.set", { cwd, enabled, scope: "clone" })}
      />
      <SettingsControlRow
        icon="doc.text"
        label="Review history"
        subtitle={
          store.error ?? (counts === null ? "Reading…" : gentleAiReviewHistoryLabel(counts))
        }
        disabled={disabled || !canClear}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear review history"
          disabled={disabled || !canClear}
          onPress={() =>
            Alert.alert(
              "Clear review history?",
              "Removes this checkout's review history. This cannot be undone.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Clear",
                  style: "destructive",
                  onPress: () => startJob("reviewStore.reset", { cwd }),
                },
              ],
            )
          }
          className="min-h-11 justify-center rounded-full bg-subtle-strong px-4 disabled:opacity-40"
        >
          <Text className="text-sm font-t3-medium text-foreground">Clear</Text>
        </Pressable>
      </SettingsControlRow>
    </SettingsSection>
  );
}
