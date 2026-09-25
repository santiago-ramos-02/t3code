import type { ServerProvider } from "@t3tools/contracts";

import { SettingsSection } from "./settingsLayout";

/** Model providers Pi reports models for, with their model counts, sorted by name. */
export function piModelProviderCounts(provider: ServerProvider | undefined) {
  const counts = new Map<string, number>();
  for (const model of provider?.models ?? []) {
    if (model.isCustom || !model.subProvider) continue;
    counts.set(model.subProvider, (counts.get(model.subProvider) ?? 0) + 1);
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right));
}

export function PiModelProvidersSection({
  provider,
}: {
  readonly provider: ServerProvider | undefined;
}) {
  const available = piModelProviderCounts(provider);
  const checked =
    provider?.enabled && provider.installed && provider.status === "ready" && available.length > 0;

  return (
    <SettingsSection title="Model providers">
      <div className="px-3 py-3 text-sm sm:px-4">
        {checked ? (
          <div className="divide-y divide-border/60">
            {available.map(([name, count]) => (
              <div
                key={name}
                className="flex items-baseline justify-between gap-4 py-1.5 first:pt-0"
              >
                <span className="min-w-0 break-words">{name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {count} {count === 1 ? "model" : "models"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground">
            {provider?.enabled === false
              ? "Enable Pi to check its model providers."
              : provider?.message?.startsWith("Pi found no available models.")
                ? "No available model providers found."
                : provider?.status === "warning" || provider?.status === "error"
                  ? "Could not verify Pi's model providers. Refresh its status to try again."
                  : "Available model providers will appear after Pi finishes checking."}
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          To connect another provider, run <code className="text-foreground">pi</code> on this
          environment and use <code className="text-foreground">/login</code>, or add its API key in
          the Environment section above. Then refresh Pi status to update the model picker.
        </p>
      </div>
    </SettingsSection>
  );
}
