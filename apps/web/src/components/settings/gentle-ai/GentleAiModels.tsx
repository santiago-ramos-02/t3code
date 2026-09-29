import type { GentleAiModelAgent, GentleAiModelConfig, GentleAiModels } from "@t3tools/contracts";
import { gentleAiModelAgent, gentleAiModelsAllDefault } from "@t3tools/client-runtime/gentle-ai";
import { useState } from "react";

import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { SettingsRow } from "../settingsLayout";
import { GentleAiFlowFooter, GentleAiFlowHeader, GentleAiFlowPanel } from "./GentleAiFlow";
import { GentleAiModelEditor } from "./GentleAiModelEditor";
import { agentModels, resetAgentModels } from "./GentleAiModelEditor.logic";
import type { GentleAiSectionProps } from "./GentleAiSettingsPage";
import { useGentleAiQuery } from "./useGentleAi";

// Codex and OpenCode list the models their CLI can reach; discovering them takes a moment.
// Claude Code's phases pin its slots, whose models a profile sets per proxied provider.
const DISCOVERS: ReadonlySet<GentleAiModelAgent> = new Set(["codex", "opencode"]);
// Select value shown while the agent's choices match no preset.
const CUSTOM = "__custom__";

/** Which model each phase of Gentle AI's workflow runs on in one agent: a preset, or custom. */
export function GentleAiAgentModelsRow({
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
  // gentle-ai reports no preset both for custom choices and for none at all.
  const allDefault =
    data !== null && data.currentPreset === null && gentleAiModelsAllDefault(data.current);
  const presetLabel = preset?.label ?? data?.currentPreset ?? (allDefault ? "Default" : "Custom");

  return (
    <SettingsRow
      title="Models"
      description={
        config.error ??
        (data === null
          ? "Reading model choices…"
          : allDefault
            ? "Every phase uses Gentle AI's default model."
            : data.currentPreset === null
              ? "Custom models per phase."
              : (preset?.description ?? "The model each phase of Gentle AI's workflow uses."))
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
                  <span className="truncate">{presetLabel}</span>
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end">
                {data.currentPreset === null ? (
                  <SelectItem value={CUSTOM} disabled>
                    {presetLabel}
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
  const agent = gentleAiModelAgent(agentId);
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
