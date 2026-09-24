import { gentleRose } from "@t3tools/client-runtime/gentleRose";
import type { SVGProps } from "react";

export function GentleRoseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox={gentleRose.viewBox} fill="currentColor" aria-hidden="true" {...props}>
      <path d={gentleRose.path} />
    </svg>
  );
}
