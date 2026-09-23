import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderModelCount,
  getProviderReadyMeta,
  getProviderSummary,
  PI_PRE_PROBE_MESSAGE,
  PROVIDER_SUMMARY_DETAIL_LIMIT,
  resolveProviderCardDisplay,
  truncateProviderDetail,
  getProviderVersionAdvisoryPresentation,
} from "./providerStatus";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", label: "ChatGPT" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("getProviderSummary", () => {
  it("reports ready providers with unknown authentication as available", () => {
    expect(getProviderSummary({ ...provider, auth: { status: "unknown" } })).toEqual({
      headline: "Available",
      detail: null,
    });
  });

  it("does not hide a provider error behind a previous authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        message: "The provider process failed to start.",
      }),
    ).toEqual({
      headline: "Unavailable",
      detail: "The provider process failed to start.",
    });
  });

  it("does not hide a provider warning behind an authenticated state", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "warning",
        message: "The provider version is unsupported.",
      }),
    ).toEqual({
      headline: "Needs attention",
      detail: "The provider version is unsupported.",
    });
  });

  it("keeps authentication failures actionable when their provider status is error", () => {
    expect(
      getProviderSummary({
        ...provider,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Run codex login.",
      }),
    ).toEqual({
      headline: "Not authenticated",
      detail: "Run codex login.",
    });
  });

  it("treats an unavailable shadow as Unavailable even though its snapshot is disabled", () => {
    expect(
      getProviderSummary({
        ...provider,
        enabled: false,
        installed: false,
        status: "disabled",
        availability: "unavailable",
        unavailableReason: "Pi MCP bridge failed to start.",
        message: "Pi MCP bridge failed to start.",
      }),
    ).toEqual({ headline: "Unavailable", detail: "Pi MCP bridge failed to start." });
  });

  it("treats a disabled provider status as disabled even before its enabled flag updates", () => {
    expect(getProviderSummary({ ...provider, status: "disabled" }).headline).toBe("Disabled");
  });
});

