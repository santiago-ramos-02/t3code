import type { MemoryObservation, MemoryProject, MemoryRelation } from "@t3tools/contracts";

/**
 * The groups the brain map colors memories by. Engram has more types than a reader can tell
 * apart by color, so they fold into three that answer "what kind of thing did the agent keep".
 */
export type MemoryGroup = "decisions" | "findings" | "sessions" | "other";

const GROUP_BY_TYPE: Record<string, MemoryGroup> = {
  decision: "decisions",
  architecture: "decisions",
  pattern: "decisions",
  preference: "decisions",
  config: "decisions",
  bugfix: "findings",
  discovery: "findings",
  learning: "findings",
  passive: "findings",
  session_summary: "sessions",
};

export const memoryGroup = (type: string): MemoryGroup => GROUP_BY_TYPE[type] ?? "other";

export const MEMORY_GROUP_LABELS: Record<MemoryGroup, string> = {
  decisions: "Decisions",
  findings: "Findings",
  sessions: "Session summaries",
  other: "Other",
};

/**
 * Engram writes UTC as `YYYY-MM-DD HH:MM:SS`, sessions with nanoseconds after it, which `Date`
 * would read as local time.
 */
export const parseMemoryTime = (value: string) => {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(value);
  return Date.parse(match ? `${match[1]}T${match[2]}${match[3]?.slice(0, 4) ?? ""}Z` : value);
};

/** An Engram time as ISO, for the shared timestamp formatters; empty when unreadable. */
export const memoryIsoTime = (value: string) => {
  const time = parseMemoryTime(value);
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
};

/** How a relation reads from the memory on each side of it. */
export function memoryRelationLabel(kind: string, from: "source" | "target") {
  switch (kind) {
    case "supersedes":
      return from === "source" ? "Replaces" : "Replaced by";
    case "conflicts_with":
      return "Contradicts";
    case "compatible":
      return "Compatible with";
    case "scoped":
      return "Applies elsewhere than";
    case "pending":
      return "May conflict with";
    default:
      return "Related to";
  }
}

/**
 * A relation waiting for a verdict. Engram keeps `relation: "pending"` on pairs it later marks
 * `orphaned` when one memory is deleted; those have nothing left to judge.
 */
export const isPendingRelation = (relation: MemoryRelation) =>
  relation.judgmentStatus === "pending";

export interface MemoryGraphNode {
  readonly id: string;
  readonly observation: MemoryObservation;
  readonly group: MemoryGroup;
  // A newer memory replaced it.
  readonly superseded: boolean;
  // It contradicts another memory, or may, and is waiting for a verdict.
  readonly conflicted: boolean;
}

export interface MemoryGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: string;
  readonly pending: boolean;
}

/** Joins two memories saved one after the other in the same session. */
export interface MemoryGraphThread {
  readonly source: string;
  readonly target: string;
}

/**
 * The brain map's nodes and links, for the newest `limit` memories. Relations whose memories were
 * deleted, or that are outside the chosen project, are dropped; a `not_conflict` verdict says the
 * two are unrelated, so it draws no link. Threads chain each session's memories in the order they
 * were saved, so a session reads as one cluster.
 */
