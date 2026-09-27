import type { GentleAiUninstallMode } from "@t3tools/contracts";
import { useMemo, useState, type ReactNode } from "react";

import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Label } from "../../ui/label";
import { Radio, RadioGroup } from "../../ui/radio-group";
import { Spinner } from "../../ui/spinner";
import { WizardSteps } from "../../ui/wizard";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { GentleAiFlowFooter, GentleAiFlowHeader, GentleAiFlowPanel } from "./GentleAiFlow";
import { GentleAiProjectPicker, useGentleAiProject } from "./GentleAiProjectPicker";
import {
  GENTLE_AI_UNINSTALL_MODES,
  gentleAiNames,
  gentleAiUninstallPlanParams,
  gentleAiUninstallRunParams,
  toggleGentleAiId,
} from "./gentleAiSections.logic";
import type { GentleAiSectionProps } from "./GentleAiSettingsPage";
import { useGentleAiQuery } from "./useGentleAi";

const STEPS = ["Choose", "Review"] as const;

/** Removing Gentle AI from agents, partly or fully, or resetting it with a clean reinstall. */
export function GentleAiUninstallSection(props: GentleAiSectionProps) {
  return (
    <SettingsSection title="Uninstall">
      <SettingsRow
        title="Uninstall Gentle AI"
        description={
          props.projects.length === 0
            ? "gentle-ai uninstalls from a project folder. Add a project to this environment first."
            : "Remove what Gentle AI set up in your agents. A backup is taken first."
        }
        control={
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={props.disabled || props.projects.length === 0}
            onClick={() => props.openFlow({ kind: "uninstall" })}
          >
            Uninstall
          </Button>
        }
      />
    </SettingsSection>
  );
}

/** The uninstall flow, in place of the page; project-scoped cleanup uses the chosen project. */
export function GentleAiUninstallFlow(
  props: GentleAiSectionProps & { readonly onClose: () => void },
) {
  const { cwd, project, setCwd } = useGentleAiProject(props.projects);
  const picker = (
    <GentleAiProjectPicker
      projects={props.projects}
      cwd={cwd}
      onChange={setCwd}
      label="Project for project-scoped cleanup"
    />
  );
  if (cwd === null)
    return (
      <section className="space-y-4">
        <GentleAiFlowHeader title="Uninstall Gentle AI" onBack={props.onClose} />
        <GentleAiFlowPanel>
          <p className="text-muted-foreground text-sm">
            gentle-ai uninstalls from a project folder. Add a project to this environment first.
          </p>
        </GentleAiFlowPanel>
      </section>
    );
  return (
    <UninstallWizard
      // A different project starts a fresh choice.
      key={cwd}
      {...props}
      cwd={cwd}
      projectTitle={project?.title ?? cwd}
      picker={picker}
    />
  );
}

