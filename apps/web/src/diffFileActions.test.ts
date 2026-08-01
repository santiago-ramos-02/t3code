import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "./diffPanelStore";
import { openDiffFilePrimaryAction, openTurnDiffPrimaryAction } from "./diffFileActions";
import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make("environment-local"),
  ThreadId.make("thread-1"),
);

describe("openDiffFilePrimaryAction", () => {
  beforeEach(() => {
    useRightPanelStore.setState({ byThreadKey: {} });
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      collapsedFileKeysByScope: {},
    });
  });

  it("opens diff files in the thread file viewer", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: THREAD_REF,
      filePath: "apps/web/src/components/DiffPanel.tsx",
      activeCwd: "/repo/project",
      openInEditor,
    });

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: "file:apps/web/src/components/DiffPanel.tsx",
    });
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("falls back to the editor without thread context", () => {
    const openInEditor = vi.fn();

    openDiffFilePrimaryAction({
      threadRef: null,
      filePath: "apps/web/src/components/DiffPanel.tsx",
      activeCwd: "/repo/project",
      openInEditor,
    });

    expect(openInEditor).toHaveBeenCalledWith(
      "/repo/project/apps/web/src/components/DiffPanel.tsx",
    );
  });
});

describe("openTurnDiffPrimaryAction", () => {
  beforeEach(() => {
    useRightPanelStore.setState({ byThreadKey: {} });
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      collapsedFileKeysByScope: {},
    });
  });

  it("dismisses an auto-open plan before activating the requested turn diff", () => {
    const dismissPlanSidebar = vi.fn();
    const turnId = TurnId.make("turn-1");
    useRightPanelStore.getState().open(THREAD_REF, "plan");

    openTurnDiffPrimaryAction({
      threadRef: THREAD_REF,
      turnId,
      filePath: "apps/web/src/components/DiffPanel.tsx",
      planSidebarOpen: true,
      dismissPlanSidebar,
    });

    expect(dismissPlanSidebar).toHaveBeenCalledOnce();
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: "diff",
    });
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({
      kind: "turn",
      turnId,
      filePath: "apps/web/src/components/DiffPanel.tsx",
    });
  });
});