export function buildMemoryGraph(
  observations: ReadonlyArray<MemoryObservation>,
  relations: ReadonlyArray<MemoryRelation>,
  project: string | null,
  limit = Number.POSITIVE_INFINITY,
) {
  const inProject = observations
    .filter((entry) => project === null || entry.project === project)
    .toSorted((a, b) => parseMemoryTime(b.createdAt) - parseMemoryTime(a.createdAt));
  const shown = inProject.slice(0, limit);
  const ids = new Set(shown.map((entry) => entry.syncId));
  const edges: Array<MemoryGraphEdge> = [];
  const superseded = new Set<string>();
  const conflicted = new Set<string>();
  for (const relation of relations) {
    if (relation.relation === "not_conflict") continue;
    if (!ids.has(relation.sourceId) || !ids.has(relation.targetId)) continue;
    const pending = isPendingRelation(relation);
    edges.push({
      id: relation.syncId,
      source: relation.sourceId,
      target: relation.targetId,
      kind: relation.relation,
      pending,
    });
    if (relation.relation === "supersedes") superseded.add(relation.targetId);
    if (pending || relation.relation === "conflicts_with") {
      conflicted.add(relation.sourceId);
      conflicted.add(relation.targetId);
    }
  }
  const nodes: Array<MemoryGraphNode> = shown.map((observation) => ({
    id: observation.syncId,
    observation,
    group: memoryGroup(observation.type),
    superseded: superseded.has(observation.syncId),
    conflicted: conflicted.has(observation.syncId),
  }));
  const threads: Array<MemoryGraphThread> = [];
  const lastInSession = new Map<string, string>();
  for (const observation of shown.toReversed()) {
    const previous = lastInSession.get(observation.sessionId);
    if (previous !== undefined) threads.push({ source: previous, target: observation.syncId });
    lastInSession.set(observation.sessionId, observation.syncId);
  }
  return { nodes, edges, threads, hidden: inProject.length - shown.length };
}

export type MemoryGraph = ReturnType<typeof buildMemoryGraph>;

/** The relations that touch a project's memories; every relation when no project is picked. */
export function relationsInProject(
  observations: ReadonlyArray<MemoryObservation>,
  relations: ReadonlyArray<MemoryRelation>,
  project: string | null,
) {
  if (project === null) return relations;
  const ids = new Set(
    observations.filter((entry) => entry.project === project).map((entry) => entry.syncId),
  );
  return relations.filter((relation) => ids.has(relation.sourceId) || ids.has(relation.targetId));
}

/** Relations waiting for a person's verdict, newest first. */
export const pendingConflicts = (relations: ReadonlyArray<MemoryRelation>) =>
  relations
    .filter(isPendingRelation)
    .toSorted((a, b) => parseMemoryTime(b.updatedAt) - parseMemoryTime(a.updatedAt));

const DAY_MS = 86_400_000;
const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Memories saved per UTC day over the last `days` days, oldest first, including empty days. */
export function memoryActivity(
  observations: ReadonlyArray<MemoryObservation>,
  days: number,
  now: number,
) {
  const counts = new Map<string, number>();
  for (let offset = days - 1; offset >= 0; offset -= 1)
    counts.set(utcDay(now - offset * DAY_MS), 0);
  for (const observation of observations) {
    const day = utcDay(parseMemoryTime(observation.createdAt));
    const count = counts.get(day);
    if (count !== undefined) counts.set(day, count + 1);
  }
  return Array.from(counts, ([day, count]) => ({ day, count }));
}

/** Engram's canonical form of a project name: trimmed, lowercase, without doubled separators. */
const canonicalProjectName = (name: string) =>
  name.trim().toLowerCase().replace(/-{2,}/g, "-").replace(/_{2,}/g, "_");

/**
 * The names Engram would give a T3 project: its git remote's repository name, else the folder
 * name. Both are offered because Engram falls back to the folder when a clone has no remote.
 */
export function engramProjectNames(project: {
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: { readonly name?: string | undefined } | null | undefined;
}): ReadonlyArray<string> {
  const folder = project.workspaceRoot.split(/[\\/]/).findLast((part) => part !== "") ?? "";
  return [project.repositoryIdentity?.name ?? "", folder]
    .map(canonicalProjectName)
    .filter((name) => name !== "");
}

/**
 * Engram's projects in the order it lists them, each with the T3 project it belongs to when one
 * matches, so pickers can show T3's name and icon.
 */
export function memoryProjectChoices<
  P extends Parameters<typeof engramProjectNames>[0] & { readonly title: string },
>(engramProjects: ReadonlyArray<MemoryProject>, projects: ReadonlyArray<P>) {
  const byName = new Map<string, P>();
  for (const project of projects) {
    for (const name of engramProjectNames(project))
      if (!byName.has(name)) byName.set(name, project);
  }
  return engramProjects.map((entry) => ({
    name: entry.name,
    count: entry.observationCount,
    project: byName.get(canonicalProjectName(entry.name)) ?? null,
  }));
}
