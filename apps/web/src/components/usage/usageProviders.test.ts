import { describe, expect, it } from "vite-plus/test";

import { OpenCodeIcon, PiAgentIcon } from "../Icons";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

describe("usage provider presentation", () => {
  it("keeps an exhaustive stable order including Pi", () => {
    expect(PROVIDER_ORDER).toEqual(["codex", "claude", "grok", "pi"]);
    expect(Object.keys(PROVIDER_PRESENTATION)).toEqual(PROVIDER_ORDER);
  });

  it("uses Pi branding instead of another coding provider's mark", () => {
    expect(PROVIDER_PRESENTATION.pi).toMatchObject({
      label: "Pi",
      color: expect.stringContaining("contrast-foreground"),
      mark: PiAgentIcon,
    });
    expect(PROVIDER_PRESENTATION.pi.mark).not.toBe(OpenCodeIcon);
  });
});
