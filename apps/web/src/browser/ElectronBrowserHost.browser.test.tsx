import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type PreviewSessionSnapshot, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));

// This ordering regression runs with preview control granted on the environment.
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: (() => ({ resolvedTheme: "light" })) as never,
}));

vi.mock(import("./HostedBrowserWebview"), () => ({
  HostedBrowserWebview: (props: { readonly tabId: string }) => (
    <div data-preview-server-tab={props.tabId} />
  ),
}));

import { reconcilePreviewServerSessions, resetPreviewStateForTests } from "~/previewStateStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { ElectronBrowserHost } from "./ElectronBrowserHost";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-1"));

const snapshot = (tabId: string, updatedAt: string): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId,
  navStatus: { _tag: "Success", url: `https://example.com/${tabId}`, title: tabId },
  canGoBack: false,
  canGoForward: false,
  updatedAt,
});

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
  resetPreviewStateForTests();
  vi.unstubAllGlobals();
});

const renderedTabIds = () =>
  [...container.querySelectorAll("[data-preview-server-tab]")].map(
    (node) => node.getAttribute("data-preview-server-tab") ?? "",
  );

describe("ElectronBrowserHost", () => {
  it("keeps webview order when the server reorders tabs by last update", async () => {
    reconcilePreviewServerSessions(ref, {
      sessions: [
        snapshot("tab_7", "2026-01-01T00:00:01.000Z"),
        snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
      ],
      serverEpoch: "server-a",
      revision: 1,
    });
    await act(async () =>
      root.render(
        <AppAtomRegistryProvider>
          <ElectronBrowserHost />
        </AppAtomRegistryProvider>,
      ),
    );
    const initialOrder = renderedTabIds();

    await act(async () => {
      reconcilePreviewServerSessions(ref, {
        sessions: [
          snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
          snapshot("tab_7", "2026-01-01T00:00:03.000Z"),
        ],
        serverEpoch: "server-a",
        revision: 2,
      });
    });

    expect(initialOrder).toHaveLength(2);
    expect(renderedTabIds()).toEqual(initialOrder);
  });
});
