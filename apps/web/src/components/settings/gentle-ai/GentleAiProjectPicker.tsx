import { useState } from "react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { gentleAiProjectCwd } from "./gentleAiSections.logic";
import type { GentleAiSectionProps } from "./GentleAiSettingsPage";

type Projects = GentleAiSectionProps["projects"];

/** The project a section's cwd-scoped actions apply to; the first until the user picks another. */
export function useGentleAiProject(projects: Projects) {
  const [choice, setChoice] = useState<string | null>(null);
  const cwd = gentleAiProjectCwd(projects, choice);
  const project = projects.find((entry) => entry.cwd === cwd) ?? null;
  return { cwd, project, setCwd: setChoice };
}

/** Section header picker; with a single project it just names it. */
export function GentleAiProjectPicker({
  projects,
  cwd,
  onChange,
  label,
}: {
  readonly projects: Projects;
  readonly cwd: string | null;
  readonly onChange: (cwd: string) => void;
  readonly label: string;
}) {
  if (projects.length === 0) return null;
  if (projects.length === 1)
    return (
      <span className="max-w-56 truncate text-muted-foreground text-xs">{projects[0]?.title}</span>
    );
  return (
    <Select
      value={cwd ?? ""}
      onValueChange={(value) => {
        if (value) onChange(value);
      }}
    >
      <SelectTrigger size="xs" variant="ghost" className="max-w-56" aria-label={label}>
        <SelectValue>{projects.find((entry) => entry.cwd === cwd)?.title}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end">
        {projects.map((entry) => (
          <SelectItem key={entry.cwd} value={entry.cwd}>
            {entry.title}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
