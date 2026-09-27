import type { GentleAiApiStatus, GentleAiModelAgent, GentleAiPlan } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Radio, RadioGroup } from "../../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { WizardSteps } from "../../ui/wizard";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { GentleAiFlowFooter, GentleAiFlowHeader, GentleAiFlowPanel } from "./GentleAiFlow";
import { GentleAiModelEditor } from "./GentleAiModelEditor";
import type { GentleAiSectionProps } from "./GentleAiSettingsPage";
import {
  CUSTOM_PRESET,
  draftComponents,
  draftSelection,
  initialSetupDraft,
  installParams,
  plannedModelAgents,
  type GentleAiSetupDraft,
} from "./gentleAiSetup.logic";
import { useGentleAiQuery } from "./useGentleAi";

type Step = "agents" | "style" | "options" | "models" | "review";
const STEP_LABELS = {
  agents: "Agents",
  style: "Style",
  options: "Options",
  models: "Models",
  review: "Review",
} satisfies Record<Step, string>;

const OPTION_QUESTIONS: ReadonlySet<string> = new Set([
  "rdd",
  "communityTools",
  "openCodePlugins",
  "openCodeBackground",
  "piBackground",
]);

/** Which wizard steps a plan needs, in order; agents, style, and review always apply. */
function wizardSteps(plan: GentleAiPlan | null): ReadonlyArray<Step> {
  const questions = plan?.questions ?? [];
  return [
    "agents",
    "style",
    ...(questions.some((question) => OPTION_QUESTIONS.has(question)) ? (["options"] as const) : []),
    ...(plannedModelAgents(plan).length > 0 ? (["models"] as const) : []),
    "review",
  ];
}

/** What gentle-ai is set up with, and the wizard that changes it, like the TUI's installation. */
export function GentleAiSetupSection(props: GentleAiSectionProps) {
  const { status, disabled } = props;
  const installed = status.agents.filter((agent) => agent.installed);
  const preset = status.presets.find((entry) => entry.id === status.state.preset);
  const persona = status.personas.find((entry) => entry.id === status.state.persona);
  return (
    <SettingsSection title="Setup">
      <SettingsRow
        title={
          installed.length > 0 ? installed.map((agent) => agent.name).join(", ") : "Not set up yet"
        }
        description={
          installed.length > 0
            ? [preset?.label, persona ? `${persona.label} persona` : null]
                .filter((part) => part !== null && part !== undefined)
                .join(" · ")
            : "Choose the agents to set up and what Gentle AI adds to them."
        }
        control={
          <Button
            size="sm"
            variant={installed.length > 0 ? "outline" : "default"}
            disabled={disabled}
            onClick={() => props.openFlow({ kind: "setup" })}
          >
            {installed.length > 0 ? "Change setup" : "Set up"}
          </Button>
        }
      />
    </SettingsSection>
  );
}

