/**
 * Fork-owned extension points of the OpenCode driver, which the server fills in for Gentle AI:
 * the session launch hook of the T3-started server, and the wrapper for OpenCode 2, whose one
 * shared server cannot drop gentle-ai per thread. The package cannot import the server, so the
 * server provides them as one optional service; without it the driver behaves as upstream's.
 *
 * @module provider-opencode/server/gentleHooks
 */
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { OpenCodeSettings } from "../settings.ts";

/** The server launch of one OpenCode session. */
export interface OpenCodeServerLaunch {
  readonly environment: NodeJS.ProcessEnv;
  readonly serverUrl: OpenCodeSettings["serverUrl"];
}

export interface OpenCodeGentleHooksShape {
  /** Adjusts the server launch for one session. */
  readonly prepareSession?: (
    input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    launch: OpenCodeServerLaunch,
  ) => Effect.Effect<
    OpenCodeServerLaunch,
    ProviderAdapter.ProviderAdapterOpenSessionError,
    Scope.Scope
  >;
  /** Wraps the OpenCode 2 adapter, which serves every thread from one server. */
  readonly wrapSharedServerAdapter?: (
    adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  ) => ProviderAdapter.ProviderAdapterV2["Service"];
}

export class OpenCodeGentleHooks extends Context.Reference<OpenCodeGentleHooksShape>(
  "@t3tools/provider-opencode/server/gentleHooks/OpenCodeGentleHooks",
  { defaultValue: () => ({}) },
) {}
