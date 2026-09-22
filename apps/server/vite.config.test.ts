import { describe, expect, it } from "vite-plus/test";

import serverConfig, {
  SERVER_BUNDLE_WATCH_ENV_VAR,
  SERVER_BUNDLE_WATCH_ENV_VALUE,
  isServerBundleWatcherBuild,
  resolveServerPackClean,
} from "./vite.config.ts";
import { SERVER_BUNDLE_WATCH_ENV_VAR as desktopWatcherEnvVar } from "../desktop/scripts/server-bundle-watcher.mjs";

describe("server pack clean policy", () => {
  it("keeps dist cleaning enabled for ordinary builds", () => {
    expect(resolveServerPackClean({})).toBe(true);
    expect(isServerBundleWatcherBuild({})).toBe(false);
  });

  it("disables dist cleaning only for the desktop bundle watcher", () => {
    const watcherEnv = { [SERVER_BUNDLE_WATCH_ENV_VAR]: SERVER_BUNDLE_WATCH_ENV_VALUE };
    expect(isServerBundleWatcherBuild(watcherEnv)).toBe(true);
    expect(resolveServerPackClean(watcherEnv)).toBe(false);
  });

  it("ignores unrelated flag values", () => {
    expect(resolveServerPackClean({ [SERVER_BUNDLE_WATCH_ENV_VAR]: "0" })).toBe(true);
    expect(resolveServerPackClean({ [SERVER_BUNDLE_WATCH_ENV_VAR]: "" })).toBe(true);
    expect(resolveServerPackClean({ SOME_OTHER_FLAG: "1" })).toBe(true);
  });

  it("wires the resolved policy into the pack config", () => {
    const pack = serverConfig.pack as { clean?: unknown } | undefined;
    expect(pack?.clean).toBe(resolveServerPackClean(process.env));
  });

  it("shares the watcher flag with the desktop bundle watcher", () => {
    expect(desktopWatcherEnvVar).toBe(SERVER_BUNDLE_WATCH_ENV_VAR);
  });
});
