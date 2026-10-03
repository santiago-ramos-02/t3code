import { resolveProviderForCwd } from "@t3tools/client-runtime/providerSkills";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/** The providers as they are in the composer's project. */
export function useWorkspaceProviderStatuses(
  providers: ReadonlyArray<ServerProvider>,
  cwd: string | null,
) {
  return useMemo(
    () => providers.map((provider) => resolveProviderForCwd(provider, cwd)),
    [cwd, providers],
  );
}

/**
 * Pi reads its models and skills per project, so every enabled Pi instance other than the
 * selected one (which the composer already refreshes) is read once for the project, which lets
 * the model picker list its models there.
 */
export function useWorkspacePiModels({
  environmentId,
  providers,
  cwd,
  selectedInstanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly cwd: string | null;
  readonly selectedInstanceId: ProviderInstanceId | undefined;
}) {
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const requested = useRef(new Set<string>());
  useEffect(() => {
    if (!cwd) return;
    for (const provider of providers) {
      if (
        provider.driver !== "pi" ||
        !provider.enabled ||
        !provider.installed ||
        provider.instanceId === selectedInstanceId ||
        provider.workspaceSnapshots?.some((snapshot) => snapshot.cwd === cwd)
      ) {
        continue;
      }
      const key = `${environmentId}:${provider.instanceId}:${cwd}`;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      void refreshProviders({
        environmentId,
        input: { instanceId: provider.instanceId, cwd },
      }).then((result) => {
        if (result._tag === "Failure") requested.current.delete(key);
      });
    }
  }, [cwd, environmentId, providers, refreshProviders, selectedInstanceId]);
}
