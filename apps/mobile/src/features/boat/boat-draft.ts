import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { BoatMachine, ProviderDriverKind } from "@t3tools/contracts";

/** The remote a Boat machine clones: the project's own, where an agent can push, else its upstream. */
export function boatRepositoryUrl(
  identity: EnvironmentProject["repositoryIdentity"],
): string | null {
  return identity?.origin?.remoteUrl ?? identity?.locator.remoteUrl ?? null;
}

/** A Boat draft only offers the providers ready on Boat machines; null hides nothing. */
export function restrictProvidersToBoat<
  C extends { readonly providers: ReadonlyArray<{ readonly driver: ProviderDriverKind }> },
>(config: C, ready: ReadonlySet<ProviderDriverKind> | null): C {
  return ready === null
    ? config
    : { ...config, providers: config.providers.filter((provider) => ready.has(provider.driver)) };
}

export type BoatSleep = "sleeping" | "waking";

/**
 * A Boat machine the host stopped reads as asleep until this client has woken it. The host keeps
 * listing it as stopped for a moment after its resume, so a wake in progress outranks the state.
 */
export function boatMachineSleep(input: {
  readonly machine: Pick<BoatMachine, "state"> | null;
  readonly waking: boolean;
  readonly phase: EnvironmentConnectionPhase | null;
}): BoatSleep | null {
  if (input.machine === null || input.phase === null || input.phase === "connected") return null;
  if (input.waking) return "waking";
  return input.machine.state === "stopped" ? "sleeping" : null;
}
