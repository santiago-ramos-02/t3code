import type { EnvironmentId } from "@t3tools/contracts";

import { Spinner } from "../../ui/spinner";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import { ModelProxyAdvanced } from "./ModelProxyAdvanced";
import { ModelProxyHeader } from "./ModelProxyHeader";
import { ModelProxyModels } from "./ModelProxyModels";
import { ModelProxySources } from "./ModelProxySources";
import { useModelProxy } from "./useModelProxy";

/**
 * CLIProxyAPI on one environment, in the order people need it: whether it runs and T3 Code
 * uses it, where its models come from, its failover models, then everything set once, folded
 * away. Its own control panel is never needed.
 */
export function ModelProxySettings({
  environmentId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const { status, act, manage } = useModelProxy(environmentId);

  if (status === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="CLIProxyAPI">
          <SettingsRow title="Reading CLIProxyAPI" control={<Spinner className="size-3.5" />} />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  const manageable = status.installed && status.running && status.managementReady;
  // Pools and providers change the models the T3 Code provider lists.
  const resync = () => {
    if (status.connected) void act({ type: "setConnected", enabled: true });
  };

  return (
    <SettingsPageContainer>
      <ModelProxyHeader status={status} act={act} disabled={readOnly} />
      {manageable ? (
        <>
          <ModelProxySources manage={manage} disabled={readOnly} onChanged={resync} />
          <ModelProxyModels
            manage={manage}
            proxyUrl={status.url ?? "http://127.0.0.1:8317"}
            disabled={readOnly}
            onChanged={resync}
          />
          <ModelProxyAdvanced manage={manage} disabled={readOnly} />
        </>
      ) : status.installed && !status.running ? (
        <SettingsSection title="Accounts and models">
          <SettingsRow title="Start CLIProxyAPI to see and change its accounts and models." />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
