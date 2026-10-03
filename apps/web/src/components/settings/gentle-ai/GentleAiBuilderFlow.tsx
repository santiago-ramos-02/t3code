import type { GentleAiResult } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { Button } from "../../ui/button";
import { Label } from "../../ui/label";
import { Radio, RadioGroup } from "../../ui/radio-group";
import { Spinner } from "../../ui/spinner";
import { Textarea } from "../../ui/textarea";
import { WizardSteps } from "../../ui/wizard";
import { GentleAiFlowFooter, GentleAiFlowHeader, GentleAiFlowPanel } from "./GentleAiFlow";
import { gentleAiNames } from "./gentleAiSections.logic";
import type { GentleAiSectionProps } from "./GentleAiSettingsPage";
import { gentleAiJobResult, useGentleAiJob, useGentleAiQuery } from "./useGentleAi";

const STEPS = ["Engine", "Describe", "Generate"] as const;

type Engines = GentleAiResult<"builder.engines">["engines"];

/** Creating an agent, in place of the page; waits for the engines list first. */
export function GentleAiBuilderFlow(
  props: GentleAiSectionProps & { readonly onClose: () => void },
) {
  const engines = useGentleAiQuery(props.environmentId, "builder.engines", {});
  if (engines.data === null)
    return (
      <section className="space-y-4">
        <GentleAiFlowHeader title="Create a custom agent" onBack={props.onClose} />
        <GentleAiFlowPanel>
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            {engines.error ?? (
              <>
                <Spinner className="size-3.5" /> Reading engines
              </>
            )}
          </p>
        </GentleAiFlowPanel>
      </section>
    );
  return <BuilderWizard {...props} engines={engines.data.engines} />;
}

/**
 * Engine and description, then generation and a preview to install. A generation runs as the
 * environment's job, so leaving and coming back picks up the one in progress.
 */
