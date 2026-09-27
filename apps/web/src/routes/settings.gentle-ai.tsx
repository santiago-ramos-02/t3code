import { createFileRoute } from "@tanstack/react-router";

import { useEnvironmentOperateAccess } from "../components/settings/EnvironmentIconPicker";
import { GentleAiSettingsPanel } from "../components/settings/GentleAiSettings";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

/** Gentle AI is machine state, so the page shows the representative environment. */
function SettingsGentleAiRoute() {
  const target = Route.useSearch();
  const { environment, scope } = useSettingsScope();
  if (!environment?.serverConfig) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to set up Gentle AI.`
          : "Connect an environment to set up Gentle AI."}
      </p>
    );
  }
  return (
    <GentleAiEnvironmentRoute
      environmentId={environment.environmentId}
      serverConfig={environment.serverConfig}
      projectCwd={target.projectCwd}
    />
  );
}

function GentleAiEnvironmentRoute(
  props: Omit<Parameters<typeof GentleAiSettingsPanel>[0], "readOnly">,
) {
  const access = useEnvironmentOperateAccess(props.environmentId);
  return (
    <GentleAiSettingsPanel key={props.environmentId} {...props} readOnly={access !== "granted"} />
  );
}

export const Route = createFileRoute("/settings/gentle-ai")({
  validateSearch: (raw: Record<string, unknown>) =>
    typeof raw.projectCwd === "string" && raw.projectCwd.trim()
      ? { projectCwd: raw.projectCwd }
      : {},
  component: SettingsGentleAiRoute,
});
