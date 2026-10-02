import { createFileRoute } from "@tanstack/react-router";

import { useEnvironmentOperateAccess } from "../components/settings/EnvironmentIconPicker";
import { GentleAiSettingsPanel } from "../components/settings/GentleAiSettings";
import {
  gentleAiFlowKey,
  parseGentleAiFlow,
} from "../components/settings/gentle-ai/gentleAiFlow.logic";
import { gentleAiScopeProject } from "../components/settings/gentle-ai/gentleAiSections.logic";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

/**
 * Gentle AI is machine state, so the page acts on one environment. The project chosen at the top
 * of Settings, as its folder on that environment, is the one its project settings apply to.
 */
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
      project={gentleAiScopeProject(scope, environment.environmentId)}
      flow={parseGentleAiFlow(target.flow)}
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
  // `flow` names a Gentle AI flow open in place of the page, so back and links return to it.
  validateSearch: (raw: Record<string, unknown>): { flow?: string } => {
    const flow = parseGentleAiFlow(raw.flow);
    return flow === null ? {} : { flow: gentleAiFlowKey(flow) };
  },
  component: SettingsGentleAiRoute,
});
