import * as NodeOS from "node:os";

/**
 * The user's home as a process started with this environment sees it: the variable the platform
 * reads for it, otherwise this process's own home. Pass the environment a provider runs with, so
 * per-instance overrides and tests resolve the same folders the provider will.
 */
export function hostUserHome(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return (
    (platform === "win32" ? environment.USERPROFILE : environment.HOME)?.trim() || NodeOS.homedir()
  );
}
