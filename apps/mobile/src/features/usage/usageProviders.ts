import type { UsageProviderKind } from "@t3tools/contracts";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/**
 * Series and table order. The chart stacks providers from the bottom in this
 * order, so it also fixes which band sits on top of the bars.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = [
  "codex",
  "claude",
  "grok",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
  cursor: "Cursor",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  pi: "Pi",
};

/** Shared labels for provider-instance and live-limit surfaces. */
const PROVIDER_DRIVER_LABEL: Readonly<Record<string, string>> = {
  antigravity: "Antigravity",
  claudeAgent: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  pi: "Pi",
};

const USAGE_PROVIDER_BY_DRIVER: Readonly<Partial<Record<string, UsageProviderKind>>> = {
  claudeAgent: "claude",
  codex: "codex",
  grok: "grok",
  cursor: "cursor",
  opencode: "opencode",
  antigravity: "antigravity",
  pi: "pi",
};

export function providerDriverLabel(driver: string): string {
  return PROVIDER_DRIVER_LABEL[driver] ?? driver;
}

export function usageProviderForDriver(driver: string): UsageProviderKind | null {
  return USAGE_PROVIDER_BY_DRIVER[driver] ?? null;
}

/**
 * Claude's brand orange and Pi's mid-tone neutral hold in both themes. Codex
 * and Grok flip so their bars remain distinct against the matching background.
 */
export function useProviderColors(): Record<UsageProviderKind, string> {
  const { themeAppearance: scheme } = useAppearancePreferences();
  return {
    claude: "#d97757",
    codex: scheme === "dark" ? "#e6e6e6" : "#3c3c43",
    grok: scheme === "dark" ? "#a1a1aa" : "#52525b",
    cursor: "#8b8b8b",
    opencode: "#5b9bbd",
    antigravity: "#8c7bd1",
    pi: "#4d9f8a",
  };
}

/**
 * Neutral steps for cost and token mixes, so they never borrow a provider's
 * color. Matches the web steps: oklab mixes of the codex ink into the
 * background, above the 15 ΔE separation floor for adjacent segments.
 */
export function useUsageMixColors() {
  const { themeAppearance: scheme } = useAppearancePreferences();
  const dark = scheme === "dark";
  return {
    input: dark ? "#737373" : "#848484",
    cacheRead: dark ? "#282828" : "#c0c0c0",
    cacheWrite: dark ? "#949494" : "#6d6d6d",
    output: dark ? "#e6e6e6" : "#3c3c43",
    other: dark ? "#494949" : "#a3a3a3",
    standard: dark ? "#313131" : "#b8b8b8",
    fast: dark ? "#838383" : "#797979",
    ultrafast: dark ? "#e6e6e6" : "#3c3c43",
  };
}
