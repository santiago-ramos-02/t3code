import {
  BoatMachineReport,
  type BoatMachine,
  type BoatMachineCheckouts,
  type WorktreeCleanupRules,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Reads what a machine's own T3 Code server knows from its database and checkouts. The host holds
 * no credential for that server, so it asks through Boat's command API instead. The `node` T3 Code
 * runs on has `node:sqlite`, and the database is opened read-only. With REPORT=checkouts it also
 * inspects every checkout the server knows, including those of deleted threads, since the
 * machine's disk goes with it.
 */
const REPORT_SCRIPT = String.raw`
const { DatabaseSync } = require("node:sqlite");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const home = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
const db = new DatabaseSync(path.join(home, "userdata", "statev2.sqlite"), { readOnly: true });
const activeTurns = db
  .prepare("SELECT count(*) AS n FROM orchestration_v2_projection_runs WHERE status IN ('preparing', 'starting', 'running', 'waiting')")
  .get().n;
const threads = db
  .prepare("SELECT updated_at AS updatedAt, deleted_at AS deletedAt, payload_json AS payload FROM orchestration_v2_projection_threads")
  .all();
const live = threads.filter((thread) => thread.deletedAt === null);
let lastActivityAt = null;
let settledAt = null;
let allSettled = live.length > 0;
let merged = live.length > 0;
const roots = new Set();
for (const thread of threads) {
  const payload = JSON.parse(thread.payload);
  if (payload.worktreePath) roots.add(payload.worktreePath);
  if (thread.deletedAt !== null) continue;
  if (lastActivityAt === null || thread.updatedAt > lastActivityAt) lastActivityAt = thread.updatedAt;
  if (!payload.settledAt) allSettled = false;
  else if (settledAt === null || payload.settledAt > settledAt) settledAt = payload.settledAt;
  if (!(payload.pullRequests || []).some((pr) => pr.snapshot && pr.snapshot.state === "merged")) merged = false;
}
let checkouts = null;
if (process.env.REPORT === "checkouts") {
  for (const row of db.prepare("SELECT workspace_root AS root FROM projection_projects").all()) roots.add(row.root);
  // Deleting a machine loses its whole disk, so repos an agent cloned anywhere count too.
  const SKIP = new Set([".git", "node_modules", ".cache", ".npm", ".bun", ".nvm", ".cargo", ".rustup"]);
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === ".git")) roots.add(dir);
    if (depth === 0) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP.has(entry.name)) walk(path.join(dir, entry.name), depth - 1);
    }
  };
  for (const root of [os.homedir(), ...roots]) walk(root, 6);
  let inspected = 0;
  checkouts = { integrated: true, unpushed: false, trackedChanges: false, untrackedFiles: false, ignoredFiles: false };
  const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 24 });
  for (const cwd of roots) {
    if (!fs.existsSync(path.join(cwd, ".git"))) continue;
    inspected++;
    const status = git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status.status !== 0) throw new Error("git status failed in " + cwd);
    for (const line of status.stdout.split("\n").filter(Boolean)) {
      if (line.startsWith("??")) checkouts.untrackedFiles = true;
      else checkouts.trackedChanges = true;
    }
    const ignored = git(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]);
    if (ignored.status !== 0) throw new Error("git ls-files failed in " + cwd);
    if (ignored.stdout.split("\n").some((entry) => entry && !/(^|\/)node_modules\/$/.test(entry))) {
      checkouts.ignoredFiles = true;
    }
    // A checkout with no commits, or no remote, counts as unpushed.
    if (git(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"]).stdout.trim() !== "0") {
      checkouts.unpushed = true;
    }
    if (git(cwd, ["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/HEAD"]).status !== 0) {
      checkouts.integrated = false;
    }
  }
  // With no checkout left there is nothing on the default branch to compare.
  if (inspected === 0) checkouts.integrated = false;
}
console.log(JSON.stringify({
  activeTurns,
  threads: live.length,
  deletedThreads: threads.length - live.length,
  lastActivityAt,
  settledAt: allSettled ? settledAt : null,
  merged,
  checkouts,
}));
`;

// Base64 keeps the script clear of the shell's quoting.
const encodedScript = Buffer.from(REPORT_SCRIPT).toString("base64");

/** The shell command that prints a machine's report as one line of JSON. */
export const reportCommand = (withCheckouts: boolean) =>
  `sh -lc 'echo ${encodedScript} | base64 -d | REPORT=${withCheckouts ? "checkouts" : "activity"} node'`;

const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(BoatMachineReport));

/** The report in a command's output, whose last line it is after any login-shell noise. */
export const parseReport = (result: {
  readonly exitCode: number | null;
  readonly stdout: string;
}) =>
  result.exitCode === 0
    ? decodeReport(result.stdout.trim().split("\n").at(-1) ?? "")
    : Option.none<BoatMachineReport>();

