import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";

/** A settings row that picks one of a few labelled values from a native menu. */
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
