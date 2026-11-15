/**
 * Which providers are ready on a Boat machine, from the machine's own server configuration.
 *
 * @module boat/machineProviders
 */
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  KeybindingsConfigError,
  ProviderDriverKind,
  ServerProviderAuthStatus,
  ServerProviderState,
  ServerSettingsError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

// Only what is read from the machine's configuration, so a newer or older machine still answers.
const MachineProviders = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      driver: ProviderDriverKind,
      enabled: Schema.Boolean,
      status: ServerProviderState,
      auth: Schema.Struct({ status: ServerProviderAuthStatus }),
    }),
  ),
});

export const MachineConfigRpcs = RpcGroup.make(
  Rpc.make(WS_METHODS.serverGetConfig, {
    payload: Schema.Struct({}),
    success: MachineProviders,
    error: Schema.Union([
      KeybindingsConfigError,
      ServerSettingsError,
      EnvironmentAuthorizationError,
    ]),
  }),
);

/** Reading the machine's configuration. */
export const MACHINE_CONFIG_SCOPES = [AuthOrchestrationReadScope] as const;

/** The drivers with an instance that is enabled, ready and signed in, each once. */
export const readyDrivers = (config: typeof MachineProviders.Type) => [
  ...new Set(
    config.providers
      .filter(
        (provider) =>
          provider.enabled &&
          provider.status === "ready" &&
          provider.auth.status === "authenticated",
      )
      .map((provider) => provider.driver),
  ),
];
