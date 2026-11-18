import {
  formatProviderSubagentStatus,
  type ProviderSubagentStatus,
} from "@t3tools/client-runtime/state/thread-execution";
import { isOrchestrationV2WorkActive, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { Button } from "../../components/ui/Button";
import { NativeChildWorkSheet } from "./NativeChildWorkSheet";
import { useVisibleSecondClock } from "./use-visible-second-clock";

export function ProviderSubagentBar(props: {
  readonly provider: { readonly driver: string; readonly iconUrl?: string | undefined } | null;
  /** The named agent it runs as, such as Gentle AI's `gentle-ai-worker`. */
  readonly agentName: string | null;
  readonly modelLabel: string;
  readonly effortLabel: string | null;
  readonly status: ProviderSubagentStatus | null;
  readonly onOpenParent: (() => void) | null;
  /** Set for providers whose children T3 reads on demand instead of streaming. */
  readonly inspect: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [inspecting, setInspecting] = useState(false);
  const live = props.status !== null && isOrchestrationV2WorkActive(props.status.status);
  const nowMs = useVisibleSecondClock(live);
  const statusLabel = formatProviderSubagentStatus(props.status, nowMs, messages);
  const modelLabel =
    props.effortLabel === null ? props.modelLabel : `${props.modelLabel}, ${props.effortLabel}`;
  const modelDescription =
    props.agentName === null
      ? modelLabel
      : gt("{model} as {agent}", { model: modelLabel, agent: props.agentName });

  return (
    <View className="flex-row items-center gap-3 rounded-[20px] border border-border-subtle bg-card-alt py-2 pe-2 ps-4">
      {}
      <View
        accessible
        accessibilityLabel={gt(
          "{modelDescription} subagent, {statusLabel}. It runs on its own and cannot take messages.",
          { modelDescription, statusLabel },
        )}
        className="min-w-0 flex-1 gap-0.5"
      >
        <View className="min-w-0 flex-row items-center gap-1.5">
          {props.provider ? (
            <ProviderIcon
              iconUrl={props.provider.iconUrl}
              provider={props.provider.driver}
              size={16}
            />
          ) : null}
          {/* The agent's name stays whole; its model shrinks instead. */}
          <Text
            numberOfLines={1}
            className={
              props.agentName === null
                ? "min-w-0 shrink font-t3-bold text-sm text-foreground"
                : "min-w-0 shrink font-sans text-sm text-foreground-secondary"
            }
          >
            {props.modelLabel}
          </Text>
          {props.effortLabel === null ? null : (
            <Text
              numberOfLines={1}
              className="shrink-0 font-sans text-sm text-foreground-secondary"
            >
              {props.effortLabel}
            </Text>
          )}
          {props.agentName === null ? null : (
            <Text numberOfLines={1} className="shrink-0 font-t3-bold text-sm text-foreground">
              {props.agentName}
            </Text>
          )}
        </View>
        <Text
          numberOfLines={1}
          className="font-sans text-xs text-foreground-secondary"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          <T>
            <Var>{statusLabel}</Var> · Runs on its own
          </T>
        </Text>
      </View>
      {props.inspect ? (
        <Button
          label={gt("Work", { $context: "noun, opens the subagent's work log" })}
          tone="secondary"
          onPress={() => setInspecting(true)}
        />
      ) : null}
      {props.onOpenParent ? (
        <Button label={gt("Open parent")} tone="secondary" onPress={props.onOpenParent} />
      ) : null}
      {props.inspect && inspecting ? (
        <NativeChildWorkSheet {...props.inspect} onClose={() => setInspecting(false)} />
      ) : null}
    </View>
  );
}
