import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  providers: null as unknown as Atom.Writable<ReadonlyArray<ServerProvider>>,
  settings: null as unknown as UnifiedSettings,
  canManageProviders: true,
  canWriteSettings: true,
  searchTargetId: null as string | null,
  readEnvironmentIds: [] as string[],
  updateEnvironmentIds: [] as string[],
  mutationEnvironmentIds: [] as string[],
  refresh: vi.fn(),
  updateProvider: vi.fn(),
  uninstall: vi.fn(),
  acceptUrlAuth: vi.fn(),
  updateSettings: vi.fn(),
  updateModelPreferences: vi.fn(),
  toggleFavorite: vi.fn(),
  mutateProviderInstance: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const providers = Atom.make<ReadonlyArray<ServerProvider>>([]).pipe(Atom.keepAlive);
  state.providers = providers;
  const config = Atom.make(null);
  const commandLabels = {
    refreshProviders: "refresh",
    updateProvider: "update",
    uninstallAcpRegistryManagedBinary: "uninstall",
    acceptAcpRegistryUrlAuth: "accept-url-auth",
  } as const;
  const labelled = Object.fromEntries(
    Object.entries(commandLabels).map(([key, label]) => [
      key,
      { ...actual.serverEnvironment[key as keyof typeof commandLabels], label },
    ]),
  );
  return {
    ...actual,
    providersIgnoringCheckedAtAtom: (() => providers) as never,
    serverEnvironment: {
      ...actual.serverEnvironment,
      ...labelled,
      configValueAtom: (() => config) as never,
      providersValueAtom: (() => providers) as never,
    } as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) =>
    ({
      refresh: state.refresh,
      update: state.updateProvider,
      uninstall: state.uninstall,
      "accept-url-auth": state.acceptUrlAuth,
    })[command.label ?? ""] ?? vi.fn()) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((environmentId: string) => {
    state.readEnvironmentIds.push(environmentId);
    return state.settings;
  }) as never,
  useUpdateEnvironmentSettings: ((environmentId: string) => {
    state.updateEnvironmentIds.push(environmentId);
    return state.updateSettings;
  }) as never,
  useUpdateEnvironmentModelPreferences: (() => state.updateModelPreferences) as never,
  useToggleEnvironmentModelFavorite: (() => state.toggleFavorite) as never,
  usePersistEnvironmentProviderInstanceMutation: ((environmentId: string) => {
    state.mutationEnvironmentIds.push(environmentId);
    return state.mutateProviderInstance;
  }) as never,
}));
vi.mock(import("../../state/session"), async (original) => {
  const scope = (environmentId: string, requested: string) =>
    environmentId === "remote-device" &&
    (requested === "providers:manage"
      ? state.canManageProviders
      : requested === "settings:write"
        ? state.canWriteSettings
        : requested === "orchestration:read");
  return {
    ...(await original()),
    useEnvironmentScope: scope as never,
    readEnvironmentScope: scope as never,
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => []) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  useSettingsSearchTargetId: () => state.searchTargetId,
  // The real row reads write permission and overrides from live environment state.
  SettingsRow: (({
    id,
    title,
    description,
    status,
    control,
    children,
  }: {
    id?: string;
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div id={id}>
      <h4>{title}</h4>
      {description}
      {status}
      {control}
      {children}
    </div>
  )) as never,
}));
// Its own data flows are covered by its suite; this one is about the panel.
vi.mock(import("./UsageProviderSettings"), async (original) => ({
  ...(await original()),
  UsageProviderSettings: (() => null) as never,
}));
vi.mock(import("../ProviderUpdatesAction"), async (original) => ({
  ...(await original()),
  ProviderUpdatesAction: (() => null) as never,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { toastManager } from "../ui/toast";
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
    models: [{ slug: "chosen", name: "Chosen", isCustom: false, capabilities: null }],
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

const setProviders = (providers: ReadonlyArray<ServerProvider>) =>
  act(async () => appAtomRegistry.set(state.providers, providers));

function panel(options?: {
  readonly environmentId?: EnvironmentId;
  readonly readOnly?: boolean;
  readonly targetInstanceId?: ProviderInstanceId;
}) {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <div className="@container/providers">
        <EnvironmentProviderSettings
          environmentId={options?.environmentId ?? environmentId}
          environmentLabel="Remote device"
          {...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly })}
          {...(options?.targetInstanceId === undefined
            ? {}
            : { targetInstanceId: options.targetInstanceId })}
        />
      </div>
    </RegistryContext.Provider>
  );
}

