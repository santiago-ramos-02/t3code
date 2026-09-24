import { gentleRose } from "@t3tools/client-runtime/gentleRose";
import { Path, Svg } from "react-native-svg";

export function GentleRoseIcon({ color }: { readonly color: string }) {
  return (
    <Svg width={20} height={20} viewBox={gentleRose.viewBox} fill={color}>
      <Path d={gentleRose.path} />
    </Svg>
  );
}
