import {
  gentleAiAgentList,
  gentleAiModelAgent,
  type GentleAiAgentState,
} from "@t3tools/client-runtime/gentle-ai";
import { BotIcon } from "lucide-react";
import { useRef, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import {
  ClaudeAI,
  CursorIcon,
  Gemini,
  GithubCopilotIcon,
  type Icon,
  KiroIcon,
  OpenAI,
  OpenCodeIcon,
  PiAgentIcon,
} from "../../Icons";
import { Button } from "../../ui/button";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { GentleAiAgentModelsRow } from "./GentleAiModels";
import { GentleAiOpenCodePlugins } from "./GentleAiOpenCodePlugins";
import type { GentleAiSectionProps } from "./GentleAiSettingsPage";

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

const STATE_LABELS = {
  "set-up": "Set up",
  available: "Not set up",
  unsupported: "Not supported on this system",
} satisfies Record<GentleAiAgentState, string>;

function AgentIcon({ id }: { readonly id: string }) {
  const Glyph = AGENT_ICONS[id] ?? BotIcon;
  return <Glyph aria-hidden className="size-4 shrink-0 text-foreground/80" />;
}

/**
 * Every agent Gentle AI set up or can set up, like the Providers list: pick one on the left, see
 * and change what Gentle AI does in it on the right. Narrow layouts stack the two.
 */
export function GentleAiAgentsSection({
  selectedAgent,
  onSelectAgent,
  agentExtras,
  ...props
}: GentleAiSectionProps & {
  readonly selectedAgent: string | null;
  readonly onSelectAgent: (agent: string) => void;
  /** Settings an agent brings along, such as gentle-pi's for Pi. */
  readonly agentExtras: Readonly<Record<string, ReactNode>>;
}) {
  const agents = gentleAiAgentList(props.status);
  const selected = agents.find((agent) => agent.id === selectedAgent) ?? agents[0] ?? null;
  // Narrow layouts stack the panel under the list; bring it into view when an agent is picked.
  const panelRef = useRef<HTMLDivElement>(null);

  return (
    <SettingsSection title="Agents" variant="plain">
      <SettingsGroup
        divided={false}
        className="overflow-hidden @min-[40rem]/providers:grid @min-[40rem]/providers:min-h-80 @min-[40rem]/providers:grid-cols-[14rem_minmax(0,1fr)]"
      >
        <div className="divide-y divide-border/50 border-b border-border/60 bg-muted/10 @min-[40rem]/providers:border-r @min-[40rem]/providers:border-b-0">
          {agents.length === 0 ? (
            <p className="px-4 py-3 text-muted-foreground text-sm">
              No agents found on this environment.
            </p>
          ) : (
            agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                aria-current={agent.id === selected?.id ? "true" : undefined}
                onClick={() => {
                  onSelectAgent(agent.id);
                  panelRef.current?.scrollIntoView({ block: "nearest" });
                }}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-4",
                  agent.id === selected?.id ? "bg-muted/45" : "hover:bg-muted/25",
                )}
              >
                <AgentIcon id={agent.id} />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-foreground text-sm">
                    {agent.name}
                  </span>
                  <span
                    className={cn(
                      "block truncate text-xs",
                      agent.state === "set-up" ? "text-success" : "text-muted-foreground",
                    )}
                  >
                    {STATE_LABELS[agent.state]}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
        <div ref={panelRef} className="min-w-0 scroll-mt-4 space-y-6 p-4">
          {selected === null ? null : (
            <AgentPanel
              {...props}
              key={selected.id}
              agent={selected}
              extras={agentExtras[selected.id]}
            />
          )}
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}

function AgentPanel({
  agent,
  extras,
  ...props
}: GentleAiSectionProps & {
  readonly agent: ReturnType<typeof gentleAiAgentList>[number];
  readonly extras: ReactNode;
}) {
  const modelAgent = gentleAiModelAgent(agent.id);
  return (
    <>
      <SettingsSection title={agent.name} icon={<AgentIcon id={agent.id} />}>
        {agent.state === "set-up" ? (
          <>
            {modelAgent === null ? null : (
              <GentleAiAgentModelsRow {...props} agent={modelAgent} name={agent.name} />
            )}
            <SettingsRow
              title="Remove Gentle AI"
              description={
                props.projects.length === 0
                  ? "Removing needs a project on this environment. Add one first."
                  : `Removes what Gentle AI added to ${agent.name}. Other agents keep their setup.`
              }
              control={
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={props.disabled || props.projects.length === 0}
                  onClick={() => props.openFlow({ kind: "uninstall", agent: agent.id })}
                >
                  Remove
                </Button>
              }
            />
          </>
        ) : agent.state === "available" ? (
          <SettingsRow
            title="Not set up"
            description={`Adds Gentle AI's memory, skills, and workflow to ${agent.name}, with the setup your other agents use.`}
            control={
              <Button
                size="sm"
                disabled={props.disabled}
                onClick={() => props.openFlow({ kind: "setup", agent: agent.id })}
              >
                Set up
              </Button>
            }
          />
        ) : (
          <SettingsRow
            title="Not supported"
            description={`Gentle AI can't set up ${agent.name} on this system.`}
          />
        )}
      </SettingsSection>
      {agent.id === "opencode" && agent.state === "set-up" ? (
        <GentleAiOpenCodePlugins {...props} />
      ) : null}
      {agent.id === "pi" && extras === undefined ? (
        <SettingsSection title="gentle-pi">
          <SettingsRow
            title="Profiles and persona"
            description="Gentle AI works in Pi through gentle-pi. Turn on the Pi provider in Providers to manage its profiles and persona here."
          />
        </SettingsSection>
      ) : (
        extras
      )}
    </>
  );
}