describe("resolveProviderCardDisplay", () => {
  it("reads an enabled config with a missing snapshot as Checking, not Disabled", () => {
    expect(
      resolveProviderCardDisplay({ enabled: true, provider: undefined, isChecking: false }),
    ).toEqual({
      statusKey: "warning",
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    });
  });

  it.each(["disabled" as const, "ready" as const])(
    "reads an enabled config with a stale disabled snapshot (%s) as Checking",
    (status) => {
      const display = resolveProviderCardDisplay({
        enabled: true,
        provider: {
          ...provider,
          enabled: false,
          status,
          message: "This provider is installed but disabled.",
        },
        isChecking: false,
      });
      expect(display.headline).toBe("Checking provider status");
      expect(display.statusKey).toBe("warning");
    },
  );

  it("reads the Pi pre-probe snapshot as Checking, not an error", () => {
    expect(PI_PRE_PROBE_MESSAGE).toBe("Pi version has not been checked yet.");
    expect(
      resolveProviderCardDisplay({
        enabled: true,
        provider: {
          ...provider,
          driver: ProviderDriverKind.make("pi"),
          enabled: true,
          installed: false,
          version: null,
          status: "error",
          message: "Pi version has not been checked yet.",
          models: [],
        },
        isChecking: false,
        driver: "pi",
      }),
    ).toEqual({
      statusKey: "warning",
      headline: "Checking provider status",
      detail: "Waiting for the initial provider check to complete.",
    });
  });

  it("keeps real Pi errors visible after the initial check", () => {
    const display = resolveProviderCardDisplay({
      enabled: true,
      provider: {
        ...provider,
        driver: ProviderDriverKind.make("pi"),
        status: "error",
        message: "Probe failed.",
      },
      isChecking: false,
      driver: "pi",
    });
    expect(display.headline).toBe("Unavailable");
    expect(display.statusKey).toBe("error");
  });

  it("does not treat the pre-probe message as Checking for other drivers", () => {
    const display = resolveProviderCardDisplay({
      enabled: true,
      provider: {
        ...provider,
        status: "error",
        message: "Pi version has not been checked yet.",
      },
      isChecking: false,
      driver: "codex",
    });
    expect(display.headline).not.toBe("Checking provider status");
    expect(display.statusKey).toBe("error");
  });

  it("reads an enabled config with an unavailable shadow as Unavailable with the server reason", () => {
    const display = resolveProviderCardDisplay({
      enabled: true,
      provider: {
        ...provider,
        enabled: false,
        installed: false,
        status: "disabled",
        availability: "unavailable",
        unavailableReason: "Pi MCP bridge failed to start.",
        message: "Pi MCP bridge failed to start.",
      },
      isChecking: false,
    });
    expect(display.statusKey).toBe("error");
    expect(display.headline).toBe("Unavailable");
    expect(display.detail).toBe("Pi MCP bridge failed to start.");
  });

  it("keeps an unavailable shadow as Unavailable while a refresh is in flight", () => {
    const display = resolveProviderCardDisplay({
      enabled: true,
      provider: {
        ...provider,
        enabled: false,
        installed: false,
        status: "disabled",
        availability: "unavailable",
        unavailableReason: "Pi MCP bridge failed to start.",
        message: "Pi MCP bridge failed to start.",
      },
      isChecking: true,
    });
    expect(display.statusKey).toBe("error");
    expect(display.headline).toBe("Unavailable");
    expect(display.detail).toBe("Pi MCP bridge failed to start.");
  });

  it("bounds a long unavailable reason to the display limit", () => {
    const display = resolveProviderCardDisplay({
      enabled: true,
      provider: {
        ...provider,
        enabled: false,
        installed: false,
        status: "disabled",
        availability: "unavailable",
        unavailableReason: `probe failed ${"x".repeat(PROVIDER_SUMMARY_DETAIL_LIMIT + 100)}`,
        message: `probe failed ${"x".repeat(PROVIDER_SUMMARY_DETAIL_LIMIT + 100)}`,
      },
      isChecking: false,
    });
    expect(display.headline).toBe("Unavailable");
    expect(display.statusKey).toBe("error");
    expect(display.detail?.length).toBeLessThanOrEqual(PROVIDER_SUMMARY_DETAIL_LIMIT);
  });

  it("reads a disabled config as Disabled even for an unavailable shadow", () => {
    expect(
      resolveProviderCardDisplay({
        enabled: false,
        provider: {
          ...provider,
          enabled: false,
          status: "disabled",
          availability: "unavailable",
          unavailableReason: "Pi MCP bridge failed to start.",
          message: "Pi MCP bridge failed to start.",
        },
        isChecking: false,
      }),
    ).toEqual({ statusKey: "disabled", headline: "Disabled", detail: null });
  });

  it("reads a disabled config as Disabled immediately, even with a healthy snapshot", () => {
    expect(resolveProviderCardDisplay({ enabled: false, provider, isChecking: false })).toEqual({
      statusKey: "disabled",
      headline: "Disabled",
      detail: null,
    });
  });

  it("reads an explicit check as Checking even when the cached snapshot looks ready", () => {
    const display = resolveProviderCardDisplay({
      enabled: true,
      provider: { ...provider, models: [discoveredModel("pi-model")] },
      isChecking: true,
    });
    expect(display).toEqual({
      statusKey: "warning",
      headline: "Checking provider status",
      detail: "Refreshing installation, version, and model details.",
    });
  });

  it("keeps a ready provider with discovered models on its server summary", () => {
    expect(
      resolveProviderCardDisplay({
        enabled: true,
        provider: { ...provider, models: [discoveredModel("pi-model")] },
        isChecking: false,
      }),
    ).toEqual({
      statusKey: "ready",
      headline: "Authenticated · ChatGPT",
      detail: null,
    });
  });

  it("reports a missing binary as Not found with the server message", () => {
    expect(
      resolveProviderCardDisplay({
        enabled: true,
        provider: {
          ...provider,
          installed: false,
          status: "error",
          message: "No pi binary on PATH.",
        },
        isChecking: false,
      }),
    ).toEqual({ statusKey: "error", headline: "Not found", detail: "No pi binary on PATH." });
  });

  it("reports an unsupported version warning with bounded detail", () => {
    const display = resolveProviderCardDisplay({
      enabled: true,
      provider: {
        ...provider,
        status: "warning",
        message: `Unsupported version: ${"x".repeat(PROVIDER_SUMMARY_DETAIL_LIMIT + 100)}`,
      },
      isChecking: false,
    });
    expect(display.headline).toBe("Needs attention");
    expect(display.statusKey).toBe("warning");
    expect(display.detail?.length).toBeLessThanOrEqual(PROVIDER_SUMMARY_DETAIL_LIMIT);
  });

  it("reports a ready Pi provider with zero models as No models found", () => {
    expect(
      resolveProviderCardDisplay({
        enabled: true,
        provider: {
          ...provider,
          driver: ProviderDriverKind.make("pi"),
          status: "ready",
          models: [],
        },
        isChecking: false,
        driver: "pi",
      }).headline,
    ).toBe("No models found");
  });

  it("keeps a ready non-Pi provider with zero models on its server summary", () => {
    expect(
      resolveProviderCardDisplay({
        enabled: true,
        provider: { ...provider, status: "ready", models: [] },
        isChecking: false,
        driver: "codex",
      }),
    ).toEqual({
      statusKey: "ready",
      headline: "Authenticated · ChatGPT",
      detail: null,
    });
  });

  it("keeps sign-in actionable for an unauthenticated provider with zero models", () => {
    expect(
      resolveProviderCardDisplay({
        enabled: true,
        provider: {
          ...provider,
          status: "ready",
          auth: { status: "unauthenticated" },
          models: [],
          message: "Run pi login.",
        },
        isChecking: false,
      }),
    ).toEqual({ statusKey: "ready", headline: "Not authenticated", detail: "Run pi login." });
  });

  it("bounds a discovery error message instead of repeating the raw dump", () => {
    const display = resolveProviderCardDisplay({
      enabled: true,
      provider: {
        ...provider,
        status: "error",
        message: `probe failed\n${"detail ".repeat(200)}`,
      },
      isChecking: false,
    });
    expect(display.headline).toBe("Unavailable");
    expect(display.statusKey).toBe("error");
    expect(display.detail?.length).toBeLessThanOrEqual(PROVIDER_SUMMARY_DETAIL_LIMIT);
  });
});

