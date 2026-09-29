import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type GentleAiActionInput,
  type ServerConfig,
} from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { GentleRoseIcon } from "../GentleRoseIcon";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { Spinner } from "../ui/spinner";
import { gentleAiFlowKey, type GentleAiFlow } from "./gentle-ai/gentleAiFlow.logic";
import { GentleAiSettingsPage } from "./gentle-ai/GentleAiSettingsPage";
import { PiGentleSettingsSection } from "./PiGentleSettingsSection";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

type GentleAiAction = GentleAiActionInput["action"];

const ROW_CONTROL = "w-full max-w-full @min-[32rem]/settings-row:w-56";
const ACTION_LABELS = {
  refresh: "Refreshing…",
  update: "Checking…",
  upgrade: "Upgrading…",
  sync: "Syncing…",
  doctor: "Checking…",
} satisfies Record<GentleAiAction, string>;

function errorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : "Gentle AI could not complete that.";
}

/**
 * Gentle AI on one environment: the gentle-ai binary and what it set up, its ecosystem
 * commands, and what each agent adapter adds (today gentle-pi for Pi). Gentle AI is not a
 * provider; it layers onto the providers listed here.
 */
export function GentleAiSettingsPanel({
  environmentId,
  serverConfig,
  projectCwd,
  readOnly,
  flow,
}: {
  readonly environmentId: EnvironmentId;
  readonly serverConfig: ServerConfig;
  readonly projectCwd?: string | undefined;
  readonly readOnly: boolean;
  /** The flow open in place of the page, from the URL. */
  readonly flow: GentleAiFlow | null;
}) {
  const navigate = useNavigate();
  const setFlow = (next: GentleAiFlow | null) =>
    void navigate({
      to: "/settings/gentle-ai",
      search: (previous) => {
        const { flow: _flow, ...rest } = previous;
        return next === null ? rest : { ...rest, flow: gentleAiFlowKey(next) };
      },
    });
  const runAction = useAtomCommand(serverEnvironment.runGentleAiAction, {
    reportFailure: false,
    reportDefect: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const projectGroups = useSettingsProjectGroups();
  // Live: installs, upgrades, and binary path changes all update it.
  const status = useEnvironmentQuery(
    serverEnvironment.gentleAiStatus({ environmentId, input: {} }),
  ).data;
  const [pending, setPending] = useState<GentleAiAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<{ title: string; output: string } | null>(null);
  // Bumped after gentle-ai changes agent assets, so the adapter sections re-read theirs.
  const [refreshKey, setRefreshKey] = useState(0);

  const act = (action: GentleAiAction, reportTitle?: string) => {
    if (pending) return;
    setPending(action);
    setError(null);
    void runAction({ environmentId, input: { action } }).then((result) => {
      setPending(null);
      if (result._tag === "Success") {
        setRefreshKey((value) => value + 1);
        if (reportTitle && result.value.output) {
          setReport({ title: reportTitle, output: result.value.output });
        }
      } else if (!isAtomCommandInterrupted(result)) {
        setError(errorText(squashAtomCommandFailure(result)));
      }
    });
  };

  const gentleProviders = serverConfig.providers.filter((provider) => provider.gentleAi === true);
  const piInstances = gentleProviders.filter((provider) => provider.driver === "pi");
  const canEdit = !readOnly && pending === null;
  const actionButton = (action: GentleAiAction, label: string, reportTitle?: string) => (
    <Button
      size="sm"
      variant="outline"
      disabled={!canEdit || (action !== "refresh" && status?.installed !== true)}
      onClick={() => act(action, reportTitle)}
    >
      {pending === action ? (
        <>
          <Spinner className="size-3.5" /> {ACTION_LABELS[action]}
        </>
      ) : (
        label
      )}
    </Button>
  );

  const projects = projectGroups.flatMap((group) =>
    group.memberProjects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => ({ title: group.displayName, workspaceRoot: project.workspaceRoot })),
  );
  const binaryPathRow = (
    <SettingsRow
      title="Binary path"
      description="Leave blank to use gentle-ai on PATH, then the copy gentle-pi bundles."
      control={
        <DraftInput
          size="sm"
          className={ROW_CONTROL}
          aria-label="Gentle AI binary path"
          value={serverConfig.settings.gentleAiBinaryPath}
          onCommit={(gentleAiBinaryPath) =>
            void updateSettings({
              environmentId,
              input: { patch: { gentleAiBinaryPath } },
            }).then(() => act("refresh"))
          }
          placeholder="gentle-ai"
          disabled={readOnly}
          spellCheck={false}
        />
      }
    />
  );
  const piSections = piInstances.map((provider) => (
    <PiGentleSettingsSection
      key={provider.instanceId}
      environmentId={environmentId}
      instanceId={provider.instanceId}
      title={
        piInstances.length > 1
          ? `gentle-pi · ${provider.displayName ?? provider.instanceId}`
          : "gentle-pi"
      }
      refreshKey={refreshKey}
      models={provider.models}
      initialProjectCwd={projectCwd}
      projects={projects}
      readOnly={readOnly}
    />
  ));

  // A gentle-ai with the headless API gets the full GUI; older ones keep the basic commands.
  if (status?.apiVersion != null) {
    return (
      <SettingsPageContainer className="@container/providers">
        <GentleAiSettingsPage
          environmentId={environmentId}
          readOnly={readOnly}
          flow={flow}
          onFlowChange={setFlow}
          projects={projects.map((project) => ({
            title: project.title,
            cwd: project.workspaceRoot,
          }))}
          agentExtras={piSections.length > 0 ? { pi: piSections } : {}}
          piProvider={
            piInstances[0]
              ? { instanceId: piInstances[0].instanceId, models: piInstances[0].models }
              : null
          }
          claudeProfiles={status?.claudeProfiles === true}
          advancedRows={binaryPathRow}
        />
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer className="@container/providers">
      <SettingsSection
        title="Gentle AI"
        icon={<GentleRoseIcon className="size-5 shrink-0" />}
        headerAction={
          status?.version ? (
            <span className="font-mono text-xs text-muted-foreground">v{status.version}</span>
          ) : null
        }
      >
        {error ? (
          <SettingsRow
            title="Gentle AI could not complete that"
            status={
              <span role="alert" className="text-destructive">
                {error}
              </span>
            }
          />
        ) : null}
        <SettingsRow
          title="Runs with"
          description={
            gentleProviders.length > 0
              ? gentleProviders
                  .map(
                    (provider) =>
                      provider.displayName ??
                      PROVIDER_DISPLAY_NAMES[provider.driver] ??
                      provider.driver,
                  )
                  .join(", ")
              : "No provider on this environment runs with Gentle AI."
          }
        />
        {status === null || status === undefined ? (
          <SettingsRow title="Reading Gentle AI" control={<Spinner className="size-3.5" />} />
        ) : !status.installed ? (
          <SettingsRow
            title="gentle-ai not found"
            description="Profiles and persona still work through gentle-pi. Install gentle-ai or set its binary path for ecosystem commands."
          />
        ) : (
          <>
            <SettingsRow
              title="Setup"
              description={
                [
                  status.preset ? `Preset ${status.preset}` : null,
                  status.persona ? `Persona ${status.persona}` : null,
                  status.components.length > 0 ? status.components.join(", ") : null,
                ]
                  .filter((part) => part !== null)
                  .join(" · ") || "Chosen when gentle-ai installs into an agent."
              }
            />
            <SettingsRow
              title="Agent assets"
              description={
                status.syncNeeded
                  ? "gentle-ai changed since it last updated the agents it set up. Sync brings them up to date."
                  : "The agents gentle-ai set up match its current version."
              }
              control={actionButton("sync", "Sync")}
            />
            <SettingsRow
              title="Updates"
              description="Check gentle-ai and the tools it manages for new versions, or install them."
              control={
                <div className="flex gap-2">
                  {actionButton("update", "Check", "Gentle AI updates")}
                  {actionButton("upgrade", "Upgrade", "Gentle AI upgrade")}
                </div>
              }
            />
            <SettingsRow
              title="Health"
              description="Run gentle-ai's diagnostics for this environment."
              control={actionButton("doctor", "Run doctor", "Gentle AI doctor")}
            />
            <SettingsRow
              title="Full Gentle AI settings"
              description="Upgrade gentle-ai to set it up, configure models, and manage everything its own menu offers from here."
            />
          </>
        )}
        {binaryPathRow}
      </SettingsSection>
      {piSections}
      <Dialog open={report !== null} onOpenChange={(open) => (open ? undefined : setReport(null))}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{report?.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <pre className="whitespace-pre-wrap font-mono text-xs text-foreground">
              {report?.output}
            </pre>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}
