import { gentleRose } from "@t3tools/client-runtime/gentleRose";
import type { SVGProps } from "react";

export function GentleRoseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox={gentleRose.viewBox}
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      {...props}
    >
      <path d={gentleRose.path} />
    </svg>
  );
}
