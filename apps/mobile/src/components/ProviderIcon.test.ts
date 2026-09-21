import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("react-native", () => ({ View: "div" }));
vi.mock("react-native-svg", () => ({ Path: "path", Rect: "rect", Svg: "svg" }));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));

import { ProviderIcon } from "./ProviderIcon";

describe("ProviderIcon", () => {
  it("renders Pi's mark instead of the Codex fallback", () => {
    const pi = ProviderIcon({ provider: "pi", size: 20 });
    const codex = ProviderIcon({ provider: "codex", size: 20 });

    expect(pi.props.viewBox).toBe("0 0 800 800");
    expect(pi.props.viewBox).not.toBe(codex.props.viewBox);
  });
});
