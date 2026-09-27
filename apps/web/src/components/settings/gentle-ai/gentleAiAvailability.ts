import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { serverEnvironment } from "../../../state/server";

// Keyed by the environments' ids so each set of environments shares one derived atom.
const availableFamily = Atom.family((key: string) =>
  Atom.make((get) =>
    key
      .split("\n")
      .filter((id) => id.length > 0)
      .some((environmentId) => {
        const status = get(
          serverEnvironment.gentleAiStatus({
            environmentId: EnvironmentId.make(environmentId),
            input: {},
          }),
        );
        return status._tag === "Success" && status.value.installed;
      }),
  ),
);

/** Whether gentle-ai is installed on any of these environments, even with nothing set up yet. */
export function useGentleAiInstalledOnAny(environmentIds: ReadonlyArray<EnvironmentId>): boolean {
  return useAtomValue(availableFamily([...environmentIds].sort().join("\n")));
}
