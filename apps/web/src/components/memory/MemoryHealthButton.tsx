import type { EnvironmentId } from "@t3tools/contracts";
import { CircleCheckIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/**
 * Engram's own checkup, kept to the header: its version and an icon for how the checks went, with
 * each problem and what Engram suggests doing about it one click away.
 */
export function MemoryHealthButton(props: {
  readonly environmentId: EnvironmentId;
  readonly version: string | null;
}) {
  const health = useEnvironmentQuery(
    serverEnvironment.memoryHealth({ environmentId: props.environmentId, input: {} }),
  ).data;
  const version = props.version ? `Engram ${props.version}` : "Engram";
  const problems = health?.checks.filter((check) => check.result !== "ok") ?? [];
  const severe = problems.some((check) => check.result === "error" || check.result === "blocked");
  const icon =
    health === null ? null : severe ? (
      <CircleXIcon aria-hidden className="text-destructive" />
    ) : problems.length > 0 ? (
      <TriangleAlertIcon aria-hidden className="text-warning" />
    ) : (
      <CircleCheckIcon aria-hidden className="text-success" />
    );
  const status =
    health === null
      ? "checking"
      : problems.length === 0
        ? "healthy"
        : `${problems.length} ${problems.length === 1 ? "problem" : "problems"}`;

  return (
    <Popover>
      <PopoverTrigger
        render={<Button size="xs" variant="ghost" aria-label={`${version}, ${status}`} />}
      >
        {icon}
        {version}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end">
        <div className="flex max-w-80 flex-col gap-3 text-sm">
          <p className="font-medium">
            {health === null
              ? "Checking Engram…"
              : problems.length === 0
                ? "All of Engram's checks pass."
                : `Engram's checkup found ${status}.`}
          </p>
          {problems.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {problems.map((check) => (
                <li key={check.id} className="flex flex-col gap-0.5">
                  <span>{check.message}</span>
                  {check.nextStep ? (
                    <span className="text-xs text-muted-foreground">{check.nextStep}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
