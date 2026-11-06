import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_ORDER, PROVIDER_PRESENTATION, rankProvidersByMetric } from "./usageProviders";

describe("rankProvidersByMetric", () => {
  it("ranks by the selected metric, highest first", () => {
    const totals = [
      { provider: "codex" as const, totalTokens: 100, costUsd: 20 },
      { provider: "claude" as const, totalTokens: 200, costUsd: 10 },
    ];
    const providers = ["codex", "claude"] as const;

    expect(rankProvidersByMetric(providers, totals, "tokens")).toEqual(["claude", "codex"]);
    expect(rankProvidersByMetric(providers, totals, "cost")).toEqual(["codex", "claude"]);
  });

  it("keeps ties in input order without reordering the shared provider list", () => {
    const totals = [
      { provider: "codex" as const, totalTokens: 10, costUsd: 1 },
      { provider: "claude" as const, totalTokens: 10, costUsd: 1 },
      { provider: "grok" as const, totalTokens: 20, costUsd: 2 },
    ];
    const providers = ["claude", "codex", "grok"] as const;

    expect(rankProvidersByMetric(providers, totals, "tokens")).toEqual(["grok", "claude", "codex"]);
    expect(providers).toEqual(["claude", "codex", "grok"]);
  });
});

describe("usage provider presentation", () => {
  it("keeps an exhaustive stable order including Pi", () => {
    expect(PROVIDER_ORDER).toEqual([
      "codex",
      "claude",
      "grok",
      "cursor",
      "opencode",
      "antigravity",
      "pi",
      "muse",
    ]);
    expect(Object.keys(PROVIDER_PRESENTATION)).toEqual(PROVIDER_ORDER);
  });

  it("uses Pi branding instead of another coding provider's mark", () => {
    expect(PROVIDER_PRESENTATION.pi).toMatchObject({
      label: "Pi",
      color: "#4d9f8a",
      driverKind: "pi",
    });
  });
});
