import type { ReactElement } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { toastManager } from "../ui/toast";

const atoms = vi.hoisted(() => ({
  providers: null as ReadonlyArray<ServerProvider> | null,
  providersAtom: Symbol("providers"),
  refreshProviders: Symbol("refreshProviders"),
  updateProvider: Symbol("updateProvider"),
}));

const commands = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateProvider: vi.fn(),
}));

const settingsState = vi.hoisted(() => ({
  value: null as UnifiedSettings | null,
  readEnvironmentIds: [] as EnvironmentId[],
  updateEnvironmentIds: [] as EnvironmentId[],
  updateSettings: vi.fn(),
  updateClientSettings: vi.fn(),
}));

const settingsSearchState = vi.hoisted(() => ({
  targetId: null as string | null,
  effects: [] as Array<() => void>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void) => settingsSearchState.effects.push(effect),
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("./settingsLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settingsLayout")>();
  return {
    ...actual,
    useSettingsSearchTargetId: () => settingsSearchState.targetId,
  };
});

vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));
vi.mock("./useSettingsProjectGroups", () => ({ useSettingsProjectGroups: () => [] }));
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => atoms.providers,
}));

vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => atoms.providersAtom,
    refreshProviders: atoms.refreshProviders,
    updateProvider: atoms.updateProvider,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === atoms.refreshProviders ? commands.refresh : commands.updateProvider,
}));

vi.mock("../../hooks/useSettings", () => ({
  useUpdateClientSettings: () => settingsState.updateClientSettings,
  useEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.readEnvironmentIds.push(environmentId);
    return settingsState.value;
  },
  useUpdateEnvironmentSettings: () => settingsState.updateSettings,
}));

vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));

vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, hasError: false, isPending: true }),
}));

import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";

const environmentId = EnvironmentId.make("remote-device");
const codexId = ProviderInstanceId.make("codex");
const piId = ProviderInstanceId.make("pi");
const customId = ProviderInstanceId.make("codex_work");

function provider(): ServerProvider {
  return {
    instanceId: codexId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-24T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "pnpm add -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-07-24T12:00:00.000Z",
      message: "Update available.",
    },
  };
}

function renderPanel(options?: {
  readonly environmentId?: EnvironmentId;
  readonly readOnly?: boolean;
  readonly targetInstanceId?: ProviderInstanceId;
}): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return EnvironmentProviderSettings({
    environmentId: options?.environmentId ?? environmentId,
    environmentLabel: "Remote device",
    ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options?.targetInstanceId === undefined
      ? {}
      : { targetInstanceId: options.targetInstanceId }),
  }) as ReactElement<Record<string, unknown>>;
}

function isRefreshButton(element: ReactElement<Record<string, unknown>>): boolean {
  const children = element.props.children;
  return (
    Array.isArray(children) &&
    children.some(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        (child as ReactElement<Record<string, unknown>>).props?.className === "sr-only" &&
        (child as ReactElement<Record<string, unknown>>).props?.children ===
          "Refresh provider status",
    )
  );
}