/** The setup flow, in place of the page: agents, style, the plan's options, then review. */
export function GentleAiSetupFlow(props: GentleAiSectionProps & { readonly onClose: () => void }) {
  const { environmentId, status, startJob, onError, projects } = props;
  const [draft, setDraft] = useState<GentleAiSetupDraft>(() => initialSetupDraft(status));
  const [stepIndex, setStepIndex] = useState(0);
  const update = (patch: Partial<GentleAiSetupDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const selection = draftSelection(status, draft);
  const plan = useGentleAiQuery(
    environmentId,
    "plan",
    { selection },
    { enabled: draft.agents.length > 0 },
  );
  const steps = wizardSteps(plan.data);
  const step = steps[Math.min(stepIndex, steps.length - 1)] ?? "agents";
  const last = step === "review";
  const canContinue =
    step === "agents"
      ? draft.agents.length > 0
      : step === "style"
        ? draft.preset !== CUSTOM_PRESET || draft.components.length > 0
        : true;

  const install = () => {
    if (plan.data === null) return;
    props.onClose();
    void startJob("install", installParams(status, draft, plan.data)).then((error) =>
      error ? onError(error) : undefined,
    );
  };

  return (
    <section className="space-y-4">
      <GentleAiFlowHeader
        title="Set up Gentle AI"
        description="Everything runs on this environment."
        onBack={props.onClose}
      >
        <WizardSteps
          steps={steps.map((entry) => STEP_LABELS[entry])}
          currentStep={steps.indexOf(step)}
          onStepChange={(index) => setStepIndex(index)}
          isStepDisabled={(index) => index > steps.indexOf(step) && !canContinue}
        />
      </GentleAiFlowHeader>
      <GentleAiFlowPanel>
        {step === "agents" ? (
          <AgentsStep status={status} draft={draft} update={update} />
        ) : step === "style" ? (
          <StyleStep status={status} draft={draft} update={update} />
        ) : step === "options" ? (
          <OptionsStep
            {...props}
            plan={plan.data}
            draft={draft}
            update={update}
            projects={projects}
          />
        ) : step === "models" ? (
          <ModelsStep
            environmentId={environmentId}
            agents={plannedModelAgents(plan.data)}
            draft={draft}
            update={update}
            names={status}
          />
        ) : (
          <ReviewStep status={status} draft={draft} plan={plan.data} error={plan.error} />
        )}
      </GentleAiFlowPanel>
      <GentleAiFlowFooter
        leading={
          stepIndex > 0 ? (
            <Button variant="outline" onClick={() => setStepIndex(steps.indexOf(step) - 1)}>
              Back
            </Button>
          ) : null
        }
      >
        {last ? (
          <Button disabled={plan.data === null} onClick={install}>
            Install
          </Button>
        ) : (
          <Button disabled={!canContinue} onClick={() => setStepIndex(steps.indexOf(step) + 1)}>
            Continue
          </Button>
        )}
      </GentleAiFlowFooter>
    </section>
  );
}

type StepProps = {
  readonly status: GentleAiApiStatus;
  readonly draft: GentleAiSetupDraft;
  readonly update: (patch: Partial<GentleAiSetupDraft>) => void;
};

function toggled(values: ReadonlyArray<string>, id: string, on: boolean): ReadonlyArray<string> {
  return on ? [...new Set([...values, id])] : values.filter((value) => value !== id);
}

function CheckRow(props: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: ReactNode;
  readonly detail?: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-1.5 text-sm has-disabled:cursor-not-allowed has-disabled:opacity-64">
      <Checkbox
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={(checked) => props.onChange(checked === true)}
      />
      <span className="min-w-0">
        <span className="text-foreground">{props.label}</span>
        {props.detail ? (
          <span className="block text-muted-foreground text-xs">{props.detail}</span>
        ) : null}
      </span>
    </label>
  );
}

function StepHeading({ children }: { readonly children: ReactNode }) {
  return <h3 className="font-medium text-foreground text-sm">{children}</h3>;
}

function AgentsStep({ status, draft, update }: StepProps) {
  return (
    <div className="grid gap-1">
      <StepHeading>Agents to set up</StepHeading>
      <div className="grid gap-x-4 sm:grid-cols-2">
        {status.agents.map((agent) => (
          <CheckRow
            key={agent.id}
            checked={draft.agents.includes(agent.id)}
            disabled={!agent.supported}
            onChange={(on) => update({ agents: toggled(draft.agents, agent.id, on) })}
            label={agent.name}
            detail={
              !agent.supported
                ? "Not supported here"
                : agent.installed
                  ? "Set up"
                  : agent.detected
                    ? "Detected"
                    : "Not detected"
            }
          />
        ))}
      </div>
    </div>
  );
}