function UninstallWizard({
  environmentId,
  status,
  disabled,
  startJob,
  cwd,
  projectTitle,
  onClose,
  picker,
}: GentleAiSectionProps & {
  readonly cwd: string;
  readonly projectTitle: string;
  readonly onClose: () => void;
  readonly picker: ReactNode;
}) {
  const names = useMemo(() => gentleAiNames(status), [status]);
  const installedAgents = status.agents.filter((agent) => agent.installed).map((agent) => agent.id);
  const installedComponents = status.components
    .filter((component) => component.installed)
    .map((component) => component.id);
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<GentleAiUninstallMode>("partial");
  const [agents, setAgents] = useState<ReadonlyArray<string>>([]);
  const [components, setComponents] = useState<ReadonlyArray<string>>([]);
  const [engramScope, setEngramScope] = useState<"global" | "project">("global");
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const planParams = gentleAiUninstallPlanParams({ mode, agents, components }, cwd);
  const plan = useGentleAiQuery(environmentId, "uninstall.plan", planParams ?? { mode, cwd }, {
    enabled: step === 1 && planParams !== null,
  });
  const modeInfo = GENTLE_AI_UNINSTALL_MODES.find((entry) => entry.mode === mode);
  const nameList = (ids: ReadonlyArray<string>) =>
    ids.length === 0 ? "None" : ids.map((id) => names.get(id) ?? id).join(", ");

  const uninstall = async () => {
    if (planParams === null || plan.data === null) return;
    setActionError(null);
    setStarting(true);
    const error = await startJob(
      "uninstall.run",
      gentleAiUninstallRunParams(planParams, {
        engramScope: plan.data.engramScopeAvailable ? engramScope : null,
      }),
    );
    setStarting(false);
    if (error) setActionError(error);
    else onClose();
  };

  return (
    <section className="space-y-4">
      <GentleAiFlowHeader title="Uninstall Gentle AI" onBack={onClose} description={picker}>
        <WizardSteps
          steps={STEPS}
          currentStep={step}
          isStepDisabled={(index) => starting || (index === 1 && planParams === null)}
          onStepChange={setStep}
        />
      </GentleAiFlowHeader>
      <GentleAiFlowPanel>
        <div className="space-y-4 text-sm">
          {step === 0 ? (
            <>
              <RadioGroup
                aria-label="Uninstall mode"
                value={mode}
                onValueChange={(value) => {
                  const next = GENTLE_AI_UNINSTALL_MODES.find((entry) => entry.mode === value);
                  if (next) setMode(next.mode);
                }}
              >
                {GENTLE_AI_UNINSTALL_MODES.map((entry) => (
                  <Label key={entry.mode}>
                    <Radio value={entry.mode} />
                    <span className="space-y-0.5">
                      <span className="block">{entry.label}</span>
                      <span className="block font-normal text-muted-foreground text-xs">
                        {entry.description}
                      </span>
                    </span>
                  </Label>
                ))}
              </RadioGroup>
              {mode === "partial" ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Checklist
                    label="Agents"
                    empty="No agents are set up."
                    ids={installedAgents}
                    selected={agents}
                    names={names}
                    onToggle={(id) => setAgents(toggleGentleAiId(installedAgents, agents, id))}
                  />
                  <Checklist
                    label="Components"
                    empty="No components are installed."
                    ids={installedComponents}
                    selected={components}
                    names={names}
                    onToggle={(id) =>
                      setComponents(toggleGentleAiId(installedComponents, components, id))
                    }
                  />
                </div>
              ) : null}
            </>
          ) : plan.error ? (
            <p className="text-destructive">{plan.error}</p>
          ) : plan.data === null ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3.5" /> Planning the uninstall
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">Mode</dt>
                <dd>{modeInfo?.label}</dd>
                <dt className="text-muted-foreground">Agents</dt>
                <dd>{nameList(plan.data.agents)}</dd>
                <dt className="text-muted-foreground">Components</dt>
                <dd>{nameList(plan.data.components)}</dd>
              </dl>
              {plan.data.engramScopeAvailable ? (
                <div className="space-y-2">
                  <p className="font-medium">Engram cleanup</p>
                  <RadioGroup
                    aria-label="Engram cleanup"
                    value={engramScope}
                    onValueChange={(value) => {
                      if (value === "global" || value === "project") setEngramScope(value);
                    }}
                  >
                    <Label>
                      <Radio value="global" />
                      <span className="font-normal">
                        Global: remove Engram's MCP server and prompt setup
                      </span>
                    </Label>
                    <Label>
                      <Radio value="project" />
                      <span className="font-normal">
                        Project only: delete .engram/ in {projectTitle}
                      </span>
                    </Label>
                  </RadioGroup>
                </div>
              ) : null}
              {mode === "full-remove" ? (
                <p className="text-destructive">
                  The gentle-ai binary is deleted too. Using Gentle AI again needs a reinstall.
                </p>
              ) : null}
            </>
          )}
          {actionError ? (
            <p role="alert" className="text-destructive">
              {actionError}
            </p>
          ) : null}
        </div>
      </GentleAiFlowPanel>
      <GentleAiFlowFooter
        leading={
          step === 1 ? (
            <Button variant="ghost" disabled={starting} onClick={() => setStep(0)}>
              Back
            </Button>
          ) : undefined
        }
      >
        {step === 0 ? (
          <Button disabled={planParams === null} onClick={() => setStep(1)}>
            Review
          </Button>
        ) : (
          <Button
            variant="destructive"
            disabled={disabled || starting || plan.data === null}
            onClick={() => void uninstall()}
          >
            {mode === "clean-install" ? "Remove and reinstall" : "Uninstall"}
          </Button>
        )}
      </GentleAiFlowFooter>
    </section>
  );
}

function Checklist({
  label,
  empty,
  ids,
  selected,
  names,
  onToggle,
}: {
  readonly label: string;
  readonly empty: string;
  readonly ids: ReadonlyArray<string>;
  readonly selected: ReadonlyArray<string>;
  readonly names: ReadonlyMap<string, string>;
  readonly onToggle: (id: string) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-2 font-medium">{label}</legend>
      <div className="flex flex-col gap-2">
        {ids.length === 0 ? (
          <p className="text-muted-foreground">{empty}</p>
        ) : (
          ids.map((id) => (
            <Label key={id}>
              <Checkbox checked={selected.includes(id)} onCheckedChange={() => onToggle(id)} />
              <span className="font-normal">{names.get(id) ?? id}</span>
            </Label>
          ))
        )}
      </div>
    </fieldset>
  );
}
