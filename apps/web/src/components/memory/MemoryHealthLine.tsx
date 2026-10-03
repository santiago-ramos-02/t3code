import type { EnvironmentId } from "@t3tools/contracts";
import { CircleCheckIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/** Engram's own checkup in one line: its version, and the first problem with what to do about it. */
export function MemoryHealthLine(props: {
  readonly environmentId: EnvironmentId;
  readonly version: string | null;
}) {
  const health = useEnvironmentQuery(
    serverEnvironment.memoryHealth({ environmentId: props.environmentId, input: {} }),
  ).data;
  const version = props.version ? `Engram ${props.version}` : "Engram";
  if (!health) return <p className="text-xs text-muted-foreground">{version}</p>;
  const problems = health.checks.filter((check) => check.result !== "ok");
  const first = problems.find((check) => check.result === "error") ?? problems[0];
  if (!first) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CircleCheckIcon aria-hidden className="size-3.5 text-success" />
        {version} · Healthy
      </p>
    );
  }
  const severe = first.result === "error" || first.result === "blocked";
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      {severe ? (
        <CircleXIcon aria-hidden className="mt-px size-3.5 shrink-0 text-destructive" />
      ) : (
        <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
      )}
      <span>
        {version} · <span className="text-foreground">{severe ? "Problem" : "Warning"}:</span>{" "}
        {first.message}
        {first.nextStep ? ` ${first.nextStep}` : ""}
        {problems.length > 1 ? (
          <>
            {" "}
            <Popover>
              <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
                {problems.length - 1} more
              </PopoverTrigger>
              <PopoverPopup side="bottom" align="start" tooltipStyle>
                <ul className="flex max-w-80 flex-col gap-1.5">
                  {problems
                    .filter((check) => check !== first)
                    .map((check) => (
                      <li key={check.id}>
                        {check.message}
                        {check.nextStep ? ` ${check.nextStep}` : ""}
                      </li>
                    ))}
                </ul>
              </PopoverPopup>
            </Popover>
          </>
        ) : null}
      </span>
    </p>
  );
}