function StyleStep({ status, draft, update }: StepProps) {
  const custom = draft.preset === CUSTOM_PRESET;
  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <StepHeading>Persona</StepHeading>
        <RadioGroup
          value={draft.persona}
          onValueChange={(persona) => update({ persona: String(persona) })}
        >
          {status.personas.map((persona) => (
            <label
              key={persona.id}
              className="flex cursor-pointer items-start gap-2.5 py-1 text-sm"
            >
              <Radio value={persona.id} />
              <span>
                {persona.label}
                {persona.description ? (
                  <span className="block text-muted-foreground text-xs">{persona.description}</span>
                ) : null}
              </span>
            </label>
          ))}
        </RadioGroup>
      </div>
      <div className="grid gap-1.5">
        <StepHeading>Preset</StepHeading>
        <RadioGroup
          value={draft.preset}
          onValueChange={(preset) => update({ preset: String(preset) })}
        >
          {[
            ...status.presets,
            ...(status.presets.some((preset) => preset.id === CUSTOM_PRESET)
              ? []
              : [
                  {
                    id: CUSTOM_PRESET,
                    label: "Custom",
                    description: "Choose components yourself.",
                    components: [],
                  },
                ]),
          ].map((preset) => (
            <label key={preset.id} className="flex cursor-pointer items-start gap-2.5 py-1 text-sm">
              <Radio value={preset.id} />
              <span>
                {preset.label}
                <span className="block text-muted-foreground text-xs">
                  {preset.description ??
                    preset.components
                      .map(
                        (id) =>
                          status.components.find((component) => component.id === id)?.name ?? id,
                      )
                      .join(", ")}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </div>
      {custom ? (
        <div className="grid gap-1">
          <StepHeading>Components</StepHeading>
          <div className="grid gap-x-4 sm:grid-cols-2">
            {status.components.map((component) => (
              <CheckRow
                key={component.id}
                checked={draft.components.includes(component.id)}
                onChange={(on) =>
                  update({ components: toggled(draft.components, component.id, on) })
                }
                label={component.name}
                detail={[
                  component.description,
                  component.requires.length > 0 ? `Needs ${component.requires.join(", ")}` : null,
                ]
                  .filter((part) => part !== null && part !== "")
                  .join(". ")}
              />
            ))}
          </div>
          {draft.components.includes("skills") ? (
            <>
              <StepHeading>Skills</StepHeading>
              <div className="grid gap-x-4 sm:grid-cols-2">
                {status.skills.map((skill) => (
                  <CheckRow
                    key={skill.id}
                    checked={draft.skills.includes(skill.id)}
                    onChange={(on) => update({ skills: toggled(draft.skills, skill.id, on) })}
                    label={skill.name}
                  />
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const BACKGROUND_LABELS = { auto: "Automatic", on: "On", off: "Off" } as const;

function OptionsStep({
  environmentId,
  plan,
  draft,
  update,
  projects,
}: GentleAiSectionProps & Omit<StepProps, "status"> & { readonly plan: GentleAiPlan | null }) {
  const asks = (question: string) => plan?.questions.includes(question) === true;
  const cwd = projects[0]?.cwd;
  const tools = useGentleAiQuery(
    environmentId,
    "tools.list",
    { cwd: cwd ?? "" },
    {
      enabled: asks("communityTools") && cwd !== undefined,
    },
  );
  const plugins = useGentleAiQuery(
    environmentId,
    "plugins.list",
    {},
    { enabled: asks("openCodePlugins") },
  );
  return (
    <div className="grid gap-3">
      {asks("rdd") ? (
        <OptionRow
          label="Receipt-driven development"
          detail="An independent review checks changes before delivery."
          control={<Switch checked={draft.rdd} onCheckedChange={(rdd) => update({ rdd })} />}
        />
      ) : null}
      {asks("openCodeBackground") || asks("piBackground") ? (
        <>
          {(["opencode", "pi"] as const)
            .filter((agent) => asks(agent === "opencode" ? "openCodeBackground" : "piBackground"))
            .map((agent) => (
              <OptionRow
                key={agent}
                label={
                  agent === "opencode" ? "OpenCode background subagents" : "Pi background subagents"
                }
                detail="Let subagents keep working while you continue the conversation."
                control={
                  <Select
                    value={draft.background[agent]}
                    onValueChange={(value) =>
                      update({
                        background: {
                          ...draft.background,
                          [agent]: value === "on" || value === "off" ? value : "auto",
                        },
                      })
                    }
                  >
                    <SelectTrigger size="sm" className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {(["auto", "on", "off"] as const).map((choice) => (
                        <SelectItem key={choice} value={choice}>
                          {BACKGROUND_LABELS[choice]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                }
              />
            ))}
        </>
      ) : null}
      {asks("communityTools") ? (
        <div className="grid gap-1">
          <StepHeading>Community tools</StepHeading>
          {cwd === undefined ? (
            <p className="text-muted-foreground text-xs">
              Add a project to install community tools.
            </p>
          ) : tools.data === null ? (
            <Spinner className="size-3.5" />
          ) : (
            tools.data.tools.map((tool) => (
              <CheckRow
                key={tool.id}
                checked={draft.communityTools.includes(tool.id)}
                onChange={(on) =>
                  update({ communityTools: toggled(draft.communityTools, tool.id, on) })
                }
                label={tool.name}
                detail={tool.description}
              />
            ))
          )}
        </div>
      ) : null}
      {asks("openCodePlugins") ? (
        <div className="grid gap-1">
          <StepHeading>OpenCode plugins</StepHeading>
          {plugins.data === null ? (
            <Spinner className="size-3.5" />
          ) : (
            plugins.data.plugins.map((plugin) => (
              <CheckRow
                key={plugin.id}
                checked={draft.openCodePlugins.includes(plugin.id)}
                onChange={(on) =>
                  update({ openCodePlugins: toggled(draft.openCodePlugins, plugin.id, on) })
                }
                label={plugin.name}
                detail={plugin.description}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function OptionRow(props: {
  readonly label: string;
  readonly detail: string;
  readonly control: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 text-sm">
        <div className="text-foreground">{props.label}</div>
        <div className="text-muted-foreground text-xs">{props.detail}</div>
      </div>
      {props.control}
    </div>
  );
}

function ModelsStep({
  environmentId,
  agents,
  draft,
  update,
  names,
}: Omit<StepProps, "status"> & {
  readonly environmentId: GentleAiSectionProps["environmentId"];
  readonly agents: ReadonlyArray<GentleAiModelAgent>;
  readonly names: GentleAiApiStatus;
}) {
  return (
    <div className="grid gap-4">
      {agents.map((agent) => (
        <AgentModels
          key={agent}
          environmentId={environmentId}
          agent={agent}
          name={names.agents.find((entry) => entry.id === agent)?.name ?? agent}
          draft={draft}
          update={update}
        />
      ))}
    </div>
  );
}

const CUSTOM_MODELS = "__custom__";

function AgentModels({
  environmentId,
  agent,
  name,
  draft,
  update,
}: Omit<StepProps, "status"> & {
  readonly environmentId: GentleAiSectionProps["environmentId"];
  readonly agent: GentleAiModelAgent;
  readonly name: string;
}) {
  const config = useGentleAiQuery(environmentId, "models.get", {
    agent,
    discover: agent === "opencode" || agent === "codex",
  });
  const choice = draft.models[agent];
  const setChoice = (next: NonNullable<GentleAiSetupDraft["models"][GentleAiModelAgent]>) =>
    update({ models: { ...draft.models, [agent]: next } });
  if (config.data === null)
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Spinner className="size-3.5" /> Reading {name} models
        {config.error ? <span className="text-destructive">{config.error}</span> : null}
      </div>
    );
  const selected =
    choice === undefined
      ? (config.data.currentPreset ?? config.data.presets[0]?.id ?? CUSTOM_MODELS)
      : "preset" in choice
        ? choice.preset
        : CUSTOM_MODELS;
  return (
    <div className="grid gap-2">
      <OptionRow
        label={name}
        detail="The model each SDD phase and review uses."
        control={
          <Select
            value={selected}
            onValueChange={(value) => {
              if (value === CUSTOM_MODELS) setChoice({ models: config.data?.current ?? {} });
              else if (value) setChoice({ preset: value });
            }}
          >
            <SelectTrigger size="sm" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {config.data.presets.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.label}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_MODELS}>Custom</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {choice !== undefined && "models" in choice ? (
        <GentleAiModelEditor
          config={config.data}
          value={choice.models}
          onChange={(models) => setChoice({ models })}
        />
      ) : null}
    </div>
  );
}

function ReviewStep({
  status,
  draft,
  plan,
  error,
}: {
  readonly status: GentleAiApiStatus;
  readonly draft: GentleAiSetupDraft;
  readonly plan: GentleAiPlan | null;
  readonly error: string | null;
}) {
  if (plan === null)
    return error ? (
      <p className="text-destructive text-sm">{error}</p>
    ) : (
      <p className="flex items-center gap-2 text-muted-foreground text-sm">
        <Spinner className="size-3.5" /> Planning
      </p>
    );
  const name = (id: string) =>
    status.agents.find((agent) => agent.id === id)?.name ??
    status.components.find((component) => component.id === id)?.name ??
    id;
  const components = plan.components.length > 0 ? plan.components : draftComponents(status, draft);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      <dt className="text-muted-foreground">Agents</dt>
      <dd>{plan.agents.map(name).join(", ")}</dd>
      {plan.unsupportedAgents.length > 0 ? (
        <>
          <dt className="text-muted-foreground">Skipped</dt>
          <dd className="text-warning">
            {plan.unsupportedAgents.map(name).join(", ")} (not supported here)
          </dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">Components</dt>
      <dd>{components.map(name).join(", ")}</dd>
      {plan.addedDependencies.length > 0 ? (
        <>
          <dt className="text-muted-foreground">Also added</dt>
          <dd>{plan.addedDependencies.map(name).join(", ")} (required)</dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">Backup</dt>
      <dd>Agent files are backed up before anything changes.</dd>
    </dl>
  );
}
