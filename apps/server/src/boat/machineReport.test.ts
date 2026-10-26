import { assert, describe, it } from "@effect/vitest";
import type { BoatMachine, WorktreeCleanupRules } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { BOAT_SNAPSHOT_AFTER_MS, boatKeepReason, planBoatSnapshots } from "./machineReport.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-30T00:00:00.000Z");

const rules = (
  worktreeKeepWhen: WorktreeCleanupRules["worktreeKeepWhen"],
): WorktreeCleanupRules => ({
  worktreeKeepWhen,
  worktreeAfterDays: null,
  worktreeSettledAfterDays: null,
  worktreeOnMerge: false,
  worktreeOnDelete: true,
  worktreeUnchanged: false,
});

const stopped = (
  id: string,
  stoppedDaysAgo: number,
  snapshot: string | null = null,
): BoatMachine => ({
  sandboxId: id,
  size: "default",
  state: "stopped",
  httpBaseUrl: `https://${id}-3773.on.boat.dev`,
  createdAt: "2026-10-01T00:00:00.000Z",
  problem: null,
  projectId: null,
  stoppedAt: DateTime.formatIso(DateTime.makeUnsafe(NOW - stoppedDaysAgo * DAY_MS)),
  report: null,
  snapshot,
  notice: null,
  startSteps: [],
  startId: null,
});

describe("boatKeepReason", () => {
  const untracked = {
    integrated: false,
    unpushed: false,
    trackedChanges: false,
    untrackedFiles: true,
    ignoredFiles: false,
  };

  it("follows keep-when for untracked files", () => {
    assert.strictEqual(boatKeepReason(untracked, rules("tracked-changes")), null);
    assert.strictEqual(
      boatKeepReason(untracked, rules("uncommitted-changes")),
      "it has untracked files",
    );
  });

  it("always keeps unpushed commits and unread checkouts", () => {
    assert.strictEqual(
      boatKeepReason(
        { ...untracked, untrackedFiles: false, unpushed: true },
        rules("tracked-changes"),
      ),
      "it has commits that were not pushed",
    );
    assert.strictEqual(
      boatKeepReason(null, rules("tracked-changes")),
      "T3 Code could not check its checkouts",
    );
  });
});

describe("planBoatSnapshots", () => {
  it("frees T3 Code's oldest snapshot, never the user's, when the free ones are full", () => {
    const old = stopped("bx_old", 40, "t3-boat-bx-old");
    const due = stopped("bx_due", BOAT_SNAPSHOT_AFTER_MS / DAY_MS);
    const snapshots = [
      ...Array.from({ length: 9 }, (_, index) => ({
        name: `template-${index}`,
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
      { name: "t3-boat-bx-old", createdAt: "2026-10-30T00:00:00.000Z" },
    ];

    const plan = planBoatSnapshots({ machines: [old, due], snapshots, free: 10, now: NOW });

    assert.deepStrictEqual(
      { save: plan.save.map((m) => m.sandboxId), free: plan.free.map((m) => m.sandboxId) },
      { save: ["bx_due"], free: ["bx_old"] },
    );
    assert.deepStrictEqual(plan.full, []);
  });

  it("warns a machine whose snapshot is freed for one coming due within days", () => {
    const old = stopped("bx_old", 40, "t3-boat-bx-old");
    const soon = stopped("bx_soon", 11);
    const snapshots = Array.from({ length: 10 }, (_, index) =>
      index === 0
        ? { name: "t3-boat-bx-old", createdAt: "2026-10-30T00:00:00.000Z" }
        : { name: `template-${index}`, createdAt: "2026-01-01T00:00:00.000Z" },
    );

    const plan = planBoatSnapshots({ machines: [old, soon], snapshots, free: 10, now: NOW });

    assert.deepStrictEqual(plan.save, []);
    assert.deepStrictEqual(
      plan.warn.map((m) => m.sandboxId),
      ["bx_old"],
    );
  });
});
