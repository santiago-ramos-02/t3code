import type { MemoryObservation } from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { memoryIsoTime } from "./memoryModel";

/** How long ago an Engram time was, or the time itself when it cannot be read. */
export const memoryTimeLabel = (value: string) => {
  const iso = memoryIsoTime(value);
  return iso === "" ? value : formatRelativeTimeLabel(iso);
};

/** A memory's title that opens it. */
export function MemoryLink(props: {
  readonly observation: MemoryObservation;
  readonly onOpen: (id: number) => void;
}) {
  return (
    // Titles are long and wrap, which InlineButton does not.
    <button
      type="button"
      className="cursor-pointer text-start font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      onClick={() => props.onOpen(props.observation.id)}
    >
      {props.observation.title}
    </button>
  );
}
