import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PiAgentIcon } from "../Icons";
import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("provider icon presentation", () => {
  it("uses Pi branding for Pi provider instances", () => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("pi")]).toBe(PiAgentIcon);
  });
});
