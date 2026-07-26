import type { ScopedThreadRef, TurnId } from "@t3tools/contracts";

import { useDiffPanelStore } from "./diffPanelStore";
import { useRightPanelStore } from "./rightPanelStore";
import { resolvePathLinkTarget } from "./terminal-links";

interface OpenDiffFilePrimaryActionInput {
  readonly threadRef: ScopedThreadRef | null;
  readonly filePath: string;
  readonly activeCwd: string | undefined;
  readonly openInEditor: (targetPath: string) => void;
}

export function openDiffFilePrimaryAction({
  threadRef,
  filePath,
  activeCwd,
  openInEditor,
}: OpenDiffFilePrimaryActionInput): void {
  if (threadRef) {
    useRightPanelStore.getState().openFile(threadRef, filePath);
    return;
  }

  openInEditor(activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath);
}

interface OpenTurnDiffPrimaryActionInput {
  readonly threadRef: ScopedThreadRef;
  readonly turnId: TurnId;
  readonly filePath?: string;
  readonly planSidebarOpen: boolean;
  readonly dismissPlanSidebar: () => void;
}

export function openTurnDiffPrimaryAction({
  threadRef,
  turnId,
  filePath,
  planSidebarOpen,
  dismissPlanSidebar,
}: OpenTurnDiffPrimaryActionInput): void {
  if (planSidebarOpen) {
    dismissPlanSidebar();
  }
  useDiffPanelStore.getState().selectTurn(threadRef, turnId, filePath);
  useRightPanelStore.getState().open(threadRef, "diff");
}
