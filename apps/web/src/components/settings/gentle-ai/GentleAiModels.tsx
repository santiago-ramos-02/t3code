import type { GentleAiModelAgent, GentleAiModelConfig, GentleAiModels } from "@t3tools/contracts";
import { gentleAiModelAgent, gentleAiModelsAllDefault } from "@t3tools/client-runtime/gentle-ai";
import { useState } from "react";

import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Skeleton } from "../../ui/skeleton";
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

/** One agent's model choice: its preset, or custom, and what that means in a line. */
export function useGentleAiModelPreset({
  environmentId,
  startJob,
  onError,
  agent,
}: Pick<GentleAiSectionProps, "environmentId" | "startJob" | "onError"> & {
  readonly agent: GentleAiModelAgent;
}) {
  const config = useGentleAiQuery(environmentId, "models.get", { agent });
  const data = config.data;
  const preset = data?.presets.find((entry) => entry.id === data.currentPreset);
  // gentle-ai reports no preset both for custom choices and for none at all.
  const allDefault =
    data !== null && data.currentPreset === null && gentleAiModelsAllDefault(data.current);
  const label = preset?.label ?? data?.currentPreset ?? (allDefault ? "Default" : "Custom");
  const summary =
    config.error ??
    (data === null
      ? null
      : allDefault
        ? "Every step uses Gentle AI's default model."
        : data.currentPreset === null
          ? "Custom models for each step."
          : (preset?.description ?? "The model each step of Gentle AI's workflow uses."));
  const choose = (next: string) =>
    void startJob("models.set", { agent, preset: next }).then((error) =>
      error ? onError(error) : undefined,
    );
  return { agent, data, error: config.error, label, summary, choose };
}

/** Switches an agent's model preset. */
export function GentleAiModelPresetSelect({
  preset,
  name,
  disabled,
}: {
  readonly preset: ReturnType<typeof useGentleAiModelPreset>;
  readonly name: string;
  readonly disabled: boolean;
}) {
  const { data, error, label, choose } = preset;
  if (data === null) return error ? null : <Skeleton className="h-8 w-56" />;
  return (
    <Select
      value={data.currentPreset ?? CUSTOM}
      onValueChange={(next) => {
        if (next === null || next === CUSTOM || next === data.currentPreset) return;
        choose(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger size="sm" className="w-40" aria-label={`${name} model preset`}>
        <SelectValue>
          <span className="truncate">{label}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end">
        {data.currentPreset === null ? (
          <SelectItem value={CUSTOM} disabled>
            {label}
          </SelectItem>
        ) : null}
        {data.presets.map((entry) => (
          <SelectItem key={entry.id} value={entry.id}>
            {entry.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Which model each phase of Gentle AI's workflow runs on in one agent: a preset, or custom. */
export function GentleAiAgentModelsRow(
  props: GentleAiSectionProps & { readonly agent: GentleAiModelAgent; readonly name: string },
) {
  const preset = useGentleAiModelPreset(props);
  return (
    <SettingsRow
      title="Models"
      description={preset.summary}
      control={
        <div className="flex items-center gap-2">
          <GentleAiModelPresetSelect preset={preset} name={props.name} disabled={props.disabled} />
          <Button
            size="sm"
            variant="outline"
            disabled={props.disabled || preset.data === null}
            onClick={() => props.openFlow({ kind: "models", agent: props.agent })}
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
        description="Steps left on Default use Gentle AI's defaults."
        onBack={onClose}
      />
      {agent === null ? (
        <GentleAiFlowPanel>
          <p className="text-muted-foreground text-sm">Gentle AI doesn't set models for {name}.</p>
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