function isAddProviderButton(element: ReactElement<Record<string, unknown>>): boolean {
  return element.props["aria-label"] === "Add provider";
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EnvironmentProviderSettings routing", () => {
  beforeEach(() => {
    hooks.reset();
    atoms.providers = null;
    settingsState.value = DEFAULT_UNIFIED_SETTINGS;
    settingsState.readEnvironmentIds = [];
    settingsState.updateEnvironmentIds = [];
    settingsState.updateSettings.mockReset();
    settingsState.updateClientSettings.mockReset();
    settingsSearchState.targetId = null;
    settingsSearchState.effects = [];
    commands.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.updateProvider.mockReset().mockResolvedValue({ _tag: "Success" });
  });

  it("coalesces a nullable provider snapshot before rendering array-backed UI", () => {
    expect(() => renderPanel()).not.toThrow();
    expect(settingsState.readEnvironmentIds).toEqual([environmentId]);
  });

  it("routes refresh and provider update commands to the selected environment", async () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    const refreshButton = visitElements(panel, isRefreshButton);
    expect(refreshButton).not.toBeNull();
    (refreshButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.refresh).toHaveBeenCalledWith({
      environmentId,
      input: { refreshModels: true },
    });

    const providerCard = visitElements(
      panel,
      (element) =>
        element.props.instanceId === codexId && typeof element.props.onRunUpdate === "function",
    );
    expect(providerCard).not.toBeNull();
    (providerCard?.props.onRunUpdate as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.updateProvider).toHaveBeenCalledWith({
      environmentId,
      input: { provider: ProviderDriverKind.make("codex"), instanceId: codexId },
    });
  });

  it("renders Pi through the generic local-binary provider card", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providers: {
        ...DEFAULT_UNIFIED_SETTINGS.providers,
        pi: { ...DEFAULT_UNIFIED_SETTINGS.providers.pi, binaryPath: "/opt/pi/bin/pi" },
      },
    };
    atoms.providers = [
      {
        ...provider(),
        instanceId: piId,
        driver: ProviderDriverKind.make("pi"),
        displayName: "Pi",
        version: "0.86.1",
        auth: { status: "unknown" },
        models: [
          {
            slug: "openrouter/anthropic/claude-sonnet-4",
            name: "Claude Sonnet 4",
            isCustom: false,
            capabilities: null,
          },
        ],
      },
    ];

    const panel = renderPanel();
    const piRow = visitElements(
      panel,
      (element) => element.props.instanceId === piId && element.props.mode === "list",
    );

    expect(piRow?.props.driverOption).toMatchObject({ label: "Pi" });
    expect(piRow?.props.instance).toMatchObject({
      driver: ProviderDriverKind.make("pi"),
      config: { binaryPath: "/opt/pi/bin/pi" },
    });
    expect(piRow?.props.liveProvider).toMatchObject({
      version: "0.86.1",
      models: [{ slug: "openrouter/anthropic/claude-sonnet-4" }],
    });
    expect(piRow?.props.setup).toBeNull();
  });

  it("opens the requested provider instance instead of the first provider", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
    };
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: customId });
    const editor = visitElements(panel, (element) => element.props.mode === "editor");
    expect(editor?.props.instanceId).toBe(customId);
  });

  it.each([
    ["onFavoriteModelsChange", { favorites: [{ provider: codexId, model: "chosen" }] }],
    [
      "onHiddenModelsChange",
      { providerModelPreferences: { [codexId]: { hiddenModels: ["chosen"], modelOrder: [] } } },
    ],
    [
      "onModelOrderChange",
      { providerModelPreferences: { [codexId]: { hiddenModels: [], modelOrder: ["chosen"] } } },
    ],
  ])("saves %s on this device without changing the selected server", (action, expected) => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    const editor = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "editor",
    );
    expect(editor).not.toBeNull();
    if (!editor) throw new Error("Provider editor was not rendered");
    (editor.props[action] as (models: string[]) => void)(["chosen"]);
    expect(settingsState.updateClientSettings).toHaveBeenCalledExactlyOnceWith(expected);
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("does not substitute another account when the requested instance was removed", () => {
    atoms.providers = [provider()];
    const panel = renderPanel({ targetInstanceId: customId });
    expect(visitElements(panel, (element) => element.props.mode === "editor")).toBeNull();
    expect(settingsState.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps provider selection available while write controls are read only", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    atoms.providers = [provider()];
    let panel = renderPanel({ readOnly: true });

    const inertWrapper = visitElements(panel, (element) => element.props.inert === true);
    expect(inertWrapper).not.toBeNull();

    const customRow = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "list",
    );
    expect(customRow?.props.readOnly).toBe(true);
    expect(customRow?.props.onSelect).toBeTypeOf("function");
    (customRow?.props.onSelect as (() => void) | undefined)?.();

    panel = renderPanel({ readOnly: true });
    const customEditor = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(customEditor).not.toBeNull();

    const notice = visitElements(panel, (element) => element.props.title === "Limited permissions");
    expect(notice).not.toBeNull();

    expect(visitElements(panel, isRefreshButton)).toBeNull();
    expect(visitElements(panel, isAddProviderButton)).toBeNull();
  });

  it("keeps the editable layout interactive when not read only", () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.inert === true)).toBeNull();
    expect(
      visitElements(panel, (element) => element.props.title === "Limited permissions"),
    ).toBeNull();
    expect(visitElements(panel, isRefreshButton)).not.toBeNull();
    expect(visitElements(panel, isAddProviderButton)).not.toBeNull();
  });

  it("keeps Advanced visible when search targets the provider health interval", () => {
    let panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.title === "Advanced")).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props.id === "provider-health-check-interval"),
    ).not.toBeNull();

    settingsSearchState.targetId = "provider-health-check-interval";
    panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.title === "Advanced")).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props.id === "provider-health-check-interval"),
    ).not.toBeNull();
  });

  it("deletes and resets provider configuration without erasing shared preferences", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
        },
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
      providerModelPreferences: {
        [customId]: { hiddenModels: ["hidden"], modelOrder: ["model"] },
      },
      favorites: [{ provider: customId, model: "favorite" }],
    };
    let panel = renderPanel();
    const customRow = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "list",
    );
    (customRow?.props.onSelect as (() => void) | undefined)?.();
    panel = renderPanel();
    const customCard = visitElements(
      panel,
      (element) => element.props.instanceId === customId && element.props.mode === "editor",
    );
    expect(customCard).not.toBeNull();
    (customCard?.props.onDelete as (() => void) | undefined)?.();

    expect(settingsState.updateSettings).toHaveBeenLastCalledWith({
      providerInstances: {
        [codexId]: settingsState.value.providerInstances?.[codexId],
      },
    });

    settingsState.updateSettings.mockClear();
    const defaultRow = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "list",
    );
    (defaultRow?.props.onSelect as (() => void) | undefined)?.();
    panel = renderPanel();
    const defaultCard = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "editor",
    );
    const resetAction = defaultCard?.props.headerAction;
    const resetButton = visitElements(
      resetAction,
      (element) => typeof element.props.onClick === "function",
    );
    expect(resetButton).not.toBeNull();
    (resetButton?.props.onClick as (() => void) | undefined)?.();

    const resetPatch = settingsState.updateSettings.mock.lastCall?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(Object.keys(resetPatch ?? {}).sort()).toEqual(["providerInstances", "providers"]);
    expect(resetPatch).not.toHaveProperty("favorites");
    expect(resetPatch).not.toHaveProperty("providerModelPreferences");
  });

  it("reports scoped refresh failure with a toast and clears pending", async () => {
    atoms.providers = [{ ...provider(), status: "error", message: "Probe failed." }];
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("scoped-refresh-failure");
    try {
      let resolveRefresh!: (value: unknown) => void;
      const gate = new Promise((resolve) => {
        resolveRefresh = resolve;
      });
      commands.refresh.mockReturnValueOnce(gate);

      let panel = renderPanel();
      const editor = visitElements(
        panel,
        (element) => element.props.instanceId === codexId && element.props.mode === "editor",
      );
      expect(typeof editor?.props.onRefresh).toBe("function");
      (editor?.props.onRefresh as (() => void) | undefined)?.();

      panel = renderPanel();
      const editorDuring = visitElements(
        panel,
        (element) => element.props.instanceId === codexId && element.props.mode === "editor",
      );
      expect(editorDuring?.props.isChecking).toBe(true);

      resolveRefresh(AsyncResult.failure(Cause.fail(new Error("refresh failed"))));
      await flushPromises();
      await flushPromises();

      expect(commands.refresh).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId: codexId, refreshModels: true },
      });
      expect(addToast).toHaveBeenCalledOnce();
      const toast = addToast.mock.calls[0]?.[0] as
        | { readonly title?: unknown; readonly description?: unknown }
        | undefined;
      expect(toast?.title).toBe("Could not refresh provider status");
      expect(String(toast?.description ?? "")).not.toContain("refresh failed");

      panel = renderPanel();
      const editorAfter = visitElements(
        panel,
        (element) => element.props.instanceId === codexId && element.props.mode === "editor",
      );
      expect(editorAfter?.props.isChecking).toBe(false);
    } finally {
      addToast.mockRestore();
    }
  });

  it("stays silent when a scoped refresh is interrupted", async () => {
    atoms.providers = [{ ...provider(), status: "error", message: "Probe failed." }];
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("scoped-refresh-interrupted");
    try {
      commands.refresh.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));

      const panel = renderPanel();
      const editor = visitElements(
        panel,
        (element) => element.props.instanceId === codexId && element.props.mode === "editor",
      );
      (editor?.props.onRefresh as (() => void) | undefined)?.();
      await flushPromises();
      await flushPromises();

      expect(commands.refresh).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId: codexId, refreshModels: true },
      });
      expect(addToast).not.toHaveBeenCalled();
    } finally {
      addToast.mockRestore();
    }
  });

  it("dedupes a double scoped refresh for the same environment and instance", async () => {
    atoms.providers = [{ ...provider(), status: "error", message: "Probe failed." }];
    const panel = renderPanel();
    const editor = visitElements(
      panel,
      (element) => element.props.instanceId === codexId && element.props.mode === "editor",
    );
    const onRefresh = editor?.props.onRefresh as (() => void) | undefined;
    expect(typeof onRefresh).toBe("function");
    onRefresh?.();
    onRefresh?.();
    await flushPromises();
    await flushPromises();

    expect(commands.refresh).toHaveBeenCalledTimes(1);
    expect(commands.refresh).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId: codexId, refreshModels: true },
    });

    // The guard releases after settle so an explicit retry still works.
    onRefresh?.();
    await flushPromises();
    await flushPromises();
    expect(commands.refresh).toHaveBeenCalledTimes(2);
  });

  it("drops a late scoped-refresh failure after the environment changes", async () => {
    atoms.providers = [{ ...provider(), status: "error", message: "Probe failed." }];
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("scoped-refresh-stale-env");
    try {
      let resolveRefresh!: (value: unknown) => void;
      const gate = new Promise((resolve) => {
        resolveRefresh = resolve;
      });
      commands.refresh.mockReturnValueOnce(gate);

      let panel = renderPanel();
      const editor = visitElements(
        panel,
        (element) => element.props.instanceId === codexId && element.props.mode === "editor",
      );
      (editor?.props.onRefresh as (() => void) | undefined)?.();

      const nextEnvironmentId = EnvironmentId.make("other-device");
      panel = renderPanel({ environmentId: nextEnvironmentId });
      // This lightweight harness records effects instead of running them.
      // Run the environment lifecycle setup that React executes after render.
      const environmentEffect = settingsSearchState.effects.at(-1);
      (environmentEffect as unknown as () => unknown)?.();
      const editorAfterSwitch = visitElements(
        panel,
        (element) => element.props.instanceId === codexId && element.props.mode === "editor",
      );
      // Keyed by environment+instance: the old flight never marks the new card Checking.
      expect(editorAfterSwitch?.props.isChecking).toBe(false);

      resolveRefresh(AsyncResult.failure(Cause.fail(new Error("refresh failed"))));
      await flushPromises();
      await flushPromises();

      expect(addToast).not.toHaveBeenCalled();
      panel = renderPanel({ environmentId: nextEnvironmentId });
      const editorLate = visitElements(
        panel,
        (element) => element.props.instanceId === codexId && element.props.mode === "editor",
      );
      expect(editorLate?.props.isChecking).toBe(false);
    } finally {
      addToast.mockRestore();
    }
  });

  it("drops a late scoped-refresh failure after unmount", async () => {
    atoms.providers = [{ ...provider(), status: "error", message: "Probe failed." }];
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("scoped-refresh-unmounted");
    try {
      let resolveRefresh!: (value: unknown) => void;
      const gate = new Promise((resolve) => {
        resolveRefresh = resolve;
      });
      commands.refresh.mockReturnValueOnce(gate);

      const panel = renderPanel();
      const editor = visitElements(
        panel,
        (element) => element.props.instanceId === codexId && element.props.mode === "editor",
      );
      (editor?.props.onRefresh as (() => void) | undefined)?.();

      // The harness collects effects instead of running them; invoking the
      // mount effect's cleanup simulates unmount.
      const mountEffect = settingsSearchState.effects.at(-1);
      const cleanup = (mountEffect as unknown as () => unknown)?.();
      (cleanup as (() => void) | undefined)?.();

      resolveRefresh(AsyncResult.failure(Cause.fail(new Error("refresh failed"))));
      await flushPromises();
      await flushPromises();

      expect(addToast).not.toHaveBeenCalled();
    } finally {
      addToast.mockRestore();
    }
  });
});
