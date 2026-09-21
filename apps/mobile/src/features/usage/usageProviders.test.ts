import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));

import { PROVIDER_LABEL, PROVIDER_ORDER } from "./usageProviders";

describe("mobile usage provider presentation", () => {
  it("keeps labels exhaustive and Pi in the shared reading order", () => {
    expect(PROVIDER_ORDER).toEqual(["codex", "claude", "grok", "pi"]);
    expect(Object.keys(PROVIDER_LABEL).toSorted()).toEqual([...PROVIDER_ORDER].toSorted());
    expect(PROVIDER_LABEL.pi).toBe("Pi");
  });
});
