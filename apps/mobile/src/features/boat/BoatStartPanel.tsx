import {
  boatDraftStartRows,
  type BoatDraftStartProgress,
  type BoatDraftStartRowState,
} from "@t3tools/client-runtime/boat";
import { View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";

// Static glyphs: a machine takes seconds to minutes to start, and a spinner would repaint all along.
const STEP_ICONS: Record<
  BoatDraftStartRowState,
  { readonly name: AppSymbolName; readonly tint: string; readonly spoken: string }
> = {
  done: { name: "checkmark.circle.fill", tint: "accent-success-foreground", spoken: "done" },
  failed: { name: "xmark.circle.fill", tint: "accent-danger-foreground", spoken: "failed" },
  active: { name: "circle.inset.filled", tint: "accent-primary-text", spoken: "in progress" },
  pending: { name: "circle.dashed", tint: "accent-icon-muted", spoken: "waiting" },
};

/** The steps of a Boat draft's first send; a failure keeps them with its error and a way out. */
export function BoatStartPanel(props: {
  readonly progress: BoatDraftStartProgress;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}) {
  const failed = props.progress.failed;
  return (
    <View
      className={cn(
        "gap-2 rounded-2xl px-3.5 py-3",
        failed ? "border border-danger-border bg-danger" : "bg-grouped-card",
      )}
      accessibilityLiveRegion="polite"
    >
      <Text
        className={cn(
          "font-t3-medium text-sm",
          failed ? "text-danger-foreground" : "text-foreground",
        )}
        accessibilityRole="header"
      >
        {failed ? "Could not start on Boat" : "Starting on Boat"}
      </Text>
      {boatDraftStartRows(props.progress).map((row) => {
        const icon = STEP_ICONS[row.state];
        return (
          <View
            key={row.step}
            className="flex-row items-center gap-2.5"
            accessible
            accessibilityLabel={`${row.label}, ${icon.spoken}${row.detail ? `, ${row.detail}` : ""}`}
          >
            <SymbolView name={icon.name} size={18} tintColorClassName={icon.tint} />
            <View className="min-w-0 flex-1">
              <Text
                className={cn(
                  "text-sm",
                  row.state === "pending" ? "text-foreground-muted" : "text-foreground",
                )}
                numberOfLines={1}
              >
                {row.label}
              </Text>
              {row.detail ? (
                <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                  {row.detail}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
      {failed ? (
        <>
          {props.error ? (
            <Text className="text-xs text-danger-foreground" numberOfLines={4}>
              {props.error}
            </Text>
          ) : null}
          <View className="flex-row justify-end gap-2">
            <Button label="Dismiss" size="compact" onPress={props.onDismiss} />
            <Button label="Retry" size="compact" tone="primary" onPress={props.onRetry} />
          </View>
        </>
      ) : null}
    </View>
  );
}
