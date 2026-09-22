import * as NodePath from "node:path";

// Standalone dev script: spawns the runner's own Node, no Effect runtime here.
const currentNodeExecutable = process.execPath;

// Desktop native dev rebuilds the server bundle while Electron runs. The dev
// runner performs one initial `t3#build`; without a watcher, edits under
// `apps/server/src/**` never rebuild `apps/server/dist/bin.mjs`, so the
// running native backend goes stale while renderer HMR moves on.
//
// The watcher runs Vite+ through the current Node executable and the
// repo-local `node_modules/vite-plus/bin/vp` script, never a PATH-resolved
// `vp` (which may not exist for the spawned dev-electron process). There is
// intentionally no Windows fallback (no `.cmd`/`.exe` suffix, no `wsl.exe`
// bridging, no `shell: true`).
//
// The child env carries SERVER_BUNDLE_WATCH_ENV_VAR so the server config can
// disable `pack.clean` for this process only: dev-electron holds a directory
// watcher on `apps/server/dist`, and a watch-mode clean would remove that
// directory out from under it.
export const SERVER_BUNDLE_WATCH_ENV_VAR = "T3CODE_SERVER_BUNDLE_WATCH";
export const SERVER_BUNDLE_WATCH_ENV_VALUE = "1";
export const SERVER_BUNDLE_WATCH_ARGS = Object.freeze(["pack", "--watch"]);

const watcherStopTimeoutMs = 1_500;

// Children stopped through stopServerBundleWatcher exit expectedly; their
// exit/error events must not surface as dev failures.
const expectedWatcherExits = new WeakSet();

export function resolveServerDir(desktopDir) {
  return NodePath.resolve(desktopDir, "../server");
}

export function resolveRepoRoot(desktopDir) {
  return NodePath.resolve(desktopDir, "../..");
}

export function resolveVitePlusScriptPath(desktopDir) {
  return NodePath.join(resolveRepoRoot(desktopDir), "node_modules", "vite-plus", "bin", "vp");
}

export function resolveServerBundleWatcherSpec({
  desktopDir,
  env,
  nodeExecutable = currentNodeExecutable,
}) {
  return {
    command: nodeExecutable,
    args: [resolveVitePlusScriptPath(desktopDir), ...SERVER_BUNDLE_WATCH_ARGS],
    options: {
      cwd: resolveServerDir(desktopDir),
      env: {
        ...env,
        [SERVER_BUNDLE_WATCH_ENV_VAR]: SERVER_BUNDLE_WATCH_ENV_VALUE,
      },
      stdio: "inherit",
    },
  };
}

function toFailureError(value, exitDetails) {
  if (value instanceof Error) {
    return value;
  }

  return new Error(
    `Desktop server bundle watcher "vp pack --watch" failed${exitDetails}: ${String(value)}`,
  );
}

export function startServerBundleWatcher({ spawnImpl, desktopDir, env, onFailure }) {
  const spec = resolveServerBundleWatcherSpec({ desktopDir, env });
  const child = spawnImpl(spec.command, spec.args, spec.options);

  if (child && typeof child.once === "function" && typeof onFailure === "function") {
    child.once("error", (error) => {
      if (expectedWatcherExits.has(child)) {
        return;
      }

      const cause = error instanceof Error ? error : toFailureError(error, "");
      onFailure(
        new Error(
          `Desktop server bundle watcher "vp pack --watch" failed in ${spec.options.cwd}: ${cause.message}`,
          { cause },
        ),
      );
    });

    child.once("exit", (code, signal) => {
      if (expectedWatcherExits.has(child)) {
        return;
      }

      const details =
        signal !== null && signal !== undefined
          ? ` with signal ${signal}`
          : ` with exit code ${code}`;
      onFailure(
        new Error(
          `Desktop server bundle watcher "vp pack --watch" exited unexpectedly${details} in ${spec.options.cwd}. The native backend may be stale; restart desktop dev.`,
        ),
      );
    });
  }

  return child;
}

export function stopServerBundleWatcher(child) {
  if (!child || typeof child.kill !== "function") {
    return Promise.resolve();
  }

  expectedWatcherExits.add(child);

  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    if (typeof child.once === "function") {
      child.once("exit", finish);
    }

    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }

    if (typeof child.once !== "function") {
      finish();
      return;
    }

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      try {
        child.kill("SIGKILL");
      } catch {
        // The child already exited; finishing below is enough.
      }

      finish();
    }, watcherStopTimeoutMs);

    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });
}
