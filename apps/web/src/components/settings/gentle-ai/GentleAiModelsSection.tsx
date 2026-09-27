import type { GentleAiModelAgent, GentleAiModelConfig, GentleAiModels } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { GentleAiFlowFooter, GentleAiFlowHeader, GentleAiFlowPanel } from "./GentleAiFlow";
import { GentleAiModelEditor } from "./GentleAiModelEditor";
import { agentModels, resetAgentModels } from "./GentleAiModelEditor.logic";
import type { GentleAiSectionProps } from "./GentleAiSettingsPage";
import { useGentleAiQuery } from "./useGentleAi";

const MODEL_AGENTS = [
  "claude-code",
  "codex",
  "kiro-ide",
  "opencode",
] as const satisfies ReadonlyArray<GentleAiModelAgent>;
// Codex and OpenCode list the models their CLI can reach, which takes a moment to discover.
const DISCOVERS: ReadonlySet<GentleAiModelAgent> = new Set(["codex", "opencode"]);
// Select value shown while the agent's choices match no preset.
const CUSTOM = "__custom__";

/** Which model each phase of Gentle AI's workflows runs on, per agent Gentle AI set up. */
export function GentleAiModelsSection(props: GentleAiSectionProps) {
  const agents = props.status.agents.flatMap((agent) => {
    const id = MODEL_AGENTS.find((candidate) => candidate === agent.id);
    return agent.installed && id !== undefined ? [{ id, name: agent.name }] : [];
  });
  if (agents.length === 0) return null;

  return (
    <SettingsSection title="Models">
      {agents.map((agent) => (
        <AgentModelsRow key={agent.id} {...props} agent={agent.id} name={agent.name} />
      ))}
    </SettingsSection>
  );
}

function AgentModelsRow({
  environmentId,
  disabled,
  startJob,
  onError,
  openFlow,
  agent,
  name,
}: GentleAiSectionProps & { readonly agent: GentleAiModelAgent; readonly name: string }) {
  const config = useGentleAiQuery(environmentId, "models.get", { agent });
  const run = (promise: Promise<string | null>) =>
    void promise.then((error) => (error ? onError(error) : undefined));
  const data = config.data;
  const preset = data?.presets.find((entry) => entry.id === data.currentPreset);

  return (
    <SettingsRow
      title={name}
      description={
        config.error ??
        (data === null
          ? "Reading model choices…"
          : data.currentPreset === null
            ? "Custom models per phase."
            : (preset?.description ?? null))
      }
      control={
        <div className="flex items-center gap-2">
          {data === null ? (
            config.error ? null : (
              <Spinner className="size-3.5" />
            )
          ) : (
            <Select
              value={data.currentPreset ?? CUSTOM}
              onValueChange={(next) => {
                if (next === null || next === CUSTOM || next === data.currentPreset) return;
                run(startJob("models.set", { agent, preset: next }));
              }}
              disabled={disabled}
            >
              <SelectTrigger size="sm" className="w-40" aria-label={`${name} model preset`}>
                <SelectValue>
                  <span className="truncate">
                    {preset?.label ?? data.currentPreset ?? "Custom"}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                {data.currentPreset === null ? (
                  <SelectItem value={CUSTOM} disabled>
                    Custom
                  </SelectItem>
                ) : null}
                {data.presets.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || data === null}
            onClick={() => openFlow({ kind: "models", agent })}
          >
            Customize
          </Button>
        </div>
      }
    />
  );
}

/** One agent's per-phase models, in place of the page; waits for discovery where needed. */
export function GentleAiModelsFlow({
  environmentId,
  status,
  disabled,
  startJob,
  onError,
  agent: agentId,
  onClose,
}: GentleAiSectionProps & { readonly agent: string; readonly onClose: () => void }) {
  const agent = MODEL_AGENTS.find((candidate) => candidate === agentId) ?? null;
  const name = status.agents.find((entry) => entry.id === agentId)?.name ?? agentId;
  const discovers = agent !== null && DISCOVERS.has(agent);
  const config = useGentleAiQuery(
    environmentId,
    "models.get",
    agent === null ? { agent: "claude-code" } : { agent, ...(discovers ? { discover: true } : {}) },
    { enabled: agent !== null },
  );

  return (
    <section className="space-y-4">
      <GentleAiFlowHeader
        title={`${name} models`}
        description="Phases set to Default use gentle-ai's defaults."
        onBack={onClose}
      />
      {agent === null ? (
        <GentleAiFlowPanel>
          <p className="text-muted-foreground text-sm">
            Gentle AI does not configure models for {name}.
          </p>
        </GentleAiFlowPanel>
      ) : config.data === null ? (
        <GentleAiFlowPanel>
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            {config.error ?? (
              <>
                <Spinner className="size-3.5" />
                {discovers ? `Discovering ${name} models` : `Reading ${name} models`}
              </>
            )}
          </p>
        </GentleAiFlowPanel>
      ) : (
        <ModelsDraft
          agent={agent}
          disabled={disabled}
          config={config.data}
          onSave={(models) => {
            onClose();
            void startJob("models.set", { agent, models }).then((error) =>
              error ? onError(error) : undefined,
            );
          }}
        />
      )}
    </section>
  );
}

function ModelsDraft({
  agent,
  disabled,
  config,
  onSave,
}: {
  readonly agent: GentleAiModelAgent;
  readonly disabled: boolean;
  readonly config: GentleAiModelConfig;
  readonly onSave: (models: GentleAiModels) => void;
}) {
  const [draft, setDraft] = useState(config.current);
  return (
    <>
      <GentleAiFlowPanel>
        <GentleAiModelEditor
          config={config}
          value={draft}
          onChange={setDraft}
          disabled={disabled}
        />
      </GentleAiFlowPanel>
      <GentleAiFlowFooter
        leading={
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => onSave(resetAgentModels(agent))}
          >
            Reset to defaults
          </Button>
        }
      >
        <Button disabled={disabled} onClick={() => onSave(agentModels(agent, draft))}>
          Save
        </Button>
      </GentleAiFlowFooter>
    </>
  );
}
