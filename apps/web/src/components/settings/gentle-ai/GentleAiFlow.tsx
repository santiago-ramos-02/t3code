import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../../ui/button";
import { SettingsGroup } from "../SettingsGroup";

/**
 * A Gentle AI flow that takes over the settings page in place of a dialog: a back arrow and
 * title, the flow's content, and its actions. Settings navigation stays in view around it.
 */
export function GentleAiFlowHeader({
  title,
  description,
  onBack,
  children,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly onBack: () => void;
  /** Step indicator or other context under the title. */
  readonly children?: ReactNode;
}) {
  return (
    <header className="space-y-3">
      <div className="flex items-start gap-2">
        <Button size="icon-sm" variant="ghost" aria-label="Back to Gentle AI" onClick={onBack}>
          <ArrowLeftIcon aria-hidden />
        </Button>
        <div className="min-w-0">
          <h2 className="font-medium text-base text-foreground">{title}</h2>
          {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
        </div>
      </div>
      {children}
    </header>
  );
}

/** The flow's content, on the same surface as settings sections. */
export function GentleAiFlowPanel({ children }: { readonly children: ReactNode }) {
  return (
    <SettingsGroup divided={false}>
      <div className="min-w-0 space-y-4 px-4 py-4 sm:px-5">{children}</div>
    </SettingsGroup>
  );
}

/** The flow's actions; `leading` holds Back-style actions on the left. */
export function GentleAiFlowFooter({
  children,
  leading,
}: {
  readonly children: ReactNode;
  readonly leading?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex gap-2">{leading}</div>
      <div className="flex flex-wrap justify-end gap-2">{children}</div>
    </div>
  );
}
