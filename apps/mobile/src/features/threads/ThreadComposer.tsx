import type { ComposerTextPaste } from "../../native/T3ComposerEditor.types";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { gentleComposerAction } from "@t3tools/client-runtime/piGentleComposer";
import { resolveProviderSlashCommandsForCwd } from "@t3tools/client-runtime/providerSkills";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import type { PiGentleComposerState } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { pastedTextDisposition, replaceTextSelection } from "@t3tools/client-runtime/text-paste";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type OrchestrationThreadShell,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerConfig as T3ServerConfig,
  type UsageLimitsReport,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  hasProviderUsageLimits,
  isUsageLimitsCommand,
} from "@t3tools/shared/usageLimits";
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  View,
  type ViewStyle,
} from "react-native";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
  composerAttachmentUploadsAtom,
} from "../../state/composer-attachment-uploads";
import Animated, {
  FadeIn,
  FadeOut,
  type LayoutAnimationFunction,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { armAgentAwarenessLiveActivityForLocalWork } from "../agent-awareness/remoteRegistration";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  composerContextImportsAtom,
  countComposerDraftAttachmentsAfterSelection,
} from "../../state/use-composer-drafts";
import type { ComposerDocumentAttachment } from "../../lib/composerContext";
import { useProject } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ComposerAttachmentButton } from "../../components/ComposerAttachmentButton";
import { ControlPillMenu } from "../../components/ControlPill";
import {
  ComposerAttachmentStrip,
  ComposerAttachmentThumbnail,
} from "../../components/ComposerAttachmentStrip";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { GlassSurface } from "../../components/GlassSurface";
import { ComposerEditor, type ComposerEditorHandle } from "../../components/ComposerEditor";
import { fileRoutePathSegments } from "../files/filePath";
import {
  ComposerActionButton,
  ComposerInlineControl,
  ComposerToolbarRow,
} from "../../components/ComposerToolbar";
import { ProviderIcon } from "../../components/ProviderIcon";
import {
  composerStripAttachments,
  type DraftComposerAttachment,
  type DraftComposerFileAttachment,
} from "../../lib/composerImages";
import {
  buildModelOptions,
  groupByProvider,
  isModelSelectionUnavailable,
} from "../../lib/modelOptions";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import type { RemoteClientConnectionState } from "../../lib/connection";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { ComposerCommandPopover } from "./ComposerCommandPopover";
import { useComposerCommandMenu } from "./use-composer-command-menu";
import {
  ComposerDictationCancelAction,
  ComposerDictationDraftContent,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import {
  type ExistingThreadSettingsRouteSession,
  useExistingThreadSettingsRoutePresentation,
} from "./ThreadSettingsSheet";
import {
  useThreadSettingsSheetPresentation,
  type NavigationWithFinishTransitioning,
} from "./use-thread-settings-sheet-presentation";

/**
 * Height of the collapsed composer (pill + vertical padding, excluding safe-area inset).
 * Exported so the parent can compute feed overlap / content insets.
 */
export const COMPOSER_COLLAPSED_CHROME = 60;

/**
 * Height of the expanded composer (card + toolbar + vertical padding, excluding safe-area inset).
 * Used by the parent to compute the larger feed bottom inset when the composer is focused.
 */
export const COMPOSER_EXPANDED_CHROME = 156;

export interface ThreadComposerProps {
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerAttachment>;
  readonly placeholder: string;
  readonly contentMaxWidth?: number;
  readonly bottomInset?: number;
  readonly connectionState: RemoteClientConnectionState;
  readonly environmentLabel: string | null;
  readonly selectedThread: OrchestrationThreadShell;
  readonly hasCompactableConversation: boolean;
  readonly serverConfig: T3ServerConfig | null;
  readonly queueCount: number;
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string | null;
  /** Why sending is blocked right now (shown as the send button's label), or null. */
  readonly sendBlockedReason?: string | null;
  readonly editorRef?: RefObject<ComposerEditorHandle | null>;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftMedia: () => Promise<void>;
  readonly onPickDraftFiles: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onNativePasteText: (paste: ComposerTextPaste) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  readonly onSendMessage: (directGentlePrompt?: string) => Promise<MessageId | null>;
  /** `/usage-limits` resolves locally; the host decides where the report shows. Null clears it. */
  readonly onShowUsageLimits: (report: UsageLimitsReport | null) => void;
  readonly onUpdateModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateInteractionMode: (interactionMode: ProviderInteractionMode) => void;
  readonly onExpandedChange?: (expanded: boolean) => void;
  readonly onGentleControlsVisibilityChange?: (visible: boolean) => void;
  /** Fires on editor focus/blur; hosts use it to vet stale keyboard state. */
  readonly onEditorFocusChange?: (focused: boolean) => void;
}

/**
 * The pill / card container — renders with Expo's native GlassView on supported
 * iOS 26+ devices, with a frosted blur fallback where supported.
 * Exported so NewTaskDraftScreen can render the same composer chrome.
 */
// The bottom-anchored dock position and clipped surface height use the same
// transition so the card grows upward without exposing its final-size content.
// Android gets NO layout transition: the composer rides the keyboard via
// KeyboardStickyView (frame-synced to the IME), and a time-based morph
// running alongside that translate reads as jitter. Snapping the layout and
// letting the keyboard-synced slide be the only motion looks native there.
export const COMPOSER_TRANSITION_DURATION_MS = 220;
// Side panes already animate the dock's width. Nested horizontal layout
// transitions would leave the surface trailing its toolbar's new position.
// Keep the vertical pill/card morph while horizontal layout follows the dock.
const composerHeightTransition: LayoutAnimationFunction = (values) => {
  "worklet";
  const timing = {
    duration: COMPOSER_TRANSITION_DURATION_MS,
    reduceMotion: ReduceMotion.System,
  };
  return {
    initialValues: {
      originX: values.targetOriginX,
      originY: values.currentOriginY,
      width: values.targetWidth,
      height: values.currentHeight,
    },
    animations: {
      originX: values.targetOriginX,
      originY: withTiming(values.targetOriginY, timing),
      width: values.targetWidth,
      height: withTiming(values.targetHeight, timing),
    },
  };
};
export const COMPOSER_LAYOUT_TRANSITION =
  Platform.OS === "android" ? undefined : composerHeightTransition;

const COMPOSER_ATTACHMENT_ENTERING =
  Platform.OS === "android"
    ? FadeIn.duration(160)
    : FadeIn.delay(COMPOSER_TRANSITION_DURATION_MS).duration(160).reduceMotion(ReduceMotion.System);

const AnimatedGlassSurface = Animated.createAnimatedComponent(GlassSurface);

export function ComposerSurface(props: {
  readonly children: ReactNode;
  readonly style: ViewStyle;
  /** Morphs between the compact and expanded composer layouts. */
  readonly animateLayout?: boolean;
}) {
  const colors = useUniwindTheme();
  const targetBorderRadius =
    typeof props.style.borderRadius === "number" ? props.style.borderRadius : 0;
  const animatedBorderRadius = useSharedValue(targetBorderRadius);
  const shouldAnimate = props.animateLayout !== false && Platform.OS !== "android";
  useLayoutEffect(() => {
    animatedBorderRadius.value = shouldAnimate
      ? withTiming(targetBorderRadius, {
          duration: COMPOSER_TRANSITION_DURATION_MS,
          reduceMotion: ReduceMotion.System,
        })
      : targetBorderRadius;
  }, [animatedBorderRadius, shouldAnimate, targetBorderRadius]);
  const animatedShapeStyle = useAnimatedStyle(() => ({
    borderRadius: animatedBorderRadius.value,
  }));
  const layoutTransition = shouldAnimate ? COMPOSER_LAYOUT_TRANSITION : undefined;

  // Each native frame follows the same transition. Animating only the outer
  // clip leaves the glass and content at their final height on the first frame.
  return (
    <Animated.View
      className={
        Platform.OS === "android" ? undefined : "shadow-[0_6px_28px] shadow-adaptive-black-a15-a35"
      }
      layout={layoutTransition}
      style={[
        animatedShapeStyle,
        {
          overflow: "hidden",
        },
      ]}
    >
      <AnimatedGlassSurface
        chrome="none"
        fallbackColor={colors["--color-composer-surface"]}
        fallbackClassName="border border-composer-border"
        glassEffectStyle="regular"
        // The composer is a passive material containing interactive controls.
        // Keep native glass out of the interactive content's layout path.
        pointerEvents="none"
        tintColor="transparent"
        layout={layoutTransition}
        style={[{ position: "absolute", inset: 0 }, animatedShapeStyle]}
      >
        {null}
      </AnimatedGlassSurface>
      <Animated.View
        collapsable={false}
        layout={layoutTransition}
        style={[props.style, animatedShapeStyle]}
      >
        {props.children}
      </Animated.View>
    </Animated.View>
  );
}

export const ThreadComposer = memo(function ThreadComposer(props: ThreadComposerProps) {
  const project = useProject(scopeProjectRef(props.environmentId, props.selectedThread.projectId));
  const { themeVariables: materialTheme } = useAppearancePreferences();
  const composerPanel = materialTheme["--color-composer-panel"];
  const navigation = useNavigation();
  const foregroundColor = useUniwindTheme()["--color-foreground"];
  const bodyText = useScaledTextRole("body");
  const fallbackInputRef = useRef<ComposerEditorHandle>(null);
  const inputRef = props.editorRef ?? fallbackInputRef;
  const [isFocused, setIsFocused] = useState(false);
  const pendingPastedTextAttachmentCountRef = useRef(0);
  const [pendingPastedTextAttachmentCount, setPendingPastedTextAttachmentCount] = useState(0);
  const settingsSheetPresentation = useThreadSettingsSheetPresentation({
    editorRef: inputRef,
    isEditorFocused: isFocused,
  });
  const settingsRoutePresentation = useExistingThreadSettingsRoutePresentation();
  const settingsRoutePresentedRef = useRef(false);
  const wasExpandedBeforePreviewRef = useRef(false);
  const inFlightThreadIdsRef = useRef(new Set<string>());
  const { onExpandedChange } = props;

  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const [previewVideo, setPreviewVideo] = useState<VideoPreviewSource | null>(null);
  const hasContent = props.draftMessage.trim().length > 0 || props.draftAttachments.length > 0;
  // Only media belongs above the composer; every other file reads as its inline chip.
  const stripAttachments = useMemo(
    () => composerStripAttachments(props.draftAttachments),
    [props.draftAttachments],
  );
  const showStopAction =
    !hasContent &&
    (props.selectedThread.session?.status === "running" ||
      props.selectedThread.session?.status === "starting");

  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  const attachmentsUploading =
    props.connectionState === "connected" &&
    composerAttachmentsStillUploading({
      environmentId: props.environmentId,
      attachments: props.draftAttachments,
      serverConfig: props.serverConfig,
      states: uploadStates,
    });
  // Every send goes through the outbox; the label says whether it leaves now
  // or waits (for the connection, an earlier queued message, or an upload).
  const sendLabel =
    props.connectionState !== "connected" || props.queueCount > 0 || attachmentsUploading
      ? "Queue"
      : "Send";
  const currentModelSelection = props.selectedThread.modelSelection;
  const currentRuntimeMode = props.selectedThread.runtimeMode;
  const modelUnavailable =
    props.connectionState === "connected" &&
    isModelSelectionUnavailable(props.serverConfig, currentModelSelection);
  const selectedProviderStatus = useMemo(() => {
    if (!props.serverConfig) return null;
    return (
      props.serverConfig.providers.find(
        (p) => p.instanceId === props.selectedThread.modelSelection.instanceId,
      ) ?? null
    );
  }, [props.serverConfig, props.selectedThread.modelSelection.instanceId]);
  const gentleCommands =
    selectedProviderStatus?.driver === "pi" && props.projectCwd !== null
      ? resolveProviderSlashCommandsForCwd(selectedProviderStatus, props.projectCwd)
      : [];
  const gentleAvailable = gentleCommands.some((command) => command.name === "gentle:sdd-preflight");
  const canInitializeGentle = gentleCommands.some((command) => command.name === "gentle-sdd-init");
  const canRunGentleDoctor = gentleCommands.some((command) => command.name === "gentle:doctor");
  const gentleKey = `${props.environmentId}:${props.selectedThread.id}:${props.selectedThread.latestTurn?.turnId ?? ""}:${currentModelSelection.instanceId}:${props.projectCwd ?? ""}`;
  const readGentle = useAtomCommand(serverEnvironment.readPiGentleComposer, {
    reportFailure: false,
    reportDefect: false,
  });
  const [gentleLoaded, setGentleLoaded] = useState<{
    key: string;
    value: PiGentleComposerState;
  } | null>(null);
  const [gentleError, setGentleError] = useState<{ key: string; message: string } | null>(null);
  const [gentleRefresh, setGentleRefresh] = useState(0);
  const [newChangeOpen, setNewChangeOpen] = useState(false);
  const [newChangeGoal, setNewChangeGoal] = useState("");
  const gentleIdle =
    props.connectionState === "connected" &&
    props.queueCount === 0 &&
    !props.selectedThread.hasPendingApprovals &&
    !props.selectedThread.hasPendingUserInput &&
    props.selectedThread.session?.status !== "running" &&
    props.selectedThread.session?.status !== "starting";
  useEffect(() => {
    if (!gentleAvailable || !gentleIdle || props.projectCwd === null) return;
    let current = true;
    void readGentle({
      environmentId: props.environmentId,
      input: { instanceId: currentModelSelection.instanceId, cwd: props.projectCwd },
    }).then((result) => {
      if (!current) return;
      if (result._tag === "Success") {
        setGentleLoaded({ key: gentleKey, value: result.value });
        setGentleError(null);
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setGentleLoaded(null);
        setGentleError({
          key: gentleKey,
          message: failure instanceof Error ? failure.message : "Could not read Gentle AI status.",
        });
      }
    });
    return () => {
      current = false;
    };
  }, [
    currentModelSelection.instanceId,
    gentleAvailable,
    gentleIdle,
    gentleKey,
    gentleRefresh,
    props.environmentId,
    props.projectCwd,
    readGentle,
  ]);
  const gentleStatus = gentleLoaded?.key === gentleKey ? gentleLoaded.value.sddStatus : null;
  const gentleAction =
    gentleLoaded?.key === gentleKey
      ? gentleComposerAction(gentleLoaded.value, canInitializeGentle)
      : null;
  const showGentleControls =
    gentleAvailable &&
    gentleIdle &&
    ((gentleLoaded?.key === gentleKey && gentleLoaded.value.available) ||
      gentleError?.key === gentleKey);
  const showGentleStatus = () => {
    const details = gentleStatus
      ? [
          `Change: ${gentleStatus.changeName ?? "No active change"}`,
          `Next step: ${gentleAction?.label ?? gentleStatus.nextRecommended}`,
          ...(gentleAction?.reason ? [gentleAction.reason] : []),
          ...(gentleStatus.taskProgress.total > 0
            ? [
                `Tasks: ${gentleStatus.taskProgress.completed} of ${gentleStatus.taskProgress.total} complete`,
              ]
            : []),
          ...(gentleStatus.nextRecommended === "sdd-new" ||
          gentleStatus.nextRecommended === "archived"
            ? []
            : gentleStatus.blockedReasons),
        ].join("\n")
      : gentleError?.key === gentleKey
        ? gentleError.message
        : "SDD status is unavailable from this Gentle AI installation.";
    Alert.alert("Gentle SDD status", details);
  };
  const gentleMenuActions: MenuAction[] = [
    { id: "status", title: "View SDD status", image: "doc.text" },
    {
      id: "choices",
      title:
        gentleLoaded?.key === gentleKey && gentleLoaded.value.projectInitNeeded
          ? "Choose SDD preferences"
          : "Change SDD preferences",
      image: "slider.horizontal.3",
    },
    ...(canRunGentleDoctor && (gentleStatus === null || gentleError?.key === gentleKey)
      ? [
          {
            id: "doctor",
            title: "Run Gentle doctor",
            image: "stethoscope",
          },
        ]
      : []),
    { id: "refresh", title: "Refresh status", image: "arrow.clockwise" },
  ];
  const composerOwnerKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
  const openDraftDocument = (attachment: ComposerDocumentAttachment) => {
    Keyboard.dismiss();
    navigation.navigate("ThreadAttachment", {
      environmentId: String(props.environmentId),
      threadId: String(props.selectedThread.id),
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: String(attachment.sizeBytes),
      draftKey: composerOwnerKey,
    });
  };
  const { onSendMessage, onChangeDraftMessage, onShowUsageLimits } = props;
  // T3 owns /usage-limits only where Limits has data for the selected provider;
  // elsewhere the name stays the provider's own and is sent through untouched.
  const usageLimitsOffered =
    selectedProviderStatus !== null &&
    hasProviderUsageLimits(
      selectedProviderStatus.driver,
      props.serverConfig?.providers ?? [],
      props.serverConfig?.usageLimitSources ?? [],
    );
  // Answered locally from the last Limits snapshot; the agent never sees it.
  const openUsageLimits = useCallback(() => {
    const report = collectProviderUsageLimits(
      currentModelSelection.instanceId,
      props.serverConfig?.providers ?? [],
      props.serverConfig?.usageLimitSources ?? [],
      Date.now(),
    );
    onShowUsageLimits(report);
    if (!report) {
      Alert.alert("Usage limits unavailable", "This provider does not currently report limits.");
    }
    return report !== null;
  }, [currentModelSelection.instanceId, onShowUsageLimits, props.serverConfig]);

  const composerMenu = useComposerCommandMenu({
    draftMessage: props.draftMessage,
    ownerKey: composerOwnerKey,
    environmentId: props.environmentId,
    projectCwd: props.projectCwd,
    pullRequestProjectId: props.serverConfig?.environment.capabilities.pullRequests
      ? (project?.id ?? null)
      : null,
    pullRequestRepository: project?.repositoryIdentity?.displayName ?? null,
    selectedProviderStatus,
    hasThread: true,
    hasCompactableConversation: props.hasCompactableConversation,
    onChangeDraftMessage: props.onChangeDraftMessage,
    onUpdateInteractionMode:
      selectedProviderStatus?.showInteractionModeToggle === false
        ? undefined
        : props.onUpdateInteractionMode,
    offersUsageLimits: usageLimitsOffered,
    // With attachments aboard the pick just inserts the text, so it sends as a prompt.
    onUsageLimits:
      usageLimitsOffered && props.draftAttachments.length === 0 ? openUsageLimits : undefined,
  });
  const voiceInput = useVoiceInputController({
    ownerKey: composerOwnerKey,
    draftMessage: props.draftMessage,
    selection: composerMenu.selection,
    onChangeDraftMessage: props.onChangeDraftMessage,
    onChangeSelection: composerMenu.onSelectionChange,
  });
  const voicePresentation = resolveVoiceComposerPresentation(
    voiceInput.state,
    voiceInput.elapsedSeconds,
  );
  const isVoiceInputPresented = voicePresentation.statusLabel !== null;
  // An open draft stays visible; only a collapsed composer becomes a voice strip.
  const isExpanded = isFocused || settingsSheetPresentation.keepsComposerExpanded;
  const gentleControlsVisible = isExpanded && showGentleControls && !voiceInput.isBusy;
  const { onGentleControlsVisibilityChange } = props;
  useEffect(() => {
    onGentleControlsVisibilityChange?.(gentleControlsVisible);
    return () => onGentleControlsVisibilityChange?.(false);
  }, [gentleControlsVisible, onGentleControlsVisibilityChange]);
  const showsCompactDictation = isVoiceInputPresented && !isExpanded;
  const isToolbarVisible = isExpanded || isVoiceInputPresented;
  const attachmentBlockReason = composerAttachmentUploadBlockReason({
    environmentId: props.environmentId,
    attachments: props.draftAttachments,
    connected: props.connectionState === "connected",
    serverConfig: props.serverConfig,
    states: uploadStates,
  });
  const contextImports = useAtomValue(composerContextImportsAtom);
  const sendBlockedReason =
    props.sendBlockedReason ??
    (pendingPastedTextAttachmentCount > 0 ? "Attaching pasted text" : null) ??
    attachmentBlockReason;
  const canSend =
    hasContent &&
    !contextImports[composerOwnerKey] &&
    !voiceInput.blocksSubmission &&
    sendBlockedReason === null &&
    !modelUnavailable;

  // Keep the feed inset aligned with the card or compact dictation strip.
  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  const onPressPreview = useCallback(
    (source: FilePreviewSource) => {
      wasExpandedBeforePreviewRef.current = isFocused;
      setPreviewVideo(null);
      setPreviewFile((current) => current ?? source);
    },
    [isFocused],
  );

  const closePreview = useCallback(() => {
    setPreviewFile(null);
    setPreviewVideo(null);
    if (wasExpandedBeforePreviewRef.current) {
      setTimeout(() => {
        if (navigation.isFocused()) inputRef.current?.focus();
      }, 100);
    }
  }, [inputRef, navigation]);

  const onPressVideo = useCallback(
    (attachment: DraftComposerFileAttachment, sourceIdentifier: string) => {
      wasExpandedBeforePreviewRef.current = isFocused;
      setPreviewFile(null);
      setPreviewVideo((current) => current ?? { type: "local", attachment, sourceIdentifier });
    },
    [isFocused],
  );

  const onEditorFocusChange = props.onEditorFocusChange;
  const handleFocus = useCallback(() => {
    setIsFocused(true);
    onExpandedChange?.(true);
    onEditorFocusChange?.(true);
  }, [onEditorFocusChange, onExpandedChange]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    if (!settingsSheetPresentation.keepsComposerExpanded) {
      onExpandedChange?.(false);
    }
    onEditorFocusChange?.(false);
  }, [onEditorFocusChange, onExpandedChange, settingsSheetPresentation.keepsComposerExpanded]);
  const handleSend = useCallback(
    async (directGentlePrompt?: string) => {
      if (voiceInput.blocksSubmission || pendingPastedTextAttachmentCountRef.current > 0) return;
      // Typed out in full rather than picked from the menu. Attachments mean the
      // user is sending a prompt, so those go through as usual.
      if (
        !directGentlePrompt &&
        usageLimitsOffered &&
        isUsageLimitsCommand(props.draftMessage) &&
        props.draftAttachments.length === 0
      ) {
        if (openUsageLimits()) onChangeDraftMessage("");
        return;
      }
      const threadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
      if (inFlightThreadIdsRef.current.has(threadKey)) return;
      inFlightThreadIdsRef.current.add(threadKey);
      try {
        const messageId = await onSendMessage(directGentlePrompt);
        if (messageId === null) {
          return;
        }
        // Sending a prompt starts agent work: arm the lock-screen card while the
        // app is foregrounded and the activity token can be registered. Armed
        // after the send so its preference read and native Activity start don't
        // contend with the queued-message feedback on the tap frame.
        armAgentAwarenessLiveActivityForLocalWork({
          environmentId: props.environmentId,
          threadTitle: props.selectedThread.title,
          projectTitle: props.environmentLabel ?? "T3 Code",
        });
        return messageId;
      } finally {
        inFlightThreadIdsRef.current.delete(threadKey);
      }
    },
    [
      props.draftMessage,
      props.draftAttachments.length,
      onChangeDraftMessage,
      openUsageLimits,
      usageLimitsOffered,
      onSendMessage,
      props.environmentId,
      props.environmentLabel,
      props.selectedThread.id,
      props.selectedThread.title,
      voiceInput.blocksSubmission,
    ],
  );

  // ── Model menu ───────────────────────────────────────────
  const modelOptions = useMemo(
    () => buildModelOptions(props.serverConfig, currentModelSelection, props.projectCwd),
    [props.serverConfig, currentModelSelection, props.projectCwd],
  );
  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);
  // An existing thread is bound to its harness: sessions can't move between
  // provider instances, so the picker only offers the thread's own group.
  const threadProviderGroups = useMemo(
    () => providerGroups.filter((group) => group.providerKey === currentModelSelection.instanceId),
    [providerGroups, currentModelSelection.instanceId],
  );
  const currentModelOption =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === currentModelSelection.instanceId &&
        option.selection.model === currentModelSelection.model,
    ) ?? null;
  const providerOptionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: currentModelOption?.capabilities,
        selections: currentModelSelection.options,
      }),
    [currentModelOption?.capabilities, currentModelSelection.options],
  );
  const settingsOwnerId = composerOwnerKey;
  const settingsRouteSession = useMemo<ExistingThreadSettingsRouteSession>(
    () => ({
      ownerId: settingsOwnerId,
      environmentId: props.environmentId,
      providerInstanceId: currentModelSelection.instanceId,
      providerGroups: threadProviderGroups,
      selectedModel: currentModelSelection,
      onSelectModel: (option) => props.onUpdateModelSelection(option.selection),
      optionDescriptors: providerOptionDescriptors,
      onUpdateOptionSelections: (options) =>
        props.onUpdateModelSelection({ ...currentModelSelection, options }),
      runtimeMode: currentRuntimeMode,
      onUpdateRuntimeMode: props.onUpdateRuntimeMode,
    }),
    [
      currentModelSelection,
      currentRuntimeMode,
      props.onUpdateModelSelection,
      props.onUpdateRuntimeMode,
      providerOptionDescriptors,
      settingsOwnerId,
      threadProviderGroups,
    ],
  );
  const openSettings = useCallback(() => {
    settingsRoutePresentation.present(settingsRouteSession);
    settingsSheetPresentation.open();
  }, [settingsRoutePresentation.present, settingsRouteSession, settingsSheetPresentation.open]);

  useEffect(() => {
    if (settingsSheetPresentation.isActive) {
      settingsRoutePresentation.present(settingsRouteSession);
    }
  }, [settingsRoutePresentation.present, settingsRouteSession, settingsSheetPresentation.isActive]);

  useEffect(() => {
    if (!settingsSheetPresentation.isVisible || settingsRoutePresentedRef.current) {
      return;
    }

    settingsRoutePresentedRef.current = true;
    navigation.dispatch(StackActions.push("ThreadSettingsSheet"));
  }, [navigation, settingsSheetPresentation.isVisible]);

  useFocusEffect(
    useCallback(() => {
      if (!settingsRoutePresentedRef.current) {
        return;
      }

      settingsRoutePresentedRef.current = false;
      settingsSheetPresentation.onDismissed();
      settingsRoutePresentation.clear(settingsOwnerId);
    }, [settingsOwnerId, settingsRoutePresentation.clear, settingsSheetPresentation.onDismissed]),
  );

  useEffect(
    () =>
      // UIKit's completion callback for the sheet dismissal, surfaced by the
      // native-stack patch. This is when the queued keyboard restore runs.
      (navigation as unknown as NavigationWithFinishTransitioning).addListener(
        "finishTransitioning",
        settingsSheetPresentation.onStackTransitionsFinished,
      ),
    [navigation, settingsSheetPresentation.onStackTransitionsFinished],
  );

  return (
    <Animated.View
      className="px-[12px]"
      style={{
        paddingTop: isExpanded ? 8 : 6,
        paddingBottom: (props.bottomInset ?? 0) + (isExpanded ? 8 : 6),
        backgroundColor:
          Platform.OS === "android" ? themeColorWithAlpha(composerPanel, 1) : undefined,
      }}
    >
      {/* The backdrop gradient lives on a plain View: Reanimated's Animated.View
          silently drops experimental_backgroundImage on Android, which left this
          strip fully transparent and the feed text legible through the composer. */}
      <View
        className={
          Platform.OS === "android"
            ? "hidden"
            : "absolute inset-0 bg-linear-to-b from-screen/0 via-screen/60 to-screen/90"
        }
        pointerEvents="none"
      />
      <Animated.View
        className="relative w-full self-center"
        style={{ maxWidth: props.contentMaxWidth }}
      >
        {!voiceInput.isBusy &&
        composerMenu.trigger &&
        (composerMenu.items.length > 0 || composerMenu.trigger.kind === "pull-request") ? (
          <View className="absolute inset-x-0 bottom-full z-10 mb-2">
            <ComposerCommandPopover
              items={composerMenu.items}
              triggerKind={composerMenu.trigger.kind}
              isLoading={composerMenu.isLoading}
              error={composerMenu.error}
              onSelect={composerMenu.onSelect}
            />
          </View>
        ) : null}

        {selectedProviderStatus?.compatibilityAdvisory?.message &&
        (selectedProviderStatus.compatibilityAdvisory.status === "unsupported" ||
          selectedProviderStatus.compatibilityAdvisory.status === "broken") ? (
          <Text
            accessibilityRole={
              selectedProviderStatus.compatibilityAdvisory.status === "broken" ? "alert" : undefined
            }
            accessibilityLiveRegion={
              selectedProviderStatus.compatibilityAdvisory.status === "broken"
                ? "assertive"
                : "polite"
            }
            className="px-3 py-2 text-xs text-foreground"
          >
            {selectedProviderStatus.compatibilityAdvisory.message}
          </Text>
        ) : null}
        {modelUnavailable ? (
          <Pressable accessibilityRole="button" className="px-3 py-2" onPress={openSettings}>
            <Text className="text-xs text-foreground">Model unavailable. Open model settings.</Text>
          </Pressable>
        ) : null}

        {gentleControlsVisible ? (
          <View className="flex-row items-center justify-end gap-1 px-2 pb-1">
            {gentleAction ? (
              <ComposerInlineControl
                icon={
                  gentleAction.kind === "setup"
                    ? "hammer"
                    : gentleAction.kind === "start"
                      ? "plus"
                      : gentleAction.kind === "continue"
                        ? "doc.text"
                        : gentleAction.kind === "select-change"
                          ? "magnifyingglass"
                          : "exclamationmark.circle"
                }
                label={gentleAction.label}
                maxWidth={220}
                showChevron={false}
                onPress={() => {
                  if (gentleAction.kind === "start") setNewChangeOpen(true);
                  else if (gentleAction.prompt === null) showGentleStatus();
                  else void handleSend(gentleAction.prompt);
                }}
              />
            ) : null}
            <ControlPillMenu
              actions={gentleMenuActions}
              onPressAction={({ nativeEvent }) => {
                if (nativeEvent.event === "status") showGentleStatus();
                if (nativeEvent.event === "choices")
                  void handleSend("/gentle:sdd-preflight --edit");
                if (nativeEvent.event === "doctor") void handleSend("/gentle:doctor");
                if (nativeEvent.event === "refresh") setGentleRefresh((value) => value + 1);
              }}
            >
              <ComposerInlineControl label="Gentle AI" maxWidth={105} />
            </ControlPillMenu>
          </View>
        ) : null}

        <ComposerSurface
          style={
            isExpanded
              ? {
                  borderRadius: 26,
                  minHeight: 140,
                  overflow: "hidden" as const,
                  paddingBottom: 6,
                  paddingTop: 14,
                }
              : {
                  // Keep the numeric radius close to the expanded card so the
                  // shape morph stays bounded while rendering as a capsule.
                  borderRadius: 27,
                  overflow: "hidden" as const,
                  paddingVertical: 2,
                }
          }
        >
          <ComposerDictationDraftContent
            className={isExpanded ? undefined : "flex-row items-center"}
            compact={!isExpanded}
            hidden={showsCompactDictation}
          >
            {!isExpanded ? (
              <ComposerAttachmentButton
                supportsFiles={Boolean(
                  props.serverConfig?.environment.capabilities.fileAttachments,
                )}
                onPickMedia={props.onPickDraftMedia}
                onPickFiles={props.onPickDraftFiles}
              />
            ) : null}
            {isExpanded && stripAttachments.length > 0 ? (
              <Animated.View
                className="px-[14px] pb-2.5"
                entering={COMPOSER_ATTACHMENT_ENTERING}
                exiting={FadeOut.duration(120)}
              >
                <ComposerAttachmentStrip
                  environmentId={props.environmentId}
                  attachments={stripAttachments}
                  onRemove={voiceInput.isBusy ? () => undefined : props.onRemoveDraftImage}
                  onPressPreview={voiceInput.isBusy ? undefined : onPressPreview}
                  onPressVideo={voiceInput.isBusy ? undefined : onPressVideo}
                  onPressDocument={
                    voiceInput.isBusy
                      ? undefined
                      : (attachment) =>
                          openDraftDocument({
                            attachmentId: attachment.id,
                            name: attachment.name,
                            mimeType: attachment.mimeType,
                            sizeBytes: attachment.sizeBytes,
                          })
                  }
                />
              </Animated.View>
            ) : null}
            <Animated.View
              className={isExpanded ? "px-[14px]" : "min-w-0 flex-1 px-[4px]"}
              layout={COMPOSER_LAYOUT_TRANSITION}
            >
              <ComposerEditor
                draftKey={composerOwnerKey}
                environmentId={props.environmentId}
                onOpenMention={(path) => {
                  Keyboard.dismiss();
                  navigation.navigate("ThreadFile", {
                    environmentId: String(props.environmentId),
                    threadId: String(props.selectedThread.id),
                    path: fileRoutePathSegments(path),
                  });
                }}
                onOpenAttachment={openDraftDocument}
                // A rested composer full of chips left almost nowhere to tap to start typing:
                // every chip opened its file instead. Collapsed, they focus the editor.
                chipsInert={!isExpanded}
                onInertChipPress={() => inputRef.current?.focus()}
                ref={inputRef}
                multiline
                value={props.draftMessage}
                readOnly={voiceInput.freezesEditor}
                skills={composerMenu.skills}
                selection={composerMenu.selection}
                onChangeText={props.onChangeDraftMessage}
                onSelectionChange={composerMenu.onSelectionChange}
                onPasteImages={(uris) => void props.onNativePasteImages(uris)}
                onPasteText={(paste) => {
                  const insertPaste = () => {
                    const insertion = replaceTextSelection({
                      value: paste.value,
                      selection: paste.selection,
                      text: paste.text,
                    });
                    const selection = { start: insertion.cursor, end: insertion.cursor };
                    props.onChangeDraftMessage(insertion.value);
                    composerMenu.onSelectionChange(selection);
                  };
                  const capabilities = props.serverConfig?.environment.capabilities;
                  const advertisedMax =
                    capabilities?.attachmentUploads === true
                      ? capabilities.fileAttachments?.maxUploadBytes
                      : undefined;
                  const maxBytes =
                    advertisedMax === undefined
                      ? null
                      : clampFileAttachmentUploadBytes(advertisedMax);
                  const wouldExceedInputLimit =
                    paste.value.length -
                      Math.max(0, paste.selection.end - paste.selection.start) +
                      paste.text.length >
                    PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
                  const canAttach =
                    maxBytes !== null &&
                    countComposerDraftAttachmentsAfterSelection(composerOwnerKey, {
                      text: paste.value,
                      ...paste.selection,
                    }) < PROVIDER_SEND_TURN_MAX_ATTACHMENTS &&
                    new TextEncoder().encode(paste.text).byteLength <= maxBytes;
                  if (
                    pastedTextDisposition({
                      text: paste.text,
                      wouldExceedInputLimit,
                      canAttach: true,
                    }) === "attachment"
                  ) {
                    if (canAttach) {
                      pendingPastedTextAttachmentCountRef.current += 1;
                      setPendingPastedTextAttachmentCount(
                        pendingPastedTextAttachmentCountRef.current,
                      );
                      const finishAttachment = () => {
                        pendingPastedTextAttachmentCountRef.current = Math.max(
                          0,
                          pendingPastedTextAttachmentCountRef.current - 1,
                        );
                        setPendingPastedTextAttachmentCount(
                          pendingPastedTextAttachmentCountRef.current,
                        );
                      };
                      void props.onNativePasteText(paste).then(finishAttachment, finishAttachment);
                    } else if (!wouldExceedInputLimit) {
                      insertPaste();
                    } else {
                      Alert.alert(
                        wouldExceedInputLimit
                          ? "Pasted text is too large for this message"
                          : "Could not attach pasted text",
                        wouldExceedInputLimit
                          ? "Remove some text or an attachment, then paste again."
                          : "Remove an attachment or use a smaller paste, then try again.",
                      );
                    }
                    return;
                  }
                  insertPaste();
                }}
                placeholder={props.placeholder}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onSubmit={handleSend}
                scrollEnabled={isExpanded}
                // Android: collapsed single line centers natively (gravity) in
                // a pill-height box matching the send button; iOS keeps insets.
                singleLineCentered={!isExpanded}
                contentInsetVertical={isExpanded || Platform.OS === "android" ? 0 : 6}
                style={
                  isExpanded
                    ? {
                        minHeight: 72,
                        maxHeight: 160,
                        paddingVertical: 4,
                      }
                    : {
                        height: 36,
                      }
                }
                textStyle={{
                  ...bodyText,
                  color: foregroundColor,
                }}
              />
            </Animated.View>
            {!isExpanded && stripAttachments.length > 0 ? (
              <View className="flex-row gap-1 pl-1">
                {stripAttachments.slice(0, 3).map((attachment) => (
                  <ComposerAttachmentThumbnail
                    environmentId={props.environmentId}
                    key={attachment.id}
                    attachment={attachment}
                    size={30}
                    borderRadius={8}
                    compact
                    onPressPreview={onPressPreview}
                    onPressVideo={onPressVideo}
                  />
                ))}
                {stripAttachments.length > 3 ? (
                  <View className="size-[30px] items-center justify-center rounded-lg bg-subtle-strong">
                    <Text className="text-foreground-muted text-2xs font-t3-bold">
                      +{stripAttachments.length - 3}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {!isExpanded ? (
              <View className="flex-row items-center">
                <ComposerDictationStartAction
                  state={voiceInput.state}
                  isAvailable={voiceInput.isAvailable}
                  onStart={voiceInput.start}
                  onCancel={voiceInput.cancel}
                />
                {showStopAction ? (
                  <ComposerActionButton
                    accessibilityLabel="Stop agent"
                    icon="stop.fill"
                    variant="danger"
                    onPress={props.onStopThread}
                  />
                ) : (
                  <ComposerActionButton
                    accessibilityLabel={sendBlockedReason ?? sendLabel}
                    icon="arrow.up"
                    variant="primary"
                    disabled={!canSend}
                    onPress={handleSend}
                  />
                )}
              </View>
            ) : null}
            {isExpanded ? <View className="h-1" /> : null}
          </ComposerDictationDraftContent>
          <Animated.View
            accessibilityElementsHidden={!isToolbarVisible}
            collapsable={false}
            importantForAccessibility={isToolbarVisible ? "auto" : "no-hide-descendants"}
            layout={COMPOSER_LAYOUT_TRANSITION}
            pointerEvents={isToolbarVisible ? "auto" : "none"}
            style={
              isExpanded
                ? undefined
                : {
                    position: "absolute",
                    bottom: 2,
                    left: 0,
                    right: 0,
                  }
            }
          >
            <ComposerDictationToolbar
              showsDictation={isVoiceInputPresented}
              visible={isToolbarVisible}
            >
              <ComposerToolbarRow
                paddingBottom={0}
                paddingHorizontal={0}
                paddingTop={0}
                style={{ gap: 0 }}
              >
                <ComposerDictationCancelAction
                  presentation={voicePresentation}
                  onCancel={voiceInput.cancel}
                />
                {isVoiceInputPresented ? (
                  <ComposerDictationStatus
                    audioLevels={voiceInput.audioLevels}
                    elapsedSeconds={voiceInput.elapsedSeconds}
                    phase={voiceInput.state.phase}
                    presentation={voicePresentation}
                    onDismissError={voiceInput.cancel}
                  />
                ) : (
                  <View className="min-w-0 flex-1 flex-row items-center justify-between">
                    <ComposerAttachmentButton
                      supportsFiles={Boolean(
                        props.serverConfig?.environment.capabilities.fileAttachments,
                      )}
                      onPickMedia={props.onPickDraftMedia}
                      onPickFiles={props.onPickDraftFiles}
                    />
                    <View className="min-w-0 shrink">
                      <ComposerInlineControl
                        accessibilityLabel="Model and reasoning settings"
                        emphasized
                        iconNode={
                          <ProviderIcon provider={currentModelOption?.providerDriver} size={16} />
                        }
                        label={currentModelOption?.label ?? currentModelSelection.model}
                        maxWidth="100%"
                        onPress={openSettings}
                      />
                    </View>
                  </View>
                )}
                <View className="shrink-0 flex-row items-center">
                  <ComposerDictationPrimaryAction
                    state={voiceInput.state}
                    presentation={voicePresentation}
                    isAvailable={voiceInput.isAvailable}
                    onStart={voiceInput.start}
                    onConfirm={voiceInput.stop}
                    onCancel={voiceInput.cancel}
                  />
                  {showStopAction ? (
                    <ComposerActionButton
                      accessibilityLabel="Stop agent"
                      icon="stop.fill"
                      variant="danger"
                      onPress={props.onStopThread}
                    />
                  ) : voicePresentation.showsSend ? (
                    <ComposerActionButton
                      accessibilityLabel={sendBlockedReason ?? sendLabel}
                      icon="arrow.up"
                      variant="primary"
                      disabled={!canSend}
                      onPress={handleSend}
                    />
                  ) : null}
                </View>
              </ComposerToolbarRow>
            </ComposerDictationToolbar>
          </Animated.View>
        </ComposerSurface>
      </Animated.View>

      <Modal
        visible={newChangeOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setNewChangeOpen(false)}
      >
        <KeyboardAvoidingView
          className="flex-1 items-center justify-center bg-backdrop px-6"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View className="w-full max-w-md gap-4 rounded-3xl bg-screen p-6">
            <Text accessibilityRole="header" className="text-xl font-t3-semibold">
              New SDD change
            </Text>
            <TextInput
              autoFocus
              accessibilityLabel="Change goal"
              className="min-h-12 rounded-xl bg-subtle px-3 text-base text-foreground"
              placeholder="What do you want to build?"
              value={newChangeGoal}
              onChangeText={setNewChangeGoal}
              returnKeyType="done"
            />
            <View className="flex-row justify-end gap-4">
              <Pressable
                accessibilityRole="button"
                className="min-h-11 justify-center"
                onPress={() => setNewChangeOpen(false)}
              >
                <Text>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !newChangeGoal.trim() }}
                className="min-h-11 justify-center"
                disabled={!newChangeGoal.trim()}
                onPress={() => {
                  void handleSend(`Use Gentle SDD to ${newChangeGoal.trim()}`).then((messageId) => {
                    if (messageId === undefined || messageId === null) return;
                    setNewChangeGoal("");
                    setNewChangeOpen(false);
                  });
                }}
              >
                <Text className="font-t3-semibold">Start change</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <VideoPreviewModal source={previewVideo} onRequestClose={closePreview} />
      <FilePreviewModal source={previewFile} onRequestClose={closePreview} />
    </Animated.View>
  );
});