const DAY_MS = 24 * 60 * 60 * 1000;
// A machine is set up (clone, copied files) before its first thread, which runs no turn.
export const BOAT_SETUP_GRACE_MS = 30 * 60 * 1000;
// Boat keeps a stopped disk for free for 14 days, then deletes it.
export const BOAT_FREE_STOPPED_DAYS = 14;
// A day before Boat deletes a stopped disk, T3 Code saves it as a named snapshot.
export const BOAT_SNAPSHOT_AFTER_MS = (BOAT_FREE_STOPPED_DAYS - 1) * DAY_MS;
// How far ahead T3 Code warns that a machine's saved history will be freed.
export const BOAT_SNAPSHOT_WARNING_MS = 3 * DAY_MS;
export const BOAT_SNAPSHOT_PREFIX = "t3-boat-";

/** The worktree cleanup rule that deletes this machine now, if any, before keep-when applies. */
export const boatCleanupRule = (
  report: BoatMachineReport,
  rules: WorktreeCleanupRules,
  now: number,
): string | null => {
  if (report.activeTurns > 0) return null;
  if (report.threads === 0) {
    return report.deletedThreads > 0 && rules.worktreeOnDelete ? "its threads were deleted" : null;
  }
  const age = (iso: string | null) => (iso === null ? null : now - Date.parse(iso));
  const inactive = age(report.lastActivityAt);
  if (rules.worktreeAfterDays !== null && inactive !== null) {
    if (inactive >= rules.worktreeAfterDays * DAY_MS) {
      return `it was inactive for ${Math.floor(inactive / DAY_MS)} days`;
    }
  }
  const settled = age(report.settledAt);
  if (rules.worktreeSettledAfterDays !== null && settled !== null) {
    if (settled >= rules.worktreeSettledAfterDays * DAY_MS) {
      return `its threads were settled for ${Math.floor(settled / DAY_MS)} days`;
    }
  }
  if (rules.worktreeOnMerge && report.merged) return "its pull requests were merged";
  if (rules.worktreeUnchanged && report.checkouts?.integrated === true) {
    return "it has no commits beyond the default branch";
  }
  return null;
};

/**
 * Why cleanup keeps the machine despite a rule. Deleting a machine loses its disk, unlike removing
 * a worktree, which keeps its branch, so unpushed commits always keep it.
 */
export const boatKeepReason = (
  checkouts: BoatMachineCheckouts | null,
  rules: WorktreeCleanupRules,
): string | null => {
  if (checkouts === null) return "T3 Code could not check its checkouts";
  if (checkouts.unpushed) return "it has commits that were not pushed";
  if (checkouts.trackedChanges) return "it has uncommitted changes";
  if (rules.worktreeKeepWhen === "tracked-changes") return null;
  if (checkouts.untrackedFiles) return "it has untracked files";
  if (rules.worktreeKeepWhen === "uncommitted-changes") return null;
  return checkouts.ignoredFiles ? "it has ignored files" : null;
};

/** The named snapshot that keeps a machine's disk; Boat allows lowercase letters, digits, dashes. */
export const boatSnapshotName = (sandboxId: string) =>
  `${BOAT_SNAPSHOT_PREFIX}${sandboxId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 63);

export type NamedSnapshotSummary = { readonly name: string; readonly createdAt: string };

/**
 * What to do for stopped machines whose free disk is running out: save the due ones while the
 * free named snapshots last, freeing T3 Code's oldest snapshot when they are full, and warn the
 * machines whose snapshot will be freed for those coming due soon. The user's own snapshots are
 * never freed.
 */
export const planBoatSnapshots = (input: {
  readonly machines: ReadonlyArray<BoatMachine>;
  readonly snapshots: ReadonlyArray<NamedSnapshotSummary>;
  readonly free: number;
  readonly now: number;
}) => {
  const stoppedFor = (machine: BoatMachine) =>
    machine.stoppedAt === null ? 0 : input.now - Date.parse(machine.stoppedAt);
  const waiting = input.machines
    .filter((machine) => machine.state === "stopped" && machine.snapshot === null)
    .toSorted((a, b) => stoppedFor(b) - stoppedFor(a));
  const due = waiting.filter((machine) => stoppedFor(machine) >= BOAT_SNAPSHOT_AFTER_MS);
  const soon = waiting.filter(
    (machine) =>
      stoppedFor(machine) < BOAT_SNAPSHOT_AFTER_MS &&
      stoppedFor(machine) >= BOAT_SNAPSHOT_AFTER_MS - BOAT_SNAPSHOT_WARNING_MS,
  );
  // T3 Code's own snapshots, oldest first, as the machines they keep.
  const freeable = input.snapshots
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .flatMap((snapshot) => {
      const owner = input.machines.find((machine) => machine.snapshot === snapshot.name);
      return owner === undefined ? [] : [owner];
    });
  let used = input.snapshots.length;
  const save: BoatMachine[] = [];
  const free: BoatMachine[] = [];
  const full: BoatMachine[] = [];
  for (const machine of due) {
    if (used < input.free) {
      used++;
      save.push(machine);
      continue;
    }
    const oldest = freeable.shift();
    if (oldest === undefined) {
      full.push(machine);
      continue;
    }
    free.push(oldest);
    save.push(machine);
  }
  const warn = freeable.slice(0, Math.max(0, used + soon.length - input.free));
  return { save, free, full, warn };
};