function BuilderWizard({
  environmentId,
  status,
  disabled,
  onClose,
  engines,
}: GentleAiSectionProps & {
  readonly onClose: () => void;
  readonly engines: Engines;
}) {
  const { job, startJob } = useGentleAiJob(environmentId);
  const resumed = job?.method === "builder.generate" ? job.id : null;
  const names = useMemo(() => gentleAiNames(status), [status]);
  const [step, setStep] = useState(resumed === null ? 0 : 2);
  const [engineChoice, setEngineChoice] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [generationJobId, setGenerationJobId] = useState<string | null>(resumed);
  // The engine that produced the preview; gentle-ai records it with the installed agent.
  const [generatedWith, setGeneratedWith] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const engine =
    engines.find((entry) => entry.id === engineChoice && entry.available) ??
    engines.find((entry) => entry.available) ??
    null;
  const generationJob = generationJobId !== null && job?.id === generationJobId ? job : null;
  const preview = gentleAiJobResult(generationJob, "builder.generate");
  const reachable = [true, engine !== null, prompt.trim() !== "", generationJobId !== null];

  const generate = async () => {
    if (engine === null || prompt.trim() === "") return;
    setActionError(null);
    setStarting(true);
    const started = await startJob("builder.generate", {
      engine: engine.id,
      prompt: prompt.trim(),
    });
    setStarting(false);
    if (started === null) return;
    if ("error" in started) {
      setActionError(started.error);
      return;
    }
    setGenerationJobId(started.jobId);
    setGeneratedWith(engine.id);
    setStep(2);
  };

  const install = async () => {
    // A resumed generation's engine is not known here; the chosen one is recorded instead.
    const recordedEngine = generatedWith ?? engine?.id;
    if (preview === null || recordedEngine === undefined) return;
    setActionError(null);
    setStarting(true);
    const started = await startJob("builder.install", {
      agent: preview.agent,
      engine: recordedEngine,
    });
    setStarting(false);
    if (started === null) return;
    if ("error" in started) {
      setActionError(started.error);
      return;
    }
    // The page's job panel reports the install from here.
    onClose();
  };

  const busy = disabled || starting;

  return (
    <section className="space-y-4">
      <GentleAiFlowHeader
        title="Create a custom agent"
        description="Describe what it should do. One of your agents writes it, and Gentle AI adds it to the rest."
        onBack={onClose}
      >
        <WizardSteps
          steps={STEPS}
          currentStep={step}
          isStepDisabled={(index) => starting || !reachable.slice(0, index + 1).every(Boolean)}
          onStepChange={(index) => {
            setActionError(null);
            setStep(index);
          }}
        />
      </GentleAiFlowHeader>
      <GentleAiFlowPanel>
        <div className="space-y-3">
          {step === 0 ? (
            <RadioGroup
              aria-label="Engine"
              value={engine?.id ?? ""}
              onValueChange={(value) => {
                if (typeof value === "string") setEngineChoice(value);
              }}
            >
              {engines.map((entry) => (
                <Label key={entry.id}>
                  <Radio value={entry.id} disabled={!entry.available} />
                  {entry.name}
                  {entry.available ? null : (
                    <span className="font-normal text-muted-foreground text-xs">Not installed</span>
                  )}
                </Label>
              ))}
            </RadioGroup>
          ) : step === 1 ? (
            <>
              <Label htmlFor="gentle-ai-builder-prompt">What should the agent do?</Label>
              <Textarea
                id="gentle-ai-builder-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Reviews database migrations for locking and rollback risks."
                autoFocus
              />
            </>
          ) : generationJob === null ? (
            <p className="text-muted-foreground text-sm">
              A newer Gentle AI task replaced this one. Generate again to try once more.
            </p>
          ) : generationJob.phase === "running" ? (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm">
                <Spinner className="size-3.5" />
                Generating with {engine?.name ?? "the engine"}. This can take a few minutes.
              </p>
              {generationJob.log.length > 0 ? (
                <p className="truncate font-mono text-muted-foreground text-xs">
                  {generationJob.log.at(-1)}
                </p>
              ) : null}
            </div>
          ) : preview === null ? (
            <p className="text-destructive text-sm">
              {generationJob.error ?? "Generation failed."}
            </p>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="space-y-0.5">
                <p className="font-medium">{preview.agent.name}</p>
                <p className="text-muted-foreground">{preview.agent.description}</p>
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-y py-2 font-mono text-xs">
                {preview.agent.content}
              </pre>
              <p className="text-muted-foreground">
                Installs to{" "}
                {preview.targets.length > 0
                  ? preview.targets.map((id) => names.get(id) ?? id).join(", ")
                  : "no agents"}
                .
              </p>
              {preview.conflicts.length > 0 ? (
                <p className="text-warning">
                  An agent with this name already exists in{" "}
                  {preview.conflicts.map((id) => names.get(id) ?? id).join(", ")}.
                </p>
              ) : null}
            </div>
          )}
          {actionError ? (
            <p role="alert" className="text-destructive text-sm">
              {actionError}
            </p>
          ) : null}
        </div>
      </GentleAiFlowPanel>
      <GentleAiFlowFooter
        leading={
          step > 0 ? (
            <Button
              variant="ghost"
              disabled={starting}
              onClick={() => {
                setActionError(null);
                setStep(step - 1);
              }}
            >
              Back
            </Button>
          ) : undefined
        }
      >
        {step === 0 ? (
          <Button disabled={!reachable[1]} onClick={() => setStep(1)}>
            Next
          </Button>
        ) : step === 1 ? (
          <Button disabled={busy || !reachable[2]} onClick={() => void generate()}>
            Generate
          </Button>
        ) : (
          <>
            <Button variant="outline" disabled={busy} onClick={() => void generate()}>
              Regenerate
            </Button>
            <Button disabled={busy || preview === null} onClick={() => void install()}>
              Install
            </Button>
          </>
        )}
      </GentleAiFlowFooter>
    </section>
  );
}
