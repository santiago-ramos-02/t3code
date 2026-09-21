import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

describe("usage provider presentation", () => {
  it("keeps an exhaustive stable order including Pi", () => {
    expect(PROVIDER_ORDER).toEqual(["codex", "claude", "grok", "pi"]);
    expect(Object.keys(PROVIDER_PRESENTATION)).toEqual(PROVIDER_ORDER);
  });

  it("uses the neutral code presentation reserved for Pi before dedicated branding", () => {
    expect(PROVIDER_PRESENTATION.pi).toMatchObject({
      label: "Pi",
      color: expect.stringContaining("contrast-foreground"),
    });
    expect(PROVIDER_PRESENTATION.pi.mark).toBeTypeOf("function");
  });
});
