import type { CliProxyAction, EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useState } from "react";

import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export function modelProxyErrorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : "CLIProxyAPI could not do that.";
}

/** Why a management answer is a failure, in the proxy's words when it gave some. */
function managementFailure(status: number, data: unknown): string {
  if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>;
    const nested = record.error;
    const message =
      typeof nested === "object" && nested !== null
        ? (nested as Record<string, unknown>).message
        : (nested ?? record.message);
    if (typeof message === "string" && message !== "") return message;
  }
  if (typeof data === "string" && data.trim() !== "") return data.trim().slice(0, 300);
  return `CLIProxyAPI answered with HTTP ${status}.`;
}

/** CLIProxyAPI on one environment: its live status, actions, and management calls. */
export function useModelProxy(environmentId: EnvironmentId) {
  const status = useEnvironmentQuery(
    serverEnvironment.cliProxyStatus({ environmentId, input: {} }),
  ).data;
  const runAction = useAtomCommand(serverEnvironment.runCliProxyAction, {
    reportFailure: false,
    reportDefect: false,
  });
  const runManagement = useAtomCommand(serverEnvironment.cliProxyManagement, {
    reportFailure: false,
    reportDefect: false,
  });

  /** Runs an action; the error text, or null when it worked. */
  const act = useCallback(
    async (action: CliProxyAction): Promise<string | null> => {
      const result = await runAction({ environmentId, input: { action } });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
      return modelProxyErrorText(squashAtomCommandFailure(result));
    },
    [environmentId, runAction],
  );

  /** One management call; its data, or the error text. */
  const manage = useCallback(
    async (
      method: Method,
      path: string,
      body?: unknown,
    ): Promise<{ readonly data: unknown } | { readonly error: string }> => {
      const result = await runManagement({
        environmentId,
        input: { method, path, ...(body === undefined ? {} : { body }) },
      });
      if (result._tag !== "Success") {
        return {
          error: isAtomCommandInterrupted(result)
            ? "Interrupted."
            : modelProxyErrorText(squashAtomCommandFailure(result)),
        };
      }
      const { status: code, data } = result.value;
      return code >= 200 && code < 300 ? { data } : { error: managementFailure(code, data) };
    },
    [environmentId, runManagement],
  );

  return { status, act, manage };
}

export type ModelProxyManage = ReturnType<typeof useModelProxy>["manage"];

/** A management GET, re-read when `reload` is called or its inputs change. */
export function useManaged(manage: ModelProxyManage, path: string | null) {
  const [state, setState] = useState<{
    readonly path: string | null;
    readonly data: unknown;
    readonly error: string | null;
  }>({ path: null, data: null, error: null });
  // Each reload is a new request; the answer shown stays until the new one arrives.
  const [generation, setGeneration] = useState(0);
  const requestKey = path === null ? null : `${generation} ${path}`;
  useEffect(() => {
    if (requestKey === null) return;
    const separator = requestKey.indexOf(" ");
    const target = requestKey.slice(separator + 1);
    let live = true;
    void manage("GET", target).then((result) => {
      if (!live) return;
      setState(
        "data" in result
          ? { path: target, data: result.data, error: null }
          : { path: target, data: null, error: result.error },
      );
    });
    return () => {
      live = false;
    };
  }, [manage, requestKey]);
  const current = state.path === path ? state : { data: null, error: null };
  return {
    data: current.data,
    error: current.error,
    loading: path !== null && state.path !== path,
    reload: useCallback(() => setGeneration((value) => value + 1), []),
  };
}

/** Several management GETs at once; each answer, or null where it failed. */
export function useManagedAll(manage: ModelProxyManage, paths: ReadonlyArray<string>) {
  // Paths never hold a space, so joining on one keys the effect by content, not identity.
  const key = paths.join(" ");
  const [state, setState] = useState<{
    readonly key: string;
    readonly data: ReadonlyArray<unknown>;
  }>({ key: "", data: [] });
  useEffect(() => {
    let live = true;
    void Promise.all(key.split(" ").map((path) => manage("GET", path))).then((results) => {
      if (live) {
        setState({ key, data: results.map((result) => ("data" in result ? result.data : null)) });
      }
    });
    return () => {
      live = false;
    };
  }, [manage, key]);
  return state.key === key ? state.data : null;
}
