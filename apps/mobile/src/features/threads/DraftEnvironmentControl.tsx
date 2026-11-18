import { T, useGT, Var } from "gt-react-native";
import { Pressable } from "react-native";
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { BoatIcon } from "../../components/BoatIcon";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";

export function DraftEnvironmentControl(props: {
  readonly label: string;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly machineKind: EnvironmentMachineKind;
  /** The draft runs on a Boat machine, chosen at send; the environment it sits on is not shown. */
  readonly boat: boolean;
  readonly disabled: boolean;
  readonly onChooseEnvironment: () => void;
}) {
  const gt = useGT();
  const disconnected = !props.boat && props.connectionState !== "connected";
  const label = props.boat ? "Boat" : props.label;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        props.boat
          ? gt("Choose environment, Boat")
          : disconnected
            ? gt("Choose environment, {label}, Offline", { label })
            : gt("Choose environment, {label}, Connected", { label })
      }
      disabled={props.disabled}
      onPress={props.onChooseEnvironment}
      className="flex-row items-center gap-1.5 rounded-xl px-3 py-2 active:opacity-65"
    >
      {props.boat ? (
        <BoatIcon size={13} colorClassName="accent-icon-muted" />
      ) : (
        <EnvironmentMachineSymbol
          kind={props.machineKind}
          size={13}
          tintColorClassName="accent-icon-muted"
        />
      )}
      <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
        <T>
          on <Var>{label}</Var>
        </T>
      </Text>
      <SymbolView name="chevron.right" size={11} tintColorClassName="accent-icon-muted" />
      {disconnected ? <ConnectionStatusDot state="error" pulse={false} size={6} /> : null}
    </Pressable>
  );
}
