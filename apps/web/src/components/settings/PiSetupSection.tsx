import type { ServerProvider } from "@t3tools/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { piModelProviderCounts } from "./PiModelProvidersSection";
import { SettingsRow } from "./settingsLayout";

const PI_INSTALL_COMMAND = "npm install -g @earendil-works/pi-coding-agent@latest";

type PiSetupStep = "install" | "connect";

/**
 * One-time Pi steps still missing on the selected environment. Empty once Pi is installed and
 * reports at least one model provider; Gentle AI installs from its own section.
 */
export function piSetupSteps(provider: ServerProvider | undefined): ReadonlyArray<PiSetupStep> {
  if (!provider?.enabled) return [];
  if (!provider.installed) return ["install"];
  const checked = provider.status === "ready" || provider.status === "warning";
  return checked && piModelProviderCounts(provider).length === 0 ? ["connect"] : [];
}

/** Rows for the Pi card's Setup section; render only when `piSetupSteps` is non-empty. */
export function PiSetupSection({ steps }: { readonly steps: ReadonlyArray<PiSetupStep> }) {
  return (
    <>
      {steps.includes("install") ? (
        <SettingsRow
          title="Install Pi"
          description="Run this once in a terminal on this machine, then refresh provider status."
          control={<CopyCommand command={PI_INSTALL_COMMAND} />}
        />
      ) : null}
      {steps.includes("connect") ? (
        <SettingsRow
          title="Connect a model provider"
          description={
            <span>
              Run <code className="text-foreground">pi</code> once and use{" "}
              <code className="text-foreground">/login</code>, or add an API key under Environment
              below. Then refresh provider status.
            </span>
          }
          control={<CopyCommand command="pi" />}
        />
      ) : null}
    </>
  );
}

function CopyCommand({ command }: { readonly command: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div className="flex w-full min-w-0 items-center justify-end gap-1.5 @min-[32rem]/settings-row:w-auto">
      <code className="min-w-0 truncate font-mono text-xs text-foreground">{command}</code>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Copy ${command}`}
        onClick={() => copyToClipboard(command)}
      >
        {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}
