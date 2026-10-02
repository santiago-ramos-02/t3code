import { gentleAiAgentList, gentleAiModelAgent } from "@t3tools/client-runtime/gentle-ai";
import type { ProviderInstanceId, ServerProviderModel } from "@t3tools/contracts";
import { BotIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  ClaudeAI,
  CursorIcon,
  type Icon,
  KiroIcon,
  OpenAI,
  OpenCodeIcon,
  PiAgentIcon,
} from "../../Icons";
import { Gemini, GithubCopilotIcon } from "./agentIcons";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import {
  GentleAiClaudeProfilesSection,
  GentleAiClaudeProfileSelect,
  useGentleAiClaudeProfiles,
} from "./GentleAiClaudeProfiles";
import { GentleAiFlowHeader } from "./GentleAiFlow";
import {
  GentleAiAgentModelsRow,
  GentleAiModelPresetSelect,
  useGentleAiModelPreset,
} from "./GentleAiModels";
import { GentleAiPluginRows, GentleAiPlugins } from "./GentleAiPlugins";
import type { GentleAiSectionProps } from "./GentleAiSettingsPage";
import { PiGentleProfileSelect, usePiGentleProfiles } from "./PiGentleProfileSelect";

const AGENT_ICONS: Readonly<Record<string, Icon>> = {
  "claude-code": ClaudeAI,
  codex: OpenAI,
  cursor: CursorIcon,
  "gemini-cli": Gemini,
  "kiro-ide": KiroIcon,
  opencode: OpenCodeIcon,
  pi: PiAgentIcon,
  "vscode-copilot": GithubCopilotIcon,
};

function AgentIcon({ id }: { readonly id: string }) {
  const Glyph = AGENT_ICONS[id] ?? BotIcon;
  return <Glyph aria-hidden className="size-4 shrink-0 text-foreground/80" />;
}

