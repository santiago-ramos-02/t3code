import { ProjectId, type ProjectCloneSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { machineStartRows } from "./machineStartSteps";

const clone = (overrides: Partial<ProjectCloneSnapshot>): ProjectCloneSnapshot => ({
  projectId: ProjectId.make("project-1"),
  remoteUrl: "https://github.com/acme/app.git",
  destinationPath: "/home/user/app",
  repository: null,
  phase: "running",
  stage: "receiving",
  percent: 42,
  detail: null,
  error: null,
  startedAt: "2026-10-26T00:00:00.000Z",
  endedAt: null,
  sequence: 1,
  ...overrides,
});

const summarize = (rows: ReturnType<typeof machineStartRows>) =>
  rows.map((row) => `${row.id}:${row.status}`);

describe("machineStartRows", () => {
  it("shows the step the host is on as running, with the clone still waiting", () => {
    const rows = machineStartRows({
      steps: ["starting", "installing"],
      phase: "machine",
      failed: false,
      clone: null,
    });
    expect(summarize(rows)).toEqual(["starting:done", "installing:running", "clone:pending"]);
    expect(rows.map((row) => row.label)).toEqual([
      "Starting machine",
      "Installing T3 Code",
      "Clone repository",
    ]);
  });

  it("marks the step a failure stopped on, and nothing after it", () => {
    const rows = machineStartRows({
      steps: ["starting", "signing-in"],
      phase: "machine",
      failed: true,
      clone: null,
    });
    expect(summarize(rows)).toEqual(["starting:done", "signing-in:failed", "clone:pending"]);
  });

  it("follows the machine steps with the clone's progress", () => {
    const rows = machineStartRows({
      steps: ["starting", "signing-in", "connecting"],
      phase: "clone",
      failed: false,
      clone: clone({}),
    });
    expect(summarize(rows)).toEqual([
      "starting:done",
      "signing-in:done",
      "connecting:done",
      "clone:running",
    ]);
    expect(rows.at(-1)?.detail).toBe("Receiving objects · 42%");
  });

  it("starts the clone row running before the machine reports a clone, and fails it on error", () => {
    const base = { steps: [], phase: "clone", clone: null } as const;
    expect(summarize(machineStartRows({ ...base, failed: false }))).toEqual(["clone:running"]);
    expect(summarize(machineStartRows({ ...base, failed: true }))).toEqual(["clone:failed"]);
  });

  it("reports a finished, failed, or cancelled clone", () => {
    const rowFor = (overrides: Partial<ProjectCloneSnapshot>) =>
      machineStartRows({
        steps: [],
        phase: "clone",
        failed: false,
        clone: clone(overrides),
      }).at(-1);
    expect(rowFor({ phase: "done" })?.status).toBe("done");
    expect(rowFor({ phase: "failed", error: "boom" })?.status).toBe("failed");
    expect(rowFor({ phase: "cancelled" })).toMatchObject({ status: "failed", detail: "Cancelled" });
  });
});
