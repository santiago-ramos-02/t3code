/**
 * Which Boat machine takes a new thread: one with room, preferably with the checkout already.
 *
 * @module boat/machinePick
 */
import * as Option from "effect/Option";

/** A machine counts as having room while it uses less than this share of its CPU and memory. */
const BOAT_USAGE_LIMIT = 0.5;

/** Prints load, cores, total memory and available memory (kB) on one line. */
export const usageCommand = `printf '%s %s %s %s\n' "$(cut -d' ' -f1 /proc/loadavg)" "$(nproc)" "$(awk '/^MemTotal:/{print $2}' /proc/meminfo)" "$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)"`;

/** The busier of CPU load per core and memory in use, from `usageCommand`'s output. */
export const parseUsage = (stdout: string) => {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  const [load, cores, total, available, ...rest] = line.trim().split(/\s+/).map(Number);
  if (
    rest.length > 0 ||
    load === undefined ||
    cores === undefined ||
    total === undefined ||
    available === undefined ||
    ![load, cores, total, available].every(Number.isFinite) ||
    cores <= 0 ||
    total <= 0
  ) {
    return Option.none<number>();
  }
  return Option.some(Math.max(load / cores, 1 - available / total));
};

export interface PickCandidate {
  readonly sandboxId: string;
  readonly state: "running" | "stopped";
  /** The machine has opened the repository before. */
  readonly hasCheckout: boolean;
  /** Null for a stopped machine, and for a running one whose usage could not be read. */
  readonly usage: number | null;
}

const hasRoom = (candidate: PickCandidate) =>
  candidate.state === "running" && candidate.usage !== null && candidate.usage < BOAT_USAGE_LIMIT;

/**
 * Running machine with room and the checkout, else a stopped one with it, else any machine with
 * room, else any stopped machine; none means a new machine. Among equals the least used wins, then
 * the first listed. A running machine whose usage is unknown counts as busy.
 */
export const pickMachine = (candidates: ReadonlyArray<PickCandidate>) => {
  const tiers = [
    candidates.filter((candidate) => hasRoom(candidate) && candidate.hasCheckout),
    candidates.filter((candidate) => candidate.state === "stopped" && candidate.hasCheckout),
    candidates.filter(hasRoom),
    candidates.filter((candidate) => candidate.state === "stopped"),
  ];
  for (const tier of tiers) {
    const [first] = tier.toSorted((a, b) => (a.usage ?? 0) - (b.usage ?? 0));
    if (first !== undefined) return first;
  }
  return undefined;
};