// The section header and the end of the provider list both offer Add provider.

async function setup() {
  await page.viewport(1280, 900);
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  state.canManageProviders = true;
  state.canWriteSettings = true;
  state.searchTargetId = null;
  state.readEnvironmentIds = [];
  state.updateEnvironmentIds = [];
  state.mutationEnvironmentIds = [];
  state.updateSettings.mockReset();
  state.updateModelPreferences.mockReset();
  state.toggleFavorite.mockReset();
  state.mutateProviderInstance.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.refresh.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateProvider.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.uninstall.mockReset().mockResolvedValue(AsyncResult.success({}));
  state.acceptUrlAuth.mockReset().mockResolvedValue(AsyncResult.success({ accepted: true }));
  await setProviders([]);
}

describe("EnvironmentProviderSettings routing", () => {
  it("renders Pi through the generic local-binary provider card", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [piId]: {
          driver: ProviderDriverKind.make("pi"),
          enabled: true,
          config: { binaryPath: "/opt/pi/bin/pi" },
        },
      },
    };
    await setProviders([
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
    ]);
    await using screen = await render(panel({ targetInstanceId: piId }));

    await expect
      .element(page.getByRole("button", { name: "Select Pi", exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("v0.86.1").first()).toBeVisible();
    await expect.element(page.getByText("Claude Sonnet 4")).toBeVisible();
    expect(
      screen.container.querySelector<HTMLInputElement>("input[value='/opt/pi/bin/pi']"),
    ).not.toBeNull();
    // Pi has no driver-specific setup flow, unlike Antigravity.
    await expect.element(page.getByText(/Install and manage/)).not.toBeInTheDocument();
  });

  describe("scoped provider refresh", () => {
    const failedProbe = () => ({
      ...provider(),
      status: "error" as const,
      message: "Probe failed.",
    });
    const cardRefresh = () => page.getByRole("button", { name: "Refresh status", exact: true });
    const cardChecking = () => page.getByRole("button", { name: "Checking", exact: true });
    const scopedRefreshInput = { instanceId: codexId, refreshModels: true };

    const spyOnToasts = () => vi.spyOn(toastManager, "add").mockReturnValue("scoped-refresh-toast");

    /** Holds the next refresh open so the in-flight state can be observed. */
    function holdNextRefresh() {
      let settle!: (result: unknown) => void;
      state.refresh.mockReturnValueOnce(
        new Promise((resolve) => {
          settle = resolve;
        }),
      );
      return (result: unknown) => act(async () => settle(result));
    }

    it("reports scoped refresh failure with a toast and clears pending", async () => {
      await setup();
      using addToast = spyOnToasts();
      await setProviders([failedProbe()]);
      const settle = holdNextRefresh();
      await using _screen = await render(panel());

      await userEvent.click(cardRefresh());
      await expect.element(cardChecking()).toBeDisabled();
      expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: scopedRefreshInput,
      });

      await settle(AsyncResult.failure(Cause.fail(new Error("refresh failed"))));
      await expect.element(cardRefresh()).toBeEnabled();
      expect(addToast).toHaveBeenCalledOnce();
      const toast = addToast.mock.calls[0]?.[0];
      expect(toast?.title).toBe("Could not refresh provider status");
      expect(String(toast?.description ?? "")).not.toContain("refresh failed");
    });

    it("stays silent when a scoped refresh is interrupted", async () => {
      await setup();
      using addToast = spyOnToasts();
      await setProviders([failedProbe()]);
      const settle = holdNextRefresh();
      await using _screen = await render(panel());

      await userEvent.click(cardRefresh());
      await expect.element(cardChecking()).toBeDisabled();
      await settle(AsyncResult.failure(Cause.interrupt()));

      await expect.element(cardRefresh()).toBeEnabled();
      expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: scopedRefreshInput,
      });
      expect(addToast).not.toHaveBeenCalled();
    });

    it("dedupes a double scoped refresh for the same environment and instance", async () => {
      await setup();
      using _addToast = spyOnToasts();
      await setProviders([failedProbe()]);
      await using _screen = await render(panel());

      // Both clicks land before React re-renders the button as disabled.
      const retry = cardRefresh().element() as HTMLButtonElement;
      await act(async () => {
        retry.click();
        retry.click();
      });
      await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
      expect(state.refresh).toHaveBeenCalledWith({ environmentId, input: scopedRefreshInput });

      // The guard releases after settle so an explicit retry still works.
      await expect.element(cardRefresh()).toBeEnabled();
      await userEvent.click(cardRefresh());
      expect(state.refresh).toHaveBeenCalledTimes(2);
    });

    it("drops a late scoped-refresh failure after the environment changes", async () => {
      await setup();
      using addToast = spyOnToasts();
      await setProviders([failedProbe()]);
      const settle = holdNextRefresh();
      await using screen = await render(panel());
      await userEvent.click(cardRefresh());
      await expect.element(cardChecking()).toBeDisabled();

      await screen.rerender(panel({ environmentId: EnvironmentId.make("other-device") }));
      // Keyed by environment+instance: the old flight never marks the new card Checking.
      await expect.element(page.getByText("Checking provider status")).not.toBeInTheDocument();

      await settle(AsyncResult.failure(Cause.fail(new Error("refresh failed"))));
      expect(addToast).not.toHaveBeenCalled();
      await expect.element(page.getByText("Checking provider status")).not.toBeInTheDocument();
    });

    it("drops a late scoped-refresh failure after unmount", async () => {
      await setup();
      using addToast = spyOnToasts();
      await setProviders([failedProbe()]);
      const settle = holdNextRefresh();
      await using screen = await render(panel());
      await userEvent.click(cardRefresh());
      await expect.element(cardChecking()).toBeDisabled();

      await screen.unmount();
      await settle(AsyncResult.failure(Cause.fail(new Error("refresh failed"))));

      expect(addToast).not.toHaveBeenCalled();
    });
  });

  it("does not substitute another account when the requested instance was removed", async () => {
    await setup();
    await setProviders([provider()]);
    await using _screen = await render(panel({ targetInstanceId: customId }));
    await expect
      .element(page.getByText("This provider instance is no longer available on this device."))
      .toBeVisible();
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("updates one provider instance without sending a stale whole map", async () => {
    await setup();
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Work",
        },
      },
    };
    await using _screen = await render(panel());
    await userEvent.click(page.getByRole("switch", { name: "Enable Work" }).first());

    expect(state.mutateProviderInstance).toHaveBeenCalledWith(
      {
        operation: "upsert",
        instanceId: customId,
        instance: { driver: ProviderDriverKind.make("codex"), enabled: false, displayName: "Work" },
      },
      {},
    );
  });

  it("routes explicit ACP browser authentication consent to the selected environment", async () => {
    await setup();
    const instanceId = ProviderInstanceId.make("acpRegistry_antigravity");
    const action = {
      elicitationId: "google-login-1",
      url: "https://accounts.google.com/login",
      message: "Continue with Google",
    };
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: { agentId: "antigravity" },
        },
      },
    };
    await setProviders([
      {
        ...provider(),
        instanceId,
        driver: ProviderDriverKind.make("acpRegistry"),
        auth: { status: "unauthenticated", action },
      },
    ]);
    await using _screen = await render(panel({ targetInstanceId: instanceId }));
    const link = page.getByRole("link", { name: "Continue authentication" });
    link.element().addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(link);

    expect(state.acceptUrlAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, elicitationId: action.elicitationId },
    });
  });
});
