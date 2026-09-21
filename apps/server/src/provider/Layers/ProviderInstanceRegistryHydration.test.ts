import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

describe("Pi provider instance hydration", () => {
  it("registers Pi as a built-in multi-instance driver", () => {
    const driver = BUILT_IN_DRIVERS.find((candidate) => candidate.driverKind === "pi");

    expect(driver).toBeDefined();
    expect(driver?.metadata).toMatchObject({
      displayName: "Pi",
      supportsMultipleInstances: true,
    });
    expect(driver?.defaultConfig()).toEqual({
      enabled: false,
      binaryPath: "pi",
      customModels: [],
    });
  });

  it("hydrates the default Pi instance from legacy server settings", () => {
    const configMap = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
    const pi = configMap[ProviderInstanceId.make("pi")];

    expect(pi).toEqual({
      driver: "pi",
      config: {
        enabled: false,
        binaryPath: "pi",
        customModels: [],
      },
    });
  });

  it("keeps an explicit Pi instance instead of replacing it with the legacy mirror", () => {
    const piId = ProviderInstanceId.make("pi");
    const configMap = deriveProviderInstanceConfigMap({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [piId]: {
          driver: ProviderDriverKind.make("pi"),
          enabled: true,
          config: { binaryPath: "/custom/pi" },
        },
      },
    });

    expect(configMap[piId]).toEqual({
      driver: "pi",
      enabled: true,
      config: { binaryPath: "/custom/pi" },
    });
  });
});
