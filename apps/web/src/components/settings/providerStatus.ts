import type { ServerProvider, ServerProviderVersionAdvisory } from "@t3tools/contracts";

/**
 * Visual treatment for each server-reported provider status. Centralized so
 * the default-driver card and per-instance cards share the same language.
 */
export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-muted-foreground/50",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

/**
 * Maximum characters kept from a server-supplied provider message before it
 * is shown under a provider name. Probe output can be a multi-paragraph CLI
 * dump; the card shows a bounded prefix so an error stays actionable
 * instead of pushing the settings list around.
 */
export const PROVIDER_SUMMARY_DETAIL_LIMIT = 280;

/**
 * Bound free-form server detail for inline display. Returns `null` when
 * there is nothing meaningful to show, so callers can hide the detail slot.
 */
export function truncateProviderDetail(detail: string | null | undefined): string | null {
  if (detail === null || detail === undefined) return null;
  const trimmed = detail.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= PROVIDER_SUMMARY_DETAIL_LIMIT) return trimmed;
  return `${trimmed.slice(0, PROVIDER_SUMMARY_DETAIL_LIMIT - 1).trimEnd()}…`;
}

/** Label a discovered model count the way the settings UI phrases counts. */
export function formatProviderModelCount(modelCount: number): string {
  return modelCount === 1 ? "1 model" : `${modelCount} models`;
}

/**
 * Concise `version · model count` meta for a ready provider, e.g.
 * `v0.86.1 · 1 model`. Returns `null` when the provider is not ready or
 * neither the version nor a discovered model count is known. Non-ready
 * states keep their own actionable copy; the version chip in the card
 * header already covers them.
 */
export function getProviderReadyMeta(provider: ServerProvider | undefined): string | null {
  if (!provider || provider.status !== "ready") return null;
  const parts: string[] = [];
  const version = getProviderVersionLabel(provider.version);
  if (version) parts.push(version);
  if (provider.models.length > 0) parts.push(formatProviderModelCount(provider.models.length));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Exact message PiDriver publishes for an enabled instance before its
 * scope-owned startup probe runs. That snapshot is pending, not failed.
 */
export const PI_PRE_PROBE_MESSAGE = "Pi version has not been checked yet.";

/**
 * Resolve what a provider instance card shows for its status line.
 *
 * The toggle reads the persisted instance config while the snapshot arrives
 * asynchronously, so the two can disagree: an enabled config with a stale
 * `disabled` snapshot (or no snapshot yet) is a provider whose probe has
 * not run since it was enabled, not a disabled provider. Those cases read
 * as Checking, never as stale Disabled. A disabled config always reads as
 * Disabled immediately, regardless of any cached snapshot.
 *
 * Zero discovered models on an otherwise ready, installed Pi provider reads
 * as attention-worthy rather than Available: model discovery ran and found
 * nothing. Other drivers keep their server summary so existing rows do not
 * change meaning. Unauthenticated providers keep their sign-in copy even
 * when their model list is empty, since signing in is the more actionable
 * step.
 */
export function resolveProviderCardDisplay(input: {
  readonly enabled: boolean;
  readonly provider: ServerProvider | undefined;
  readonly isChecking: boolean;
  readonly driver?: string | undefined;
}): {
  readonly statusKey: ProviderStatusKey;
  readonly headline: string;
  readonly detail: string | null;
} {
  if (!input.enabled) {
    return { statusKey: "disabled", headline: "Disabled", detail: null };
  }
  if (input.isChecking || !input.provider) {
    return {
      statusKey: "warning",
      headline: "Checking provider status",
      detail: input.provider
        ? "Refreshing installation, version, and model details."
        : "Waiting for the server to report installation and authentication details.",
    };
  }
  const provider = input.provider;
  if (!provider.enabled || provider.status === "disabled") {
    return {
      statusKey: "warning",
      headline: "Checking provider status",
      detail: "Waiting for refreshed status after enabling.",
    };
  }
  if (
    String(input.driver ?? provider?.driver ?? "") === "pi" &&
    provider.status === "error" &&
    provider.message === PI_PRE_PROBE_MESSAGE
  ) {
    return {
      statusKey: "warning",
      headline: "Checking provider status",
      detail: "Waiting for the initial provider check to complete.",
    };
  }
  const summary = getProviderSummary(provider);
  if (provider.status === "warning" || provider.status === "error") {
    return {
      statusKey: provider.status,
      headline: summary.headline,
      detail: truncateProviderDetail(summary.detail),
    };
  }
  if (
    String(input.driver ?? provider?.driver ?? "") === "pi" &&
    provider.installed &&
    provider.status === "ready" &&
    provider.auth.status !== "unauthenticated" &&
    provider.models.length === 0
  ) {
    return {
      statusKey: "warning",
      headline: "No models found",
      detail:
        truncateProviderDetail(provider.message) ??
        "The provider is ready but no models were discovered.",
    };
  }
  return { statusKey: provider.status, headline: summary.headline, detail: summary.detail };
}

/**
 * Derive the headline + detail copy shown under a provider's name in the
 * settings page. Prefers `provider.message` for server-supplied detail and
 * falls back to generic phrasing when the server has not yet reported any
 * state — which happens before the first probe or when an instance names a
 * driver this build does not ship. A ready provider without account metadata
 * remains available and does not imply an authentication failure.
 */
export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled || provider.status === "disabled") {
    return {
      headline: "Disabled",
      detail:
        provider.message ?? "This provider is installed but disabled for new sessions in T3 Code.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? null,
  };
}

/**
 * Normalize a version string for display. Adds the `v` prefix when the
 * driver reported a bare version (e.g. `1.2.3`) so cards render
 * consistently regardless of driver.
 */
export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  // Antigravity reports a release tag such as `agy_acp_server_20260818_01_RC01`.
  // Show the date and candidate so the row title keeps room for the name.
  const antigravity = /^agy_acp_server_(\d{4})(\d{2})(\d{2})_\d+(?:_(\w+))?$/.exec(version);
  if (antigravity) {
    const [, year, month, day, candidate] = antigravity;
    return `${year}-${month}-${day}${candidate ? ` ${candidate}` : ""}`;
  }
  // Only bare semver-like versions get a `v` prefix. Other tags are shown as-is.
  return /^\d/.test(version) ? `v${version}` : version;
}

export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
): {
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
} | null {
  if (!advisory || advisory.status === "current" || advisory.status === "unknown") {
    return null;
  }

  const label = "Update available";
  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    detail:
      advisory.message ??
      (versionLabel
        ? `${label}: install ${versionLabel}.`
        : `${label}: install the latest provider version.`),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
  };
}
