import { ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { machineStartRows } from "../../lib/machineStartSteps";
import { render } from "../../../test/render";
import { BoatMachineStartSteps } from "./BoatMachineStartSteps";
import { WorktreeSetupCard } from "./WorktreeSetupCard";

const rowsIn = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-worktree-setup-stage]")).map((row) => ({
    id: row.getAttribute("data-worktree-setup-stage"),
    status: row.getAttribute("data-worktree-setup-status"),
  }));

const stage = (
  id: WorktreeSetupSnapshot["stages"][number]["id"],
  status: WorktreeSetupSnapshot["stages"][number]["status"],
  percent: number | null = null,
): WorktreeSetupSnapshot["stages"][number] => ({
  id,
  status,
  startedAt: null,
  endedAt: null,
  percent,
  detail: null,
  tail: [],
});

describe("setup step rows", () => {
  it("keeps the worktree setup rows as they were", async () => {
    await using screen = await render(
      <WorktreeSetupCard
        snapshot={{
          threadId: ThreadId.make("thread-1"),
          phase: "running",
          startedAt: "2026-10-26T00:00:00.000Z",
          endedAt: null,
          branch: null,
          baseRef: null,
          worktreePath: null,
          setupScript: null,
          stages: [
            stage("fetch", "done"),
            stage("checkout", "running", 40),
            stage("setup-script", "pending"),
          ],
          error: null,
          sequence: 1,
        }}
        onCancel={null}
        onWorkLocally={null}
        onOpenTerminal={null}
      />,
      { router: false },
    );

    expect(rowsIn(screen.container)).toEqual([
      { id: "fetch", status: "done" },
      { id: "checkout", status: "running" },
      { id: "setup-script", status: "pending" },
    ]);
    for (const text of ["Fetch base branch", "Check out files", "40%", "Run setup script"]) {
      expect(screen.container.textContent).toContain(text);
    }
  });

  it("shows a machine start in the same rows, ending on the step that failed", async () => {
    await using screen = await render(
      <BoatMachineStartSteps
        rows={machineStartRows({
          steps: ["starting", "installing", "signing-in"],
          phase: "machine",
          failed: true,
          clone: null,
        })}
      />,
      { router: false },
    );

    expect(rowsIn(screen.container)).toEqual([
      { id: "starting", status: "done" },
      { id: "installing", status: "done" },
      { id: "signing-in", status: "failed" },
      { id: "clone", status: "pending" },
    ]);
    expect(screen.container.textContent).toContain("Signing in to GitHub");
  });
});
