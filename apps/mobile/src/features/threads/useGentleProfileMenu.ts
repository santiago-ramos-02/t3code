import type { MenuAction } from "@react-native-menu/menu";
import {
  gentleProfileModelChange,
  gentleProfileModelLabel,
} from "@t3tools/client-runtime/piGentleComposer";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ModelSelection,
  PiGentleComposerState,
  ServerProviderModel,
} from "@t3tools/contracts";
import { useState } from "react";
import { Alert } from "react-native";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const PROFILE_EVENT = "profile:";

/**
 * The Gentle menu's Profile submenu for a Pi composer. Applying a profile runs Gentle AI's own
 * apply on the environment and moves the composer's model onto the profile's orchestrator.
 */
export function useGentleProfileMenu(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly state: PiGentleComposerState | null;
  readonly enabled: boolean;
  readonly selection: ModelSelection | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly onModelSelectionChange: (selection: ModelSelection) => void;
  readonly onApplied: () => void;
}) {
  const update = useAtomCommand(serverEnvironment.updatePiGentle, {
    reportFailure: false,
    reportDefect: false,
  });
  const [applying, setApplying] = useState<string | null>(null);
  const { environmentId, selection, cwd } = input;
  const profiles =
    input.enabled && environmentId !== null && selection !== null && cwd !== null
      ? (input.state?.profiles ?? [])
      : [];
  const effective = input.state?.effectiveProfile ?? null;

  const action: MenuAction | null =
    selection === null || profiles.length === 0
      ? null
      : {
          id: "profile",
          title: effective?.pinned ? "Profile pinned for this checkout" : "Profile",
          ...(effective === null ? {} : { subtitle: effective.name }),
          image: "slider.horizontal.3",
          subactions: profiles.map((profile) => ({
            id: `${PROFILE_EVENT}${profile.name}`,
            title: profile.name,
            subtitle:
              applying === profile.name
                ? "Applying…"
                : gentleProfileModelLabel(selection, profile, input.models),
            state: profile.name === effective?.name ? ("on" as const) : ("off" as const),
            ...(applying === null ? {} : { attributes: { disabled: true } }),
          })),
        };

  /** Handles a menu event; returns false for events that are not profile choices. */
  const handle = (event: string) => {
    if (!event.startsWith(PROFILE_EVENT)) return false;
    const profile = profiles.find((entry) => `${PROFILE_EVENT}${entry.name}` === event);
    if (
      profile === undefined ||
      environmentId === null ||
      selection === null ||
      cwd === null ||
      applying !== null
    ) {
      return true;
    }
    setApplying(profile.name);
    void update({
      environmentId,
      input: {
        instanceId: selection.instanceId,
        action: { type: "apply", name: profile.name, cwd },
      },
    }).then((result) => {
      setApplying(null);
      if (result._tag !== "Success") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          Alert.alert(
            "Could not apply the profile",
            failure instanceof Error ? failure.message : "Try again.",
          );
        }
        return;
      }
      input.onApplied();
      const change = gentleProfileModelChange(selection, profile, input.models);
      if (change.kind === "switch") input.onModelSelectionChange(change.selection);
      if (change.kind === "unavailable") {
        Alert.alert(
          `Applied ${profile.name}`,
          `${change.model} is not in Pi's model list, so this thread keeps its model.`,
        );
      }
    });
    return true;
  };

  return { action, handle };
}
