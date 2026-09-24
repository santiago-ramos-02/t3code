import { gentleRose } from "@t3tools/client-runtime/gentleRose";
import { Path, Svg } from "react-native-svg";

export function GentleRoseIcon({ color }: { readonly color: string }) {
  return (
    <Svg
      width={18}
      height={20}
      viewBox={gentleRose.viewBox}
      preserveAspectRatio="none"
      fill={color}
      stroke={color}
      strokeWidth={2}
    >
      <Path d={gentleRose.path} />
    </Svg>
  );
}
