import { boatDraftStartRows } from "@t3tools/client-runtime/boat";
import {
  type BoatMachine,
  type BoatStatus,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceBoatDraft,
  boatDraftStillCurrent,
  failBoatDraft,
  machineStepsFor,
  planBoatDraftSend,
  startingBoatDraft,
  withMachineSteps,
} from "./boatDraftStart.logic";

const rowStates = (start: ReturnType<typeof startingBoatDraft>) =>
  Object.fromEntries(boatDraftStartRows(start).map((row) => [row.step, row.state]));

// Only `configured` is read by the pre-send checks.
const configured = { configured: true } as BoatStatus;
const draft = {
  environmentId: EnvironmentId.make("host"),
  projectId: ProjectId.make("project"),
  environmentSelection: "boat",
  promotedTo: null,
  branch: "main",
} as const;
const promoted = {
  environmentId: EnvironmentId.make("host"),
  threadId: ThreadId.make("thread"),
};

describe("Boat draft start progress", () => {
  it("follows the host's machine steps, then the client's own", () => {
    let start = startingBoatDraft("acme/app");
    expect(rowStates(start)).toMatchObject({ machine: "active", thread: "pending" });

    start = withMachineSteps(start, ["starting", "installing"]);
    expect(boatDraftStartRows(start)[0]?.detail).toBe("Installing T3 Code");

    start = withMachineSteps(start, ["starting", "installing", "cloning"]);
    expect(rowStates(start)).toMatchObject({ machine: "done", repository: "active" });
    expect(boatDraftStartRows(start)[1]?.detail).toBe("acme/app");

    start = advanceBoatDraft(start, "connect");
    expect(rowStates(start)).toMatchObject({ repository: "done", connect: "active" });
    // Steps never move back, and the host's steps stop counting once the client has moved on.
    expect(advanceBoatDraft(start, "machine")).toBe(start);
    expect(withMachineSteps(start, ["starting"])).toBe(start);
  });

  it("ignores a repeat of the same steps and a host report with none", () => {
    const start = withMachineSteps(startingBoatDraft(null), ["starting"]);
    expect(withMachineSteps(start, ["starting"])).toBe(start);
    expect(machineStepsFor([{ startId: "a", startSteps: [] }], "a")).toBeNull();
  });

  it("finds the steps of the machine that carries the start id, running or not", () => {
    const machines: Array<Pick<BoatMachine, "startId" | "startSteps">> = [
      { startId: "other", startSteps: ["starting"] },
      { startId: "mine", startSteps: ["cloning"] },
    ];
    expect(machineStepsFor(machines, "mine")).toEqual(["cloning"]);
    expect(machineStepsFor(machines, "missing")).toBeNull();
  });

  it("fails the step the start was on and keeps the error", () => {
    const failed = failBoatDraft(advanceBoatDraft(startingBoatDraft(null), "connect"), "No route.");
    expect(failed.error).toBe("No route.");
    expect(rowStates(failed)).toMatchObject({ machine: "done", connect: "failed" });
    expect(advanceBoatDraft(failed, "project")).toBe(failed);
  });
});

describe("Boat draft send plan", () => {
  const plan = (overrides: Partial<Parameters<typeof planBoatDraftSend>[0]> = {}) =>
    planBoatDraftSend({
      draft,
      onBoatMachine: false,
      status: configured,
      remoteUrl: "git@github.com:acme/app.git",
      ...overrides,
    });

  it("starts with the remote and the base branch", () => {
    expect(plan()).toEqual({
      kind: "start",
      remoteUrl: "git@github.com:acme/app.git",
      branch: "main",
    });
  });

  it("stops before anything starts, with the toast text", () => {
    expect(plan({ status: null })).toEqual({
      kind: "blocked",
      blocker: {
        title: "Boat is not set up",
        description: "Connect Boat in Settings, Connections.",
      },
    });
    expect(plan({ remoteUrl: null })).toMatchObject({
      blocker: { title: "Boat needs a git remote" },
    });
    expect(plan({ draft: { ...draft, branch: null } })).toMatchObject({
      blocker: {
        title: "Choose a base branch",
        description: "Boat starts a new worktree from it.",
      },
    });
  });

  it("drops a draft that is gone, sent, or off Boat, and sends one already on its machine", () => {
    expect(plan({ draft: null })).toEqual({ kind: "drop" });
    expect(plan({ draft: { ...draft, promotedTo: promoted } })).toEqual({ kind: "drop" });
    expect(plan({ draft: { ...draft, environmentSelection: "manual" } })).toEqual({
      kind: "drop",
    });
    expect(plan({ onBoatMachine: true, status: null })).toEqual({ kind: "send" });
  });
});

describe("Boat draft retarget guard", () => {
  it("accepts the same unsent Boat draft", () => {
    expect(boatDraftStillCurrent(draft, { ...draft })).toBe(true);
  });

  it.each([
    ["gone", null],
    ["sent", { ...draft, promotedTo: promoted }],
    ["taken off Boat", { ...draft, environmentSelection: "manual" as const }],
    ["on another machine", { ...draft, environmentId: EnvironmentId.make("other") }],
    ["on another project", { ...draft, projectId: ProjectId.make("other") }],
  ])("drops a draft that is %s", (_name, current) => {
    expect(boatDraftStillCurrent(draft, current)).toBe(false);
  });
});
