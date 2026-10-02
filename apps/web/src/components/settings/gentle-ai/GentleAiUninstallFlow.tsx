import type { GentleAiUninstallMode } from "@t3tools/contracts";
import { useMemo, useState, type ReactNode } from "react";

import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Label } from "../../ui/label";
import { Radio, RadioGroup } from "../../ui/radio-group";
import { Spinner } from "../../ui/spinner";
import { WizardSteps } from "../../ui/wizard";
import { GentleAiFlowFooter, GentleAiFlowHeader, GentleAiFlowPanel } from "./GentleAiFlow";
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

/**
 * The uninstall flow, in place of the page. A chosen project only adds project cleanup, such as
 * Engram data kept in it. With an `agent` it removes Gentle AI from that agent alone, so it
 * opens on the review.
 */
export function GentleAiUninstallFlow(
  props: GentleAiSectionProps & { readonly agent?: string; readonly onClose: () => void },
) {
  const { project } = props;
  const cwd = project?.cwd ?? null;
  // Project cleanup applies to the project chosen at the top of Settings.
  const projectNote =
    project === null
      ? "To also clean up a project, such as its Engram data, choose it at the top of this page."
      : `Project cleanup applies to ${project.title}. Choose another project at the top of this page.`;
  const agentName = props.status.agents.find((entry) => entry.id === props.agent)?.name;
  const title = agentName === undefined ? "Remove Gentle AI" : `Remove Gentle AI from ${agentName}`;
  return (
    <UninstallWizard
      // A different project starts a fresh choice.
      key={cwd ?? ""}
      {...props}
      cwd={cwd}
      projectTitle={project?.title ?? ""}
      projectNote={projectNote}
      title={title}
    />
  );
}

function UninstallWizard({
  environmentId,
  status,
  disabled,
  startJob,
  agent,
  cwd,
  projectTitle,
  onClose,
  projectNote,
  title,
}: GentleAiSectionProps & {
  readonly agent?: string;
  readonly cwd: string | null;
  readonly projectTitle: string;
  readonly onClose: () => void;
  readonly projectNote: ReactNode;
  readonly title: string;
}) {
  const names = useMemo(() => gentleAiNames(status), [status]);
  const installedAgents = status.agents.filter((agent) => agent.installed).map((agent) => agent.id);
  const installedComponents = status.components
    .filter((component) => component.installed)
    .map((component) => component.id);
  const [step, setStep] = useState(agent === undefined ? 0 : 1);
  const [mode, setMode] = useState<GentleAiUninstallMode>("partial");
  const [agents, setAgents] = useState<ReadonlyArray<string>>(agent === undefined ? [] : [agent]);
  // gentle-ai drops an agent from its set-up list only when every component is removed from it,
  // including ones never installed.
  const [components, setComponents] = useState<ReadonlyArray<string>>(() =>
    agent === undefined ? [] : status.components.map((component) => component.id),
  );
  const [engramScope, setEngramScope] = useState<"global" | "project">("global");
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const planParams = gentleAiUninstallPlanParams({ mode, agents, components }, cwd);
  const plan = useGentleAiQuery(environmentId, "uninstall.plan", planParams ?? { mode }, {
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
      <GentleAiFlowHeader
        title={title}
        onBack={onClose}
        // Removing from one agent needs no project choice; the project only scopes cleanup.
        {...(agent === undefined ? { description: projectNote } : {})}
      >
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
              {agent !== undefined && mode === "partial" && agents.length === 1 ? (
                <p>
                  Removes everything Gentle AI added to {nameList(plan.data.agents)}. Other agents
                  keep their setup, and a backup is taken first.
                </p>
              ) : (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
                  <dt className="text-muted-foreground">Mode</dt>
                  <dd>{modeInfo?.label}</dd>
                  <dt className="text-muted-foreground">Agents</dt>
                  <dd>{nameList(plan.data.agents)}</dd>
                  <dt className="text-muted-foreground">Components</dt>
                  <dd>{nameList(plan.data.components)}</dd>
                </dl>
              )}
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
            {mode === "clean-install" ? "Remove and reinstall" : "Remove"}
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
