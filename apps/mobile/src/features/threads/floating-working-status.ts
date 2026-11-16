import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

import type { BoatSleep } from "../boat/boat-draft";

export interface FloatingStatusAction {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}

export type FloatingWorkingStatus =
  | {
      readonly kind: "child-input";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly onPress: () => void;
    }
  | {
      readonly kind: "stop";
      readonly label: string;
      readonly unresponsive: boolean;
      readonly action: FloatingStatusAction | null;
    }
  | { readonly kind: "goal"; readonly label: string; readonly accessibilityLabel: string }
  | { readonly kind: "extension"; readonly label: string; readonly onPress: () => void }
  | { readonly kind: "preparing"; readonly label: string }
  | {
      readonly kind: "connection";
      readonly tone: "reconnecting" | "unavailable" | "sleeping";
      readonly label: string;
      readonly onPress: () => void;
    };

/** A connection still retrying on its own; short enough for the thread header subtitle. */
export function connectionRetryLabel(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionAwaitingApproval?: boolean;
}): string | null {
  if (input.connectionState === "reconnecting" && input.connectionAwaitingApproval) {
    return "Awaiting device approval";
  }
  if (input.connectionState !== "connecting" && input.connectionState !== "reconnecting") {
    return null;
  }
  return input.connectionError === null ? "Reconnecting…" : "Retrying connection…";
}

export function connectionFloatingStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly environmentLabel: string | null;
  readonly onReconnect: () => void;
  /** Set while the thread's Boat machine is stopped; it reads as asleep, not disconnected. */
  readonly boatSleep?: BoatSleep | null;
}): FloatingWorkingStatus | null {
  const environmentLabel = input.environmentLabel ?? "Environment";
  const unavailable = (label: string): FloatingWorkingStatus => ({
    kind: "connection",
    tone: "unavailable",
    label,
    onPress: input.onReconnect,
  });

  // A stopped Boat machine reads as asleep in any other unconnected phase.
  const diagnosed = input.connectionState === "offline" || input.connectionState === "unsupported";
  if (!diagnosed && input.boatSleep === "waking") {
    return {
      kind: "connection",
      tone: "reconnecting",
      label: `Waking ${environmentLabel}...`,
      onPress: input.onReconnect,
    };
  }
  if (!diagnosed && input.boatSleep === "sleeping") {
    return {
      kind: "connection",
      tone: "sleeping",
      label: "Sleeping. Your next message wakes it.",
      onPress: input.onReconnect,
    };
  }
  switch (input.connectionState) {
    case "offline":
      return unavailable("You are offline");
    case "unsupported":
      return unavailable("Client not supported");
    case "error":
      return unavailable(
        input.connectionError
          ? `Failed to connect to ${environmentLabel}: ${input.connectionError}`
          : `Failed to connect to ${environmentLabel}`,
      );
    case "available":
      return unavailable(`${environmentLabel} is not connected`);
    case "connecting":
    case "reconnecting":
    case "connected":
      return null;
  }
}
