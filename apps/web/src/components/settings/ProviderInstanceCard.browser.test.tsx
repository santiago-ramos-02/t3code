import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { providerClients } from "./providerDriverMeta";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const driver = ProviderDriverKind.make("codex");

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-27T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

async function renderCard(
  liveProvider: ServerProvider,
  mode: ComponentProps<typeof ProviderInstanceCard>["mode"],
) {
  await act(async () =>
    root.render(
      <ProviderInstanceCard
        instanceId={liveProvider.instanceId}
        instance={{ driver }}
        driverOption={undefined}
        liveProvider={liveProvider}
        mode={mode}
        onUpdate={() => undefined}
        hiddenModels={[]}
        favoriteModels={[]}
        modelOrder={[]}
        onHiddenModelsChange={() => undefined}
        onFavoriteModelsChange={() => undefined}
        onToggleFavorite={() => undefined}
        onModelOrderChange={() => undefined}
      />,
    ),
  );
}

describe("ProviderInstanceCard", () => {
  it("hides the account email until the user reveals it, and hides it again", async () => {
    await renderCard(
      provider({ auth: { status: "authenticated", email: "developer@example.com" } }),
      "editor",
    );
    expect(container.textContent).toContain("Authenticated as");
    expect(container.textContent).not.toContain("developer@example.com");

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle account email visibility"]',
    )!;
    await userEvent.click(toggle);
    expect(toggle.textContent).toBe("developer@example.com");

    await userEvent.click(toggle);
    expect(container.textContent).not.toContain("developer@example.com");
  });

  it.each(["list", "editor"] as const)(
    "surfaces a failed probe message in the %s",
    async (mode) => {
      await renderCard(
        provider({
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message:
            "Codex app-server provider probe failed: Cannot create Codex shadow home entry 'auth.json' because '/home/me/.codex-t3/work/auth.json' already exists and is not a symlink.",
        }),
        mode,
      );
      expect(container.textContent).toContain("Unavailable");
      expect(container.textContent).toContain("is not a symlink");
    },
  );
});