describe("getProviderReadyMeta", () => {
  it("includes the detected version and model count for a ready Pi snapshot", () => {
    expect(
      getProviderReadyMeta({
        ...provider,
        driver: ProviderDriverKind.make("pi"),
        version: "0.86.1",
        status: "ready",
        auth: { status: "unknown" },
        models: [discoveredModel("openrouter/anthropic/claude-sonnet-4")],
      }),
    ).toBe("v0.86.1 · 1 model");
  });

  it("counts models without a known version", () => {
    expect(
      getProviderReadyMeta({
        ...provider,
        version: null,
        models: [discoveredModel("a"), discoveredModel("b")],
      }),
    ).toBe("2 models");
  });

  it("returns null when the provider is not ready or nothing is known", () => {
    expect(getProviderReadyMeta(undefined)).toBeNull();
    expect(getProviderReadyMeta({ ...provider, status: "warning" })).toBeNull();
    expect(getProviderReadyMeta({ ...provider, version: null, models: [] })).toBeNull();
  });
});

describe("truncateProviderDetail", () => {
  it("passes short detail through and drops empty detail", () => {
    expect(truncateProviderDetail("  CLI not detected.  ")).toBe("CLI not detected.");
    expect(truncateProviderDetail(null)).toBeNull();
    expect(truncateProviderDetail("   ")).toBeNull();
  });

  it("bounds long detail to the display limit", () => {
    const bounded = truncateProviderDetail("x".repeat(PROVIDER_SUMMARY_DETAIL_LIMIT + 10));
    expect(bounded?.length).toBeLessThanOrEqual(PROVIDER_SUMMARY_DETAIL_LIMIT);
  });

  it("labels model counts concisely", () => {
    expect(formatProviderModelCount(1)).toBe("1 model");
    expect(formatProviderModelCount(3)).toBe("3 models");
  });
});

function discoveredModel(slug: string) {
  return { slug, name: slug, isCustom: false, capabilities: null };
}
it("does not suggest copying a command that installs an incompatible latest version", () => {
  const advisory = {
    status: "behind_latest" as const,
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    updateCommand: "npm install -g fixture@latest",
    canUpdate: true,
    checkedAt: provider.checkedAt,
    message: null,
  };
  const compatibility = {
    status: "supported" as const,
    latestVersionStatus: "broken" as const,
    message: null,
    recommendedRange: null,
    recommendedVersion: null,
  };
  expect(getProviderVersionAdvisoryPresentation(advisory, compatibility)).toBeNull();
  expect(
    getProviderVersionAdvisoryPresentation(advisory, { ...compatibility, status: "broken" }, false),
  ).toBeNull();
  expect(
    getProviderVersionAdvisoryPresentation(advisory, {
      ...compatibility,
      latestVersionStatus: "supported",
    }),
  ).not.toBeNull();
});

it("shows compatibility in the version popover even when the installed version is current", () => {
  const advisory = {
    status: "current" as const,
    currentVersion: "2.0.0",
    latestVersion: "2.0.0",
    updateCommand: "npm install -g fixture@latest",
    canUpdate: true,
    checkedAt: provider.checkedAt,
    message: null,
  };
  const compatibility = {
    status: "broken" as const,
    latestVersionStatus: "broken" as const,
    message: "This version drops turns. Use 1.9.0.",
    recommendedRange: null,
    recommendedVersion: "1.9.0",
  };
  expect(getProviderVersionAdvisoryPresentation(advisory, compatibility)).toEqual({
    title: "Known broken version",
    detail: compatibility.message,
    updateCommand: null,
    emphasis: "strong",
    targetVersion: "1.9.0",
  });
  expect(
    getProviderVersionAdvisoryPresentation(undefined, {
      ...compatibility,
      status: "graceful",
      recommendedVersion: null,
      recommendedRange: ">=2.1.0",
      message: null,
    }),
  ).toEqual({
    title: "Limited support",
    detail: "Use >=2.1.0 for full support.",
    updateCommand: null,
    emphasis: "normal",
    targetVersion: null,
  });
});
