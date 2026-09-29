import { gentlePiProfileSummary } from "@t3tools/client-runtime/gentle-ai";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PiGentleState,
  ProviderInstanceId,
  ServerProviderModel,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";

function errorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : "gentle-pi could not be read.";
}

/**
 * gentle-pi's profiles on one Pi provider, which one is active, and what it runs in a line.
 * `refreshKey` re-reads them, such as after the agent's own page changed them.
 */
export function usePiGentleProfiles({
  environmentId,
  instanceId,
  models,
  refreshKey = 0,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly refreshKey?: number;
}) {
  const read = useAtomCommand(serverEnvironment.readPiGentle, {
    reportFailure: false,
    reportDefect: false,
  });
  const update = useAtomCommand(serverEnvironment.updatePiGentle, {
    reportFailure: false,
    reportDefect: false,
  });
  const key = `${environmentId}:${instanceId}:${refreshKey}`;
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly state: PiGentleState | null;
    readonly error: string | null;
  } | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let live = true;
    void read({ environmentId, input: { instanceId } }).then((result) => {
      if (!live) return;
      if (result._tag === "Success") setLoaded({ key, state: result.value, error: null });
      else if (!isAtomCommandInterrupted(result)) {
        setLoaded({ key, state: null, error: errorText(squashAtomCommandFailure(result)) });
      }
    });
    return () => {
      live = false;
    };
  }, [environmentId, instanceId, key, read]);

  const current = loaded?.key === key ? loaded : null;
  const state = current?.state ?? null;
  const active = state?.profiles.find((profile) => profile.name === state.active) ?? null;
  const nameOf = (slug: string) => models.find((model) => model.slug === slug)?.name;
  const summary =
    current?.error ??
    (state === null
      ? "Reading gentle-pi…"
      : !state.available
        ? "gentle-pi is not installed in Pi."
        : active === null
          ? state.profiles.length === 0
            ? "No profiles yet. Pi runs its own models."
            : "No profile active. Pi runs its own models."
          : gentlePiProfileSummary(active.routing, nameOf));

  const activate = (name: string) => {
    setSwitching(true);
    void update({ environmentId, input: { instanceId, action: { type: "activate", name } } }).then(
      (result) => {
        setSwitching(false);
        if (result._tag === "Success") setLoaded({ key, state: result.value, error: null });
        else if (!isAtomCommandInterrupted(result)) {
          setLoaded({ key, state, error: errorText(squashAtomCommandFailure(result)) });
        }
      },
    );
  };

  return { state, error: current?.error ?? null, summary, switching, activate };
}

/** Switches gentle-pi's active profile; nothing while there are none. */
export function PiGentleProfileSelect({
  profiles,
  disabled,
}: {
  readonly profiles: ReturnType<typeof usePiGentleProfiles>;
  readonly disabled: boolean;
}) {
  const { state, error, switching, activate } = profiles;
  if (switching) return <Spinner className="size-3.5" />;
  if (state === null) return error ? null : <Spinner className="size-3.5" />;
  if (!state.available || state.profiles.length === 0) return null;
  return (
    <Select
      value={state.active ?? ""}
      onValueChange={(next) => {
        if (next && next !== state.active) activate(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger size="sm" className="w-40" aria-label="Pi profile">
        <SelectValue>
          <span className="truncate">{state.active ?? "None"}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end">
        {state.profiles.map((profile) => (
          <SelectItem key={profile.name} value={profile.name}>
            {profile.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
