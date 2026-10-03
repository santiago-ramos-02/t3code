import type { MemoryObservation } from "@t3tools/contracts";
import {
  BlocksIcon,
  BrainIcon,
  BugIcon,
  ClockIcon,
  CompassIcon,
  FolderIcon,
  GavelIcon,
  HistoryIcon,
  LightbulbIcon,
  type LucideIcon,
  ScrollTextIcon,
  ShapesIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  UserRoundIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { memoryIsoTime } from "./memoryModel";

/** How long ago an Engram time was, or the time itself when it cannot be read. */
export const memoryTimeLabel = (value: string) => {
  const iso = memoryIsoTime(value);
  return iso === "" ? value : formatRelativeTimeLabel(iso);
};

const ICON_BY_TYPE: Record<string, LucideIcon> = {
  decision: GavelIcon,
  architecture: BlocksIcon,
  pattern: ShapesIcon,
  preference: UserRoundIcon,
  config: SlidersHorizontalIcon,
  bugfix: BugIcon,
  discovery: CompassIcon,
  learning: LightbulbIcon,
  passive: SparklesIcon,
  session_summary: ScrollTextIcon,
};

const LABEL_BY_TYPE: Record<string, string> = {
  passive: "Passive capture",
  session_summary: "Session summary",
};

/** A memory's kind as people read it: `bugfix` is Bugfix, `session_summary` Session summary. */
export function memoryTypeLabel(type: string) {
  const words = type.replaceAll("_", " ");
  return LABEL_BY_TYPE[type] ?? words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The icon for a memory's kind, a brain for kinds Engram adds later or an agent left out. With
 * `label`, it names the kind to screen readers, for lists where nothing else says it.
 */
export function MemoryTypeIcon(props: {
  readonly type: string | undefined;
  readonly label?: boolean;
  readonly className?: string;
}) {
  const Icon = (props.type === undefined ? undefined : ICON_BY_TYPE[props.type]) ?? BrainIcon;
  return props.label && props.type !== undefined ? (
    <Icon role="img" aria-label={memoryTypeLabel(props.type)} className={props.className} />
  ) : (
    <Icon aria-hidden className={props.className} />
  );
}

/**
 * What kind of memory it is, where, and when, each fact behind its own icon. The caller sets the
 * text size.
 */
export function MemoryFacts(props: {
  readonly observation: MemoryObservation;
  readonly className?: string;
}) {
  const { observation } = props;
  const iso = memoryIsoTime(observation.createdAt);
  const edits = observation.revisionCount - 1;
  return (
    <ul
      className={cn(
        "m-0 flex list-none flex-wrap items-center gap-x-3 gap-y-1 p-0 text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0",
        props.className,
      )}
    >
      <li className="flex items-center gap-1">
        <MemoryTypeIcon type={observation.type} />
        {memoryTypeLabel(observation.type)}
      </li>
      {observation.project ? (
        <li className="flex min-w-0 items-center gap-1">
          <FolderIcon aria-hidden />
          <span className="sr-only">Project </span>
          <span className="truncate">{observation.project}</span>
        </li>
      ) : null}
      <li className="flex items-center gap-1">
        <ClockIcon aria-hidden />
        <span className="sr-only">Saved </span>
        <time dateTime={iso || undefined}>{memoryTimeLabel(observation.createdAt)}</time>
      </li>
      {edits > 0 ? (
        <li className="flex items-center gap-1">
          <HistoryIcon aria-hidden />
          Updated {edits} {edits === 1 ? "time" : "times"}
        </li>
      ) : null}
    </ul>
  );
}

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
