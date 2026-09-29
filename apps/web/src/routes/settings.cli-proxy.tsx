import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { useEnvironmentOperateAccess } from "../components/settings/EnvironmentIconPicker";
import { ModelProxySettings } from "../components/settings/model-proxy/ModelProxySettings";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

/** CLIProxyAPI is machine state, so the page shows the representative environment. */
function SettingsCliProxyRoute() {
  const { environment, scope } = useSettingsScope();
  if (!environment?.serverConfig) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to manage CLIProxyAPI.`
          : "Connect an environment to manage CLIProxyAPI."}
      </p>
    );
  }
  return (
    <CliProxyEnvironmentRoute
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  );
}

function CliProxyEnvironmentRoute({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const access = useEnvironmentOperateAccess(environmentId);
  return <ModelProxySettings environmentId={environmentId} readOnly={access !== "granted"} />;
}

export const Route = createFileRoute("/settings/cli-proxy")({
  component: SettingsCliProxyRoute,
});