/** A Pi provider that runs with Gentle AI, whose gentle-pi profiles the page can switch. */
export interface GentleAiPiProvider {
  readonly instanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

type Agent = ReturnType<typeof gentleAiAgentList>[number];

/**
 * The agents Gentle AI is set up in, each with the profile or models it runs and a switch for
 * them, so everyday changes happen without opening anything. Agents it could still set up sit
 * in the Add menu.
 */
export function GentleAiAgentsSection({
  piProvider,
  ...props
}: GentleAiSectionProps & { readonly piProvider: GentleAiPiProvider | null }) {
  const agents = gentleAiAgentList(props.status);
  const setUp = agents.filter((agent) => agent.state === "set-up");
  const available = agents.filter((agent) => agent.state === "available");

  return (
    <SettingsSection
      title="Your agents"
      headerAction={
        available.length === 0 ? null : (
          <Menu>
            <MenuTrigger render={<Button size="xs" variant="outline" disabled={props.disabled} />}>
              <PlusIcon className="size-3" aria-hidden />
              Add agent
            </MenuTrigger>
            <MenuPopup align="end">
              {available.map((agent) => (
                <MenuItem
                  key={agent.id}
                  onClick={() => props.openFlow({ kind: "setup", agent: agent.id })}
                >
                  <AgentIcon id={agent.id} />
                  {agent.name}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        )
      }
    >
      {setUp.length === 0 ? (
        <SettingsRow
          title="Gentle AI isn't set up in any agent yet"
          description="It adds memory, skills, a review before delivery, and a workflow for bigger changes to the agents you use."
          control={
            <Button
              size="sm"
              disabled={props.disabled}
              onClick={() => props.openFlow({ kind: "setup" })}
            >
              Set up
            </Button>
          }
        />
      ) : (
        setUp.map((agent) =>
          agent.id === "claude-code" && props.claudeProfiles ? (
            <ClaudeAgentRow key={agent.id} {...props} agent={agent} />
          ) : agent.id === "pi" ? (
            <PiAgentRow key={agent.id} {...props} agent={agent} piProvider={piProvider} />
          ) : (
            <PresetAgentRow key={agent.id} {...props} agent={agent} />
          ),
        )
      )}
    </SettingsSection>
  );
}

function AgentRow({
  agent,
  summary,
  switcher,
  props,
}: {
  readonly agent: Agent;
  readonly summary: ReactNode;
  readonly switcher: ReactNode;
  readonly props: GentleAiSectionProps;
}) {
  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <AgentIcon id={agent.id} />
          {agent.name}
        </span>
      }
      description={summary}
      control={
        <div className="flex items-center gap-2">
          {switcher}
          <Button
            size="sm"
            variant="outline"
            onClick={() => props.openFlow({ kind: "agent", agent: agent.id })}
          >
            Open
            <ChevronRightIcon aria-hidden />
          </Button>
        </div>
      }
    />
  );
}

function ClaudeAgentRow({ agent, ...props }: GentleAiSectionProps & { readonly agent: Agent }) {
  const profiles = useGentleAiClaudeProfiles(props);
  return (
    <AgentRow
      agent={agent}
      props={props}
      summary={profiles.summary}
      switcher={<GentleAiClaudeProfileSelect profiles={profiles} disabled={props.disabled} />}
    />
  );
}

function PiAgentRow({
  agent,
  piProvider,
  ...props
}: GentleAiSectionProps & {
  readonly agent: Agent;
  readonly piProvider: GentleAiPiProvider | null;
}) {
  if (piProvider === null) {
    return (
      <AgentRow
        agent={agent}
        props={props}
        summary="Turn on the Pi provider in Providers to switch gentle-pi profiles here."
        switcher={null}
      />
    );
  }
  return <PiProfileAgentRow {...props} agent={agent} piProvider={piProvider} />;
}

function PiProfileAgentRow({
  agent,
  piProvider,
  ...props
}: GentleAiSectionProps & { readonly agent: Agent; readonly piProvider: GentleAiPiProvider }) {
  const profiles = usePiGentleProfiles({
    environmentId: props.environmentId,
    instanceId: piProvider.instanceId,
    models: piProvider.models,
  });
  return (
    <AgentRow
      agent={agent}
      props={props}
      summary={profiles.summary}
      switcher={<PiGentleProfileSelect profiles={profiles} disabled={props.disabled} />}
    />
  );
}

function PresetAgentRow({ agent, ...props }: GentleAiSectionProps & { readonly agent: Agent }) {
  const modelAgent = gentleAiModelAgent(agent.id);
  if (modelAgent === null) {
    return (
      <AgentRow
        agent={agent}
        props={props}
        summary="Gentle AI's memory, skills, and workflow."
        switcher={null}
      />
    );
  }
  return <ModelPresetAgentRow {...props} agent={agent} modelAgent={modelAgent} />;
}

function ModelPresetAgentRow({
  agent,
  modelAgent,
  ...props
}: GentleAiSectionProps & {
  readonly agent: Agent;
  readonly modelAgent: NonNullable<ReturnType<typeof gentleAiModelAgent>>;
}) {
  const preset = useGentleAiModelPreset({ ...props, agent: modelAgent });
  return (
    <AgentRow
      agent={agent}
      props={props}
      summary={preset.summary}
      switcher={
        <GentleAiModelPresetSelect preset={preset} name={agent.name} disabled={props.disabled} />
      }
    />
  );
}

/**
 * One agent's own page, in place of the list: its models or profiles, plugins, what it brings
 * along (gentle-pi's profiles, persona, and project overrides for Pi), and removing Gentle AI
 * from it alone.
 */
export function GentleAiAgentFlow({
  agentId,
  extras,
  onClose,
  ...props
}: GentleAiSectionProps & {
  readonly agentId: string;
  /** Settings the agent brings along, such as gentle-pi's for Pi, given rows to show with them. */
  readonly extras: ((extraRows: ReactNode) => ReactNode) | undefined;
  readonly onClose: () => void;
}) {
  const agent = gentleAiAgentList(props.status).find((entry) => entry.id === agentId) ?? null;
  if (agent === null) {
    return (
      <section className="space-y-4">
        <GentleAiFlowHeader
          title="Agent not found"
          description="Gentle AI does not know this agent."
          onBack={onClose}
        />
      </section>
    );
  }
  const modelAgent = gentleAiModelAgent(agent.id);
  const setUp = agent.state === "set-up";
  return (
    <section className="space-y-6">
      <GentleAiFlowHeader
        title={agent.name}
        description={
          setUp
            ? `What Gentle AI does in ${agent.name}.`
            : `Gentle AI isn't set up in ${agent.name}.`
        }
        onBack={onClose}
        action={
          setUp ? (
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={props.disabled}
              onClick={() => props.openFlow({ kind: "uninstall", agent: agent.id })}
            >
              Remove from {agent.name}
            </Button>
          ) : null
        }
      />
      {setUp ? (
        <>
          {agent.id === "claude-code" && props.claudeProfiles ? (
            <GentleAiClaudeProfilesSection {...props} />
          ) : null}
          {/* With profiles, Claude Code's phase models are part of each profile. */}
          {modelAgent === null || (agent.id === "claude-code" && props.claudeProfiles) ? null : (
            <SettingsSection title="Models">
              <GentleAiAgentModelsRow {...props} agent={modelAgent} name={agent.name} />
            </SettingsSection>
          )}
          {/* Pi's plugins join gentle-pi's settings, so a single plugin is not a card of its own. */}
          {agent.id === "pi" ? (
            extras ? (
              extras(<GentleAiPluginRows {...props} agent="pi" />)
            ) : (
              <SettingsSection title="gentle-pi">
                <SettingsRow
                  title="Pi provider is off"
                  description="Gentle AI works in Pi through gentle-pi. Turn on the Pi provider in Providers to manage its profiles and persona here."
                />
                <GentleAiPluginRows {...props} agent="pi" />
              </SettingsSection>
            )
          ) : (
            extras?.(null)
          )}
          {agent.id === "opencode" ? <GentleAiPlugins {...props} agent="opencode" /> : null}
        </>
      ) : (
        <SettingsSection title={agent.name}>
          <SettingsRow
            title={agent.state === "available" ? "Not set up" : "Not supported"}
            description={
              agent.state === "available"
                ? `Adds Gentle AI's memory, skills, and workflow to ${agent.name}, with the setup your other agents use.`
                : `Gentle AI can't set up ${agent.name} on this system.`
            }
            control={
              agent.state === "available" ? (
                <Button
                  size="sm"
                  disabled={props.disabled}
                  onClick={() => props.openFlow({ kind: "setup", agent: agent.id })}
                >
                  Set up
                </Button>
              ) : null
            }
          />
        </SettingsSection>
      )}
    </section>
  );
}
