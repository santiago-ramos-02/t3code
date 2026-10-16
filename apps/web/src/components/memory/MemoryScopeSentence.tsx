import {
  type EnvironmentId,
  type MemoryProject,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { FolderIcon, LayersIcon } from "lucide-react";
import { useMemo } from "react";

import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { ScopeMenu } from "../settings/SettingsScopeSentence";
import {
  settingsScopeEnvironmentAddress,
  settingsScopeEnvironmentLabel,
  settingsScopeEnvironmentLabels,
} from "../settings/settingsScopeAxis";
import { memoryProjectChoices } from "./memoryModel";

const ALL_PROJECTS = "";

/**
 * "Memories from <project> on <environment>": the Memory page's scope, picked the way settings
 * pick theirs. Engram's projects show as the T3 projects they belong to when one matches.
 */
export function MemoryScopeSentence(props: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly environmentId: EnvironmentId;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
  readonly projects: ReadonlyArray<MemoryProject>;
  // Engram's project name, or null for every project.
  readonly project: string | null;
  readonly onProjectChange: (project: string | null) => void;
}) {
  const { environments: all } = useEnvironments();
  const environments = useMemo(
    () => all.filter((environment) => props.environmentIds.includes(environment.environmentId)),
    [all, props.environmentIds],
  );
  const t3Projects = useProjects();
  const choices = useMemo(
    () =>
      memoryProjectChoices(
        props.projects,
        t3Projects.filter((project) => project.environmentId === props.environmentId),
      ),
    [props.projects, t3Projects, props.environmentId],
  );
  const selectedProject = choices.find((choice) => choice.name === props.project) ?? null;
  const selectedEnvironment =
    environments.find((environment) => environment.environmentId === props.environmentId) ?? null;

  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-base text-muted-foreground">
      {/* Each connective stays with its picker so a wrap never strands "on". */}
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0">Memories from</span>
        <ScopeMenu
          ariaLabel="Project"
          icon={
            selectedProject?.project ? (
              <ProjectFavicon project={selectedProject.project} className="size-3.5 shrink-0" />
            ) : null
          }
          label={selectedProject ? selectedProject.label : "All projects"}
          value={props.project ?? ALL_PROJECTS}
          onChange={(next) => props.onProjectChange(next === ALL_PROJECTS ? null : next)}
          searchLabel="Search projects"
          allOption={{
            value: ALL_PROJECTS,
            label: "All projects",
            icon: <LayersIcon aria-hidden className="size-3.5 shrink-0" />,
          }}
          options={choices.map((choice) => ({
            value: choice.name,
            label: choice.label,
            secondary: choice.count === 1 ? "1 memory" : `${choice.count} memories`,
            icon: choice.project ? (
              <ProjectFavicon project={choice.project} className="size-3.5 shrink-0" />
            ) : (
              <FolderIcon aria-hidden className="size-3.5 shrink-0" />
            ),
          }))}
        />
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0">on</span>
        <ScopeMenu
          ariaLabel="Environment"
          icon={
            selectedEnvironment ? (
              <EnvironmentMachineIcon
                aria-hidden
                kind={resolveEnvironmentMachineKind(selectedEnvironment.serverConfig)}
                className="size-3.5 shrink-0"
              />
            ) : null
          }
          label={
            selectedEnvironment
              ? settingsScopeEnvironmentLabel(selectedEnvironment, environments)
              : "Unavailable environment"
          }
          value={props.environmentId}
          onChange={(next) => {
            const environment = environments.find((entry) => entry.environmentId === next);
            if (environment) props.onEnvironmentChange(environment.environmentId);
          }}
          searchLabel="Search environments"
          allOption={null}
          options={environments.map((environment) => {
            const { primary, secondary } = settingsScopeEnvironmentLabels(
              environment,
              environments,
            );
            return {
              value: environment.environmentId,
              label: primary,
              secondary:
                environments.length <= 1
                  ? ""
                  : secondary || settingsScopeEnvironmentAddress(environment),
              icon: (
                <EnvironmentMachineIcon
                  aria-hidden
                  kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                  className="size-3.5 shrink-0"
                />
              ),
              offline: environment.connection.phase !== "connected",
            };
          })}
        />
      </span>
    </p>
  );
}
