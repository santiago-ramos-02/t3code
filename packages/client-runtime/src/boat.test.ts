import { DEFAULT_BOAT_SETTINGS, ProviderDriverKind, type BoatStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boatDraftBlocker, boatDraftStartRows, boatReadyProviders } from "./boat.ts";

const status = (overrides: Partial<BoatStatus> = {}): BoatStatus => ({
  configured: true,
  cli: null,
  settings: DEFAULT_BOAT_SETTINGS,
  machines: [],
  deleted: [],
  templateBuild: null,
  ...overrides,
});

const machine = (providers: ReadonlyArray<string> | null): BoatStatus["machines"][number] => ({
  sandboxId: "sb-1",
  size: "default",
  state: "running",
  httpBaseUrl: null,
  createdAt: "2026-11-15T00:00:00.000Z",
  problem: null,
  projectId: null,
  stoppedAt: null,
  report:
    providers === null
      ? null
      : {
          activeTurns: 0,
          threads: 0,
          deletedThreads: 0,
          lastActivityAt: null,
          settledAt: null,
          merged: false,
          checkouts: null,
          providers: providers.map((kind) => ProviderDriverKind.make(kind)),
        },
  snapshot: null,
  notice: null,
  startSteps: [],
  startId: null,
});

describe("boatDraftStartRows", () => {
  it("names the host's machine step and moves to the repository once it clones", () => {
    const starting = boatDraftStartRows({
      step: "machine",
      failed: false,
      machineSteps: ["starting", "installing"],
      repository: "t3code",
    });
    expect(starting.map((row) => [row.step, row.state, row.detail])).toEqual([
      ["machine", "active", "Installing T3 Code"],
      ["repository", "pending", "t3code"],
      ["connect", "pending", null],
      ["project", "pending", null],
      ["thread", "pending", null],
    ]);

    const cloning = boatDraftStartRows({
      step: "machine",
      failed: false,
      machineSteps: ["starting", "cloning"],
      repository: "t3code",
    });
    expect(cloning.map((row) => [row.step, row.state, row.detail])).toEqual([
      ["machine", "done", null],
      ["repository", "active", "t3code"],
      ["connect", "pending", null],
      ["project", "pending", null],
      ["thread", "pending", null],
    ]);
  });

  it("marks only the current step failed", () => {
    const rows = boatDraftStartRows({
      step: "connect",
      failed: true,
      machineSteps: ["cloning"],
      repository: null,
    });
    expect(rows.map((row) => row.state)).toEqual(["done", "done", "failed", "pending", "pending"]);
  });
});

describe("boatDraftBlocker", () => {
  it("checks set up, then the remote, then the base branch", () => {
    expect(
      boatDraftBlocker({ status: status({ configured: false }), remoteUrl: "x", baseBranch: "m" }),
    ).toEqual({
      title: "Boat is not set up",
      description: "Connect Boat in Settings, Connections.",
    });
    expect(boatDraftBlocker({ status: null, remoteUrl: "x", baseBranch: "m" })?.title).toBe(
      "Boat is not set up",
    );
    expect(boatDraftBlocker({ status: status(), remoteUrl: " ", baseBranch: "main" })).toEqual({
      title: "Boat needs a git remote",
      description: "Push this project to a remote Boat can clone.",
    });
    expect(
      boatDraftBlocker({ status: status(), remoteUrl: "git@x:a/b.git", baseBranch: null }),
    ).toEqual({
      title: "Choose a base branch",
      description: "Boat starts a new worktree from it.",
    });
    expect(
      boatDraftBlocker({ status: status(), remoteUrl: "git@x:a/b.git", baseBranch: "main" }),
    ).toBeNull();
  });
});

describe("boatReadyProviders", () => {
  it("unions what machines reported and hides nothing before any report", () => {
    expect(boatReadyProviders(null)).toBeNull();
    expect(boatReadyProviders(status({ machines: [machine(null)] }))).toBeNull();
    expect(
      [
        ...(boatReadyProviders(
          status({ machines: [machine(["codex"]), machine(["claudeAgent"])] }),
        ) ?? []),
      ].toSorted(),
    ).toEqual(["claudeAgent", "codex"]);
  });
});
