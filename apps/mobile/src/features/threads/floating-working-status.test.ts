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
    ["offline", false, "unavailable", "You are offline"],
    ["unsupported", false, "unavailable", "Client not supported"],
    [
      "reconnecting",
      true,
      "reconnecting",
      "Waiting for Boat · default · ab12 to approve this device",
    ],
  ] as const)(
    "a real %s diagnostic outranks a sleeping machine",
    (state, awaiting, tone, label) => {
      expect(
        status({
          connectionState: state,
          connectionAwaitingApproval: awaiting,
          boatSleep: "sleeping",
        }),
      ).toEqual({ tone, label });
    },
  );

  it("reads as before for an environment that is not a Boat machine", () => {
    expect(status({ connectionState: "available" })).toEqual({
      tone: "unavailable",
      label: "Boat · default · ab12 is not connected",
    });
    expect(status({ connectionState: "connected", boatSleep: null })).toBeNull();
  });
});
