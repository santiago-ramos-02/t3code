import { useMemo } from "react";

import { Button, InlineButton } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { GentleAiProjectPicker, useGentleAiProject } from "./GentleAiProjectPicker";
import {
  gentleAiNames,
  gentleAiToolInstalled,
  gentleAiToolSummary,
} from "./gentleAiSections.logic";
import type { GentleAiSectionProps } from "./GentleAiSettingsPage";
import { useGentleAiQuery } from "./useGentleAi";

/** Community tools Gentle AI can install and wire into every agent, such as CodeGraph. */
export function GentleAiToolsSection({
  environmentId,
  status,
  disabled,
  projects,
  startJob,
  onError,
}: GentleAiSectionProps) {
  const { cwd, setCwd } = useGentleAiProject(projects);
  const tools = useGentleAiQuery(
    environmentId,
    "tools.list",
    { cwd: cwd ?? "" },
    { enabled: cwd !== null },
  );
  const names = useMemo(() => gentleAiNames(status), [status]);

  return (
    <SettingsSection
      title="Community tools"
      headerAction={
        <div className="flex items-center gap-2">
          {tools.isPending && tools.data === null ? <Spinner className="size-3.5" /> : null}
          <GentleAiProjectPicker
            projects={projects}
            cwd={cwd}
            onChange={setCwd}
            label="Project for community tools"
          />
        </div>
      }
    >
      {cwd === null ? (
        <SettingsRow
          title="Add a project first"
          description="Community tools are set up from a project folder. Add a project to this environment to install them."
        />
      ) : tools.error ? (
        <SettingsRow title="Community tools unavailable" description={tools.error} />
      ) : tools.data === null ? null : tools.data.tools.length === 0 ? (
        <SettingsRow title="No community tools" description="This gentle-ai offers none." />
      ) : (
        tools.data.tools.map((tool) => (
          <SettingsRow
            key={tool.id}
            title={tool.name}
            description={
              <>
                {tool.description}{" "}
                <InlineButton
                  tone="muted"
                  render={<a href={tool.repoUrl} rel="noreferrer noopener" target="_blank" />}
                >
                  Repository
                </InlineButton>
              </>
            }
            status={gentleAiToolSummary(tool, names)}
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  void startJob("tools.install", { ids: [tool.id], cwd }).then((error) =>
                    error ? onError(error) : undefined,
                  )
                }
              >
                {gentleAiToolInstalled(tool) ? "Reinstall" : "Install"}
              </Button>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}
