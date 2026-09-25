import { gentleRose } from "@t3tools/client-runtime/gentleRose";
import { Path, Svg } from "react-native-svg";

/** Drawn a quarter larger than the icon slot `size` so the rose reads at the same weight as SF Symbols. */
export function GentleRoseIcon({ color, size }: { readonly color: string; readonly size: number }) {
  const drawn = Math.round(size * 1.25);
  return (
    <Svg width={drawn} height={drawn} viewBox={gentleRose.viewBox} fill={color}>
      <Path d={gentleRose.path} />
    </Svg>
  );
}
