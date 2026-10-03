import type { MemoryObservation } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { memoryActivity } from "./memoryModel";

const DAYS = 30;
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const formatDay = (day: string) => dayFormat.format(new Date(`${day}T00:00:00Z`));

/** How many memories agents saved each day over the 30 days up to `now`, when they were read. */
export function MemoryActivity(props: {
  readonly observations: ReadonlyArray<MemoryObservation>;
  readonly now: number;
}) {
  const days = useMemo(
    () => memoryActivity(props.observations, DAYS, props.now),
    [props.observations, props.now],
  );
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((day) => day.count));
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const focus = hovered === null ? null : days[hovered];

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Saved per day</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {focus
            ? `${formatDay(focus.day)} · ${focus.count} ${focus.count === 1 ? "memory" : "memories"}`
            : `${total.toLocaleString()} in the last ${DAYS} days`}
        </span>
      </div>
      <div
        className="flex h-28 items-end gap-0.5 border-b"
        role="img"
        aria-label={`Memories saved per day, last ${DAYS} days: ${total} in total, at most ${max} in a day`}
        onPointerLeave={() => setHovered(null)}
      >
        {days.map((day, index) => (
          // The whole column is the hover target, so empty days can be read too.
          <div
            key={day.day}
            className="flex h-full min-w-0 flex-1 items-end"
            onPointerEnter={() => setHovered(index)}
          >
            <div
              className={`w-full rounded-t-xs ${hovered === index ? "bg-foreground" : "bg-muted-foreground/60"}`}
              style={{ height: day.count === 0 ? 0 : `max(2px, ${(day.count / max) * 100}%)` }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-3xs text-muted-foreground uppercase">
        <span>{days[0] ? formatDay(days[0].day) : ""}</span>
        <span>Today</span>
      </div>
    </section>
  );
}
