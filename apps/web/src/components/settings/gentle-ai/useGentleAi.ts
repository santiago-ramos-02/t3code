import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  decodeGentleAiResult,
  type EnvironmentId,
  type GentleAiJob,
  type GentleAiJobMethod,
  type GentleAiParams,
  type GentleAiQueryMethod,
  type GentleAiResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback } from "react";

import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";

export function gentleAiErrorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : "Gentle AI could not complete that.";
}

/**
 * A read-only Gentle AI API method on one environment. It re-runs when a Gentle AI job
 * finishes, since jobs change what gentle-ai reports.
 */
export function useGentleAiQuery<M extends GentleAiQueryMethod>(
  environmentId: EnvironmentId,
  method: M,
  params: GentleAiParams<M>,
  options: { readonly enabled?: boolean } = {},
) {
  const view = useEnvironmentQuery(
    options.enabled === false
      ? null
      : serverEnvironment.gentleAiQuery({ environmentId, input: { method, params } }),
  );
  const data: GentleAiResult<M> | null =
    view.data === null ? null : Option.getOrNull(decodeGentleAiResult(method, view.data.data));
  return { ...view, data };
}

/** The environment's Gentle AI job and a way to start one. Every client sees the same job. */
export function useGentleAiJob(environmentId: EnvironmentId) {
  const view = useEnvironmentQuery(serverEnvironment.gentleAiJob({ environmentId, input: {} }));
  const start = useAtomCommand(serverEnvironment.startGentleAiJob, {
    reportFailure: false,
    reportDefect: false,
  });
  const job = view.data ?? null;
  const running = job?.phase === "running";

  /** Starts a job: its id, or why the server refused it. */
  const startJob = useCallback(
    async <M extends GentleAiJobMethod>(
      method: M,
      params: GentleAiParams<M>,
    ): Promise<{ readonly jobId: string } | { readonly error: string } | null> => {
      const result = await start({ environmentId, input: { method, params } });
      if (result._tag === "Success") return { jobId: result.value.id };
      if (isAtomCommandInterrupted(result)) return null;
      return { error: gentleAiErrorText(squashAtomCommandFailure(result)) };
    },
    [environmentId, start],
  );

  return { job, running, startJob };
}

/** A finished job's result, typed by its method, or null while running or on failure. */
export function gentleAiJobResult<M extends GentleAiJobMethod>(
  job: GentleAiJob | null,
  method: M,
): GentleAiResult<M> | null {
  if (job === null || job.method !== method || job.phase !== "succeeded") return null;
  return Option.getOrNull(decodeGentleAiResult(method, job.result));
}