describe("ProviderInstanceCard status truthfulness", () => {
  const piId = ProviderInstanceId.make("pi");
  const piDriver = ProviderDriverKind.make("pi");

  const piInstance = (enabled: boolean): ProviderInstanceConfig =>
    ({ driver: piDriver, enabled }) as ProviderInstanceConfig;

  const piSnapshot = (patch: Partial<ServerProvider> = {}): ServerProvider =>
    provider({
      instanceId: piId,
      driver: piDriver,
      version: "0.86.1",
      auth: { status: "unknown" },
      models: [
        {
          slug: "openrouter/anthropic/claude-sonnet-4",
          name: "openrouter/anthropic/claude-sonnet-4",
          isCustom: false,
          capabilities: null,
        },
      ],
      ...patch,
    });

  async function renderPi(options: {
    readonly instance?: ProviderInstanceConfig;
    readonly liveProvider?: ServerProvider | undefined;
    readonly mode?: "list" | "editor";
    readonly isChecking?: boolean;
    readonly onRefresh?: (() => void) | undefined;
    readonly onUpdate?: (next: ProviderInstanceConfig) => void;
  }) {
    await act(async () =>
      root.render(
        <ProviderInstanceCard
          instanceId={piId}
          instance={options.instance ?? piInstance(true)}
          driverOption={providerClients.get(piDriver)}
          liveProvider={options.liveProvider}
          mode={options.mode ?? "list"}
          onUpdate={options.onUpdate ?? (() => undefined)}
          hiddenModels={[]}
          favoriteModels={[]}
          modelOrder={[]}
          onHiddenModelsChange={() => undefined}
          onFavoriteModelsChange={() => undefined}
          onToggleFavorite={() => undefined}
          onModelOrderChange={() => undefined}
          {...(options.isChecking === undefined ? {} : { isChecking: options.isChecking })}
          {...(options.onRefresh === undefined ? {} : { onRefresh: options.onRefresh })}
        />,
      ),
    );
  }

  it("reads an enabled instance with a missing snapshot as Checking, not Disabled", async () => {
    await renderPi({ liveProvider: undefined });
    expect(container.textContent).toContain("Checking provider status");
    expect(container.textContent).not.toContain("Disabled");
  });

  it("reads an enabled instance with a stale disabled snapshot as Checking", async () => {
    await renderPi({
      liveProvider: piSnapshot({ enabled: false, status: "disabled" }),
      isChecking: true,
    });
    expect(container.textContent).toContain("Checking provider status");
    expect(container.textContent).not.toMatch(/(^| )Disabled( |$)/);
  });

  it("reads the Pi pre-probe snapshot as Checking, not an error", async () => {
    await renderPi({
      liveProvider: piSnapshot({
        installed: false,
        version: null,
        status: "error",
        message: "Pi version has not been checked yet.",
        models: [],
      }),
    });
    expect(container.textContent).toContain("Checking provider status");
    expect(container.textContent).not.toContain("Unavailable");
    expect(container.textContent).not.toContain("Not found");
  });

  it("reads a disabled instance as Disabled immediately, even with a healthy snapshot", async () => {
    await renderPi({ instance: piInstance(false), liveProvider: piSnapshot() });
    expect(container.textContent).toContain("Disabled");
    expect(container.textContent).not.toContain("Available");
  });

  it("writes the toggle through onUpdate so the panel can coordinate the refresh", async () => {
    const onUpdate = vi.fn();
    await renderPi({ liveProvider: piSnapshot(), onUpdate });
    await userEvent.click(page.getByRole("switch", { name: "Enable Pi" }));
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: false }));
  });

  it("names the detected version and model count for a ready Pi snapshot", async () => {
    await renderPi({ liveProvider: piSnapshot(), mode: "editor" });
    expect(container.textContent).toContain("Available");
    expect(container.textContent).toContain("v0.86.1");
    expect(container.textContent).toContain("1 model");
  });

  it("distinguishes missing binary, unsupported version, zero models, and errors", async () => {
    await renderPi({
      liveProvider: piSnapshot({ installed: false, message: "No pi binary on PATH." }),
      mode: "editor",
    });
    expect(container.textContent).toContain("Not found");

    await renderPi({
      liveProvider: piSnapshot({
        status: "warning",
        message: "Pi 0.40 is no longer supported. Update to 0.86.",
      }),
    });
    expect(container.textContent).toContain("Needs attention");

    await renderPi({ liveProvider: piSnapshot({ models: [] }) });
    expect(container.textContent).toContain("No models found");

    await renderPi({ liveProvider: piSnapshot({ status: "error", message: "Probe failed." }) });
    expect(container.textContent).toContain("Unavailable");
  });

  it("shows an actionable retry when the provider needs attention", async () => {
    const onRefresh = vi.fn();
    await renderPi({
      liveProvider: piSnapshot({ status: "error", message: "Probe failed." }),
      mode: "editor",
      onRefresh,
    });
    const retry = page.getByRole("button", { name: "Refresh status", exact: true });
    await expect.element(retry).toBeEnabled();
    await userEvent.click(retry);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("disables the retry while a check is pending", async () => {
    await renderPi({
      liveProvider: undefined,
      mode: "editor",
      isChecking: true,
      onRefresh: vi.fn(),
    });
    expect(container.textContent).toContain("Checking provider status");
    await expect
      .element(page.getByRole("button", { name: "Checking", exact: true }))
      .toBeDisabled();
  });

  it("keeps an existing healthy provider rendering unchanged", async () => {
    await renderCard(provider({ auth: { status: "authenticated", label: "ChatGPT" } }), "list");
    expect(container.textContent).toContain("Authenticated");
    expect(container.textContent).toContain("v1.0.0");
  });
});
