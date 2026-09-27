import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import { GentleAiConfirm } from "./GentleAiConfirm";
import type { GentleAiSectionProps } from "./GentleAiSettingsPage";
import { useGentleAiQuery } from "./useGentleAi";

const runWith = (onError: (message: string) => void) => (promise: Promise<string | null>) =>
  void promise.then((error) => (error ? onError(error) : undefined));

/** OpenCode community plugins Gentle AI can install, shown on OpenCode's agent panel. */
export function GentleAiOpenCodePlugins({
  environmentId,
  disabled,
  startJob,
  onError,
}: GentleAiSectionProps) {
  const plugins = useGentleAiQuery(environmentId, "plugins.list", {});
  const [removing, setRemoving] = useState<{ readonly id: string; readonly name: string } | null>(
    null,
  );
  const run = runWith(onError);
  const data = plugins.data;

  return (
    <SettingsSection
      title="Plugins"
      headerAction={plugins.isPending && data === null ? <Spinner className="size-3.5" /> : null}
    >
      {plugins.error ? (
        <SettingsRow title="Plugins unavailable" description={plugins.error} />
      ) : data === null ? null : !data.supported ? (
        <SettingsRow
          title="Plugins unavailable"
          description={data.reason ?? "This environment cannot install them."}
        />
      ) : data.plugins.length === 0 ? (
        <SettingsRow
          title="No community plugins"
          description="Gentle AI lists none for this version."
        />
      ) : (
        data.plugins.map((plugin) => (
          <SettingsRow
            key={plugin.id}
            title={
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{plugin.name}</span>
                {plugin.repoUrl ? (
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={`${plugin.name} repository`}
                    render={<a href={plugin.repoUrl} rel="noreferrer" target="_blank" />}
                  >
                    <ExternalLinkIcon aria-hidden />
                  </Button>
                ) : null}
              </span>
            }
            description={plugin.description || "No longer offered by Gentle AI."}
            control={
              plugin.installed ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => setRemoving({ id: plugin.id, name: plugin.name })}
                >
                  Remove
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => run(startJob("plugins.install", { ids: [plugin.id] }))}
                >
                  Install
                </Button>
              )
            }
          />
        ))
      )}
      <GentleAiConfirm
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        title={`Remove ${removing?.name ?? "plugin"}?`}
        description="OpenCode stops loading it. You can install it again later."
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (removing !== null) run(startJob("plugins.uninstall", { id: removing.id }));
        }}
      />
    </SettingsSection>
  );
}
