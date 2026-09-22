import { isValidElement, type ReactElement } from "react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { getDriverOption } from "./providerDriverMeta";

const piId = ProviderInstanceId.make("pi");
const piDriver = ProviderDriverKind.make("pi");

function piInstance(enabled: boolean): ProviderInstanceConfig {
  return { driver: piDriver, enabled } as ProviderInstanceConfig;
}

function model(slug: string) {
  return { slug, name: slug, isCustom: false, capabilities: null };
}

function piSnapshot(patch: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: piId,
    driver: piDriver,
    enabled: true,
    installed: true,
    version: "0.86.1",
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-09-02T00:00:00.000Z",
    models: [model("openrouter/anthropic/claude-sonnet-4")],
    slashCommands: [],
    skills: [],
    ...patch,
  };
}

function renderCard(options: {
  readonly instance?: ProviderInstanceConfig;
  readonly liveProvider?: ServerProvider | undefined;
  readonly mode?: "list" | "editor";
  readonly isChecking?: boolean;
  readonly onRefresh?: (() => void) | undefined;
  readonly onUpdate?: ((next: ProviderInstanceConfig) => void) | undefined;
}) {
  hooks.beginRender();
  return ProviderInstanceCard({
    instanceId: piId,
    instance: options.instance ?? piInstance(true),
    driverOption: getDriverOption(piDriver),
    liveProvider: options.liveProvider,
    mode: options.mode ?? "list",
    onUpdate: options.onUpdate ?? vi.fn(),
    hiddenModels: [],
    favoriteModels: [],
    modelOrder: [],
    onHiddenModelsChange: vi.fn(),
    onFavoriteModelsChange: vi.fn(),
    onModelOrderChange: vi.fn(),
    ...(options.isChecking === undefined ? {} : { isChecking: options.isChecking }),
    ...(options.onRefresh === undefined ? {} : { onRefresh: options.onRefresh }),
  }) as ReactElement<Record<string, unknown>>;
}

/** Concatenate every string leaf so status copy can be asserted without markup coupling. */
function collectText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  if (!isValidElement<Record<string, unknown>>(node)) return "";
  return Object.values(node.props).map(collectText).join(" ");
}

function clickRefresh(view: unknown): ReactElement<Record<string, unknown>> {
  const button = visitElements(
    view,
    (element) =>
      Array.isArray(element.props.children) &&
      (element.props.children as unknown[]).includes("Refresh status") &&
      typeof element.props.onClick === "function",
  );
  if (!button) throw new Error("Missing Refresh status button.");
  return button;
}

describe("ProviderInstanceCard status truthfulness", () => {
  it("reads an enabled instance with a missing snapshot as Checking, not Disabled", () => {
    const text = collectText(renderCard({ liveProvider: undefined }));
    expect(text).toContain("Checking provider status");
    expect(text).not.toContain("Disabled");
  });

  it("reads an enabled instance with a stale disabled snapshot as Checking", () => {
    const text = collectText(
      renderCard({
        liveProvider: piSnapshot({ enabled: false, status: "disabled" }),
        isChecking: true,
      }),
    );
    expect(text).toContain("Checking provider status");
    expect(text).not.toMatch(/(^| )Disabled( |$)/);
  });

  it("reads the Pi pre-probe snapshot as Checking, not an error", () => {
    const text = collectText(
      renderCard({
        liveProvider: piSnapshot({
          installed: false,
          version: null,
          status: "error",
          message: "Pi version has not been checked yet.",
          models: [],
        }),
      }),
    );
    expect(text).toContain("Checking provider status");
    expect(text).not.toContain("Unavailable");
    expect(text).not.toContain("Not found");
  });

  it("reads a disabled instance as Disabled immediately, even with a healthy snapshot", () => {
    const text = collectText(
      renderCard({ instance: piInstance(false), liveProvider: piSnapshot() }),
    );
    expect(text).toContain("Disabled");
    expect(text).not.toContain("Available");
  });

  it("writes the toggle through onUpdate so the panel can coordinate the refresh", () => {
    const onUpdate = vi.fn();
    const view = renderCard({ liveProvider: piSnapshot(), onUpdate });
    const toggle = visitElements(
      view,
      (element) =>
        element.props["aria-label"] === "Enable Pi" &&
        typeof element.props.onCheckedChange === "function",
    );
    if (!toggle) throw new Error("Missing provider enable toggle.");
    (toggle.props.onCheckedChange as (checked: boolean) => void)(false);
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ enabled: false }));
  });

  it("names the detected version and model count for a ready Pi snapshot", () => {
    const text = collectText(renderCard({ liveProvider: piSnapshot(), mode: "editor" }));
    expect(text).toContain("Available");
    expect(text).toContain("v0.86.1");
    expect(text).toContain("1 model");
  });

  it("distinguishes missing binary, unsupported version, zero models, and errors", () => {
    expect(
      collectText(
        renderCard({
          liveProvider: piSnapshot({ installed: false, message: "No pi binary on PATH." }),
          mode: "editor",
        }),
      ),
    ).toContain("Not found");
    expect(
      collectText(
        renderCard({
          liveProvider: piSnapshot({
            status: "warning",
            message: "Pi 0.40 is no longer supported. Update to 0.86.",
          }),
        }),
      ),
    ).toContain("Needs attention");
    expect(collectText(renderCard({ liveProvider: piSnapshot({ models: [] }) }))).toContain(
      "No models found",
    );
    expect(
      collectText(
        renderCard({
          liveProvider: piSnapshot({ status: "error", message: "Probe failed." }),
        }),
      ),
    ).toContain("Unavailable");
  });

  it("shows an actionable retry when the provider needs attention", () => {
    const onRefresh = vi.fn();
    const view = renderCard({
      liveProvider: piSnapshot({ status: "error", message: "Probe failed." }),
      mode: "editor",
      onRefresh,
    });
    const button = clickRefresh(view);
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("disables the retry while a check is pending", () => {
    const view = renderCard({
      liveProvider: undefined,
      mode: "editor",
      isChecking: true,
      onRefresh: vi.fn(),
    });
    expect(collectText(view)).toContain("Checking provider status");
    const checkingButton = visitElements(
      view,
      (element) =>
        Array.isArray(element.props.children) &&
        (element.props.children as unknown[]).includes("Checking") &&
        typeof element.props.onClick === "function",
    );
    expect(checkingButton?.props.disabled).toBe(true);
  });

  it("keeps an existing healthy provider rendering unchanged", () => {
    const codexId = ProviderInstanceId.make("codex");
    hooks.beginRender();
    const view = ProviderInstanceCard({
      instanceId: codexId,
      instance: {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
      } as ProviderInstanceConfig,
      driverOption: getDriverOption(ProviderDriverKind.make("codex")),
      liveProvider: {
        ...piSnapshot({}),
        instanceId: codexId,
        driver: ProviderDriverKind.make("codex"),
        version: "1.0.0",
        auth: { status: "authenticated", label: "ChatGPT" },
      },
      mode: "list",
      onUpdate: vi.fn(),
      hiddenModels: [],
      favoriteModels: [],
      modelOrder: [],
      onHiddenModelsChange: vi.fn(),
      onFavoriteModelsChange: vi.fn(),
      onModelOrderChange: vi.fn(),
    }) as ReactElement<Record<string, unknown>>;
    const text = collectText(view);
    expect(text).toContain("Authenticated");
    expect(text).toContain("v1.0.0");
  });
});
