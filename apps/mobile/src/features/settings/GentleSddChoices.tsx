import { GENTLE_SDD_LABELS } from "@t3tools/client-runtime/piGentleComposer";
import type { PiGentleSddPreferences } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";

export function ChoiceMenu<Value extends string>(props: {
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
          {selected?.label ?? (props.value || "None")}
        </Text>
      </Pressable>
    </ControlPillMenu>
  );
}

function labelChoices<Value extends string>(labels: Record<Value, string>) {
  return Object.keys(labels)
    .filter((value): value is Value => Object.hasOwn(labels, value))
    .map((value) => ({ value, label: labels[value] }));
}

/** The four SDD preflight choices; each change is reported as a patch. */
export function GentleSddChoices(props: {
  readonly value: PiGentleSddPreferences;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<PiGentleSddPreferences>) => void;
}) {
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null);
  const { value, disabled, onChange } = props;
  return (
    <>
      <ChoiceMenu
        label="Execution mode"
        value={value.executionMode}
        choices={labelChoices(GENTLE_SDD_LABELS.executionMode)}
        disabled={disabled}
        onChange={(executionMode) => onChange({ executionMode })}
      />
      <ChoiceMenu
        label="Artifact store"
        value={value.artifactStore}
        choices={labelChoices(GENTLE_SDD_LABELS.artifactStore)}
        disabled={disabled}
        onChange={(artifactStore) => onChange({ artifactStore })}
      />
      <ChoiceMenu
        label="Delivery strategy"
        value={value.chainedPrStrategy}
        choices={labelChoices(GENTLE_SDD_LABELS.chainedPrStrategy)}
        disabled={disabled}
        onChange={(chainedPrStrategy) => onChange({ chainedPrStrategy })}
      />
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 text-sm text-foreground-muted">Review budget (lines)</Text>
        <AppTextInput
          accessibilityLabel="Review budget in lines"
          keyboardType="number-pad"
          value={budgetDraft ?? String(value.reviewBudgetLines)}
          editable={!disabled}
          onChangeText={setBudgetDraft}
          onEndEditing={() => {
            const lines = Number(budgetDraft);
            setBudgetDraft(null);
            if (Number.isInteger(lines) && lines > 0 && lines !== value.reviewBudgetLines) {
              onChange({ reviewBudgetLines: lines });
            }
          }}
          className="min-h-11 w-24 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
        />
      </View>
    </>
  );
}
