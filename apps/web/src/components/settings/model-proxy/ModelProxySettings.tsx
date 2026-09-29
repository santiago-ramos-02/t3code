import type { EnvironmentId } from "@t3tools/contracts";

import { Spinner } from "../../ui/spinner";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import { ModelProxyAccounts } from "./ModelProxyAccounts";
import { ModelProxyAdvanced } from "./ModelProxyAdvanced";
import { ModelProxyModels } from "./ModelProxyModels";
import { ModelProxyOverview } from "./ModelProxyOverview";
import { ModelProxyProviders } from "./ModelProxyProviders";
import { useModelProxy } from "./useModelProxy";

/**
 * CLIProxyAPI on one environment: installing and running it, its accounts and their limits,
 * API-key providers, failover pools, routing, plugins, and logs, so its own control panel is
 * never needed.
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
      <ModelProxyOverview status={status} act={act} disabled={readOnly} />
      {manageable ? (
        <>
          <ModelProxyAccounts manage={manage} disabled={readOnly} />
          <ModelProxyModels
            manage={manage}
            proxyUrl={status.url ?? "http://127.0.0.1:8317"}
            disabled={readOnly}
            onChanged={resync}
          />
          <ModelProxyProviders manage={manage} disabled={readOnly} onChanged={resync} />
          <ModelProxyAdvanced manage={manage} disabled={readOnly} />
        </>
      ) : status.installed ? (
        <SettingsSection title="Accounts, models, and settings">
          <SettingsRow
            title={
              !status.running
                ? "Start CLIProxyAPI to manage its accounts, models, and settings."
                : "Add the management key above to manage its accounts, models, and settings."
            }
          />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
