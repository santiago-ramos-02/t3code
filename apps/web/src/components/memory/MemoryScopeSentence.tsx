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
import { settingsScopeEnvironmentLabel } from "../settings/settingsScopeAxis";
import { MenuRadioGroup, MenuRadioItem, MenuRadioItemIndicator, MenuSeparator } from "../ui/menu";
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
          label={
            selectedProject
              ? (selectedProject.project?.title ?? selectedProject.name)
              : "All projects"
          }
        >
          <MenuRadioGroup
            value={props.project ?? ALL_PROJECTS}
            onValueChange={(next) => {
              if (typeof next === "string")
                props.onProjectChange(next === ALL_PROJECTS ? null : next);
            }}
          >
            <MenuRadioItem value={ALL_PROJECTS}>
              <span className="flex min-w-0 items-center gap-2">
                <LayersIcon aria-hidden className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">All projects</span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
            <MenuSeparator />
            {choices.map((choice) => (
              <MenuRadioItem key={choice.name} value={choice.name}>
                <span className="flex min-w-0 items-center gap-2">
                  {choice.project ? (
                    <ProjectFavicon project={choice.project} className="size-3.5" />
                  ) : (
                    <FolderIcon aria-hidden className="size-3.5" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {choice.project?.title ?? choice.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {choice.count}
                  </span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </ScopeMenu>
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
        >
          <MenuRadioGroup
            value={props.environmentId}
            onValueChange={(next) => {
              const environment = environments.find((entry) => entry.environmentId === next);
              if (environment) props.onEnvironmentChange(environment.environmentId);
            }}
          >
            {environments.map((environment) => (
              <MenuRadioItem key={environment.environmentId} value={environment.environmentId}>
                <span className="flex min-w-0 items-center gap-2">
                  <EnvironmentMachineIcon
                    aria-hidden
                    kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                    className="size-3.5"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {settingsScopeEnvironmentLabel(environment, environments)}
                  </span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </ScopeMenu>
      </span>
    </p>
  );
}
