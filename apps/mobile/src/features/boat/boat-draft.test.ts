import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boatMachineSleep, boatRepositoryUrl, restrictProvidersToBoat } from "./boat-draft";

const driver = (name: string) => ProviderDriverKind.make(name);

describe("restrictProvidersToBoat", () => {
  const config = {
    label: "host",
    providers: [{ driver: driver("codex") }, { driver: driver("claudeAgent") }],
  };

  it("keeps only the providers ready on Boat machines", () => {
    expect(restrictProvidersToBoat(config, new Set([driver("claudeAgent")]))).toEqual({
      label: "host",
      providers: [{ driver: driver("claudeAgent") }],
    });
  });

  it("hides nothing before any machine has reported", () => {
    expect(restrictProvidersToBoat(config, null)).toBe(config);
  });
});

describe("boatRepositoryUrl", () => {
  const locator = {
    source: "git-remote" as const,
    remoteName: "upstream",
    remoteUrl: "https://github.com/pingdotgg/t3code.git",
  };

  it("prefers the project's own remote, where an agent can push, over its upstream", () => {
    expect(
      boatRepositoryUrl({
        canonicalKey: "github.com/pingdotgg/t3code",
        locator,
        origin: {
          canonicalKey: "github.com/fork/t3code",
          remoteUrl: "https://github.com/fork/t3code.git",
        },
      }),
    ).toBe("https://github.com/fork/t3code.git");
    expect(boatRepositoryUrl({ canonicalKey: "github.com/pingdotgg/t3code", locator })).toBe(
      locator.remoteUrl,
    );
    expect(boatRepositoryUrl(null)).toBeNull();
  });
});

describe("boatMachineSleep", () => {
  const stopped = { state: "stopped" } as const;

  it.each([
    [stopped, false, "available", "sleeping"],
    [stopped, false, "error", "sleeping"],
    [stopped, true, "reconnecting", "waking"],
    // The host lists the machine as stopped for a moment after its resume.
    [{ state: "running" }, true, "connecting", "waking"],
    [{ state: "running" }, false, "reconnecting", null],
    [stopped, false, "connected", null],
    [stopped, true, "connected", null],
    [null, true, "available", null],
  ] as const)("%j, waking %s, %s reads %s", (machine, waking, phase, expected) => {
    expect(boatMachineSleep({ machine, waking, phase })).toBe(expected);
  });

  it("reads nothing before the connection phase is known", () => {
    expect(boatMachineSleep({ machine: stopped, waking: false, phase: null })).toBeNull();
  });
});
