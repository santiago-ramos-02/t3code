import { describe, expect, it } from "vite-plus/test";

import { connectionFloatingStatus } from "./floating-working-status";

describe("connectionFloatingStatus", () => {
  const status = (input: Partial<Parameters<typeof connectionFloatingStatus>[0]>) => {
    const result = connectionFloatingStatus({
      connectionError: null,
      connectionState: "available",
      environmentLabel: "Boat · default · ab12",
      onReconnect: () => undefined,
      ...input,
    });
    return result?.kind === "connection" ? { tone: result.tone, label: result.label } : null;
  };

  it.each([
    ["available", "sleeping", "sleeping", "Sleeping. Your next message wakes it."],
    ["error", "sleeping", "sleeping", "Sleeping. Your next message wakes it."],
    ["reconnecting", "sleeping", "sleeping", "Sleeping. Your next message wakes it."],
    ["reconnecting", "waking", "reconnecting", "Waking Boat · default · ab12..."],
    ["connecting", "waking", "reconnecting", "Waking Boat · default · ab12..."],
  ] as const)("a Boat machine in %s that is %s reads %s", (state, sleep, tone, label) => {
    expect(status({ connectionState: state, boatSleep: sleep })).toEqual({ tone, label });
  });

  it.each([
    ["offline", "unavailable", "You are offline"],
    ["unsupported", "unavailable", "Client not supported"],
  ] as const)("a real %s diagnostic outranks a sleeping machine", (state, tone, label) => {
    expect(status({ connectionState: state, boatSleep: "sleeping" })).toEqual({ tone, label });
  });

  it("leaves a retrying connection to the header subtitle", () => {
    expect(status({ connectionState: "reconnecting" })).toBeNull();
    expect(status({ connectionState: "connecting" })).toBeNull();
  });

  it("reads as before for an environment that is not a Boat machine", () => {
    expect(status({ connectionState: "available" })).toEqual({
      tone: "unavailable",
      label: "Boat · default · ab12 is not connected",
    });
    expect(status({ connectionState: "connected", boatSleep: null })).toBeNull();
  });
});
