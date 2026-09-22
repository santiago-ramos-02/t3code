import * as NodeEvents from "node:events";
import * as NodePath from "node:path";
import { assert, describe, it } from "vite-plus/test";

import {
  SERVER_BUNDLE_WATCH_ARGS,
  SERVER_BUNDLE_WATCH_ENV_VAR,
  SERVER_BUNDLE_WATCH_ENV_VALUE,
  resolveServerBundleWatcherSpec,
  resolveVitePlusScriptPath,
  startServerBundleWatcher,
  stopServerBundleWatcher,
} from "./server-bundle-watcher.mjs";

const desktopDir = NodePath.resolve("/repo/apps/desktop");

function createFakeChild() {
  const child = new NodeEvents.EventEmitter();
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    if (signal === "SIGTERM") {
      setImmediate(() => {
        child.emit("exit", 0, null);
      });
    }
    return true;
  };
  return child;
}

describe("server bundle watcher", () => {
  it("launches through the current Node executable, not PATH-resolved vp", () => {
    const calls = [];
    const fakeChild = createFakeChild();
    const env = { PATH: "/usr/bin:/bin" };

    const child = startServerBundleWatcher({
      spawnImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return fakeChild;
      },
      desktopDir,
      env,
    });

    assert.equal(child, fakeChild);
    assert.equal(calls.length, 1);
    const call = calls[0];
    // Independent-verifier blocker: `vp` may not be on PATH for the spawned
    // dev-electron process, so the watcher must reuse the running Node.
    assert.equal(call.command, process.execPath);
    assert.deepEqual([...SERVER_BUNDLE_WATCH_ARGS], ["pack", "--watch"]);
    assert.equal(call.options.cwd, NodePath.resolve(desktopDir, "../server"));
    assert.equal(call.options.stdio, "inherit");
    assert.equal(call.options.env[SERVER_BUNDLE_WATCH_ENV_VAR], SERVER_BUNDLE_WATCH_ENV_VALUE);
  });

  it("resolves the repo-local vp script from the desktop directory", () => {
    assert.equal(
      resolveVitePlusScriptPath(desktopDir),
      NodePath.resolve(desktopDir, "..", "..", "node_modules", "vite-plus", "bin", "vp"),
    );
  });

  it("runs the repo-local vp script without shell or Windows fallback", () => {
    const calls = [];
    startServerBundleWatcher({
      spawnImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return createFakeChild();
      },
      desktopDir,
      env: {},
    });

    const call = calls[0];
    const expectedScript = NodePath.resolve(
      desktopDir,
      "..",
      "..",
      "node_modules",
      "vite-plus",
      "bin",
      "vp",
    );
    assert.deepEqual(call.args, [expectedScript, "pack", "--watch"]);
    assert.isTrue(NodePath.isAbsolute(call.args[0]));
    assert.equal(call.options.shell, undefined);
    assert.notMatch(call.args[0], /\.(cmd|exe|ps1)$/i);
    assert.notInclude(call.args[0], "\\");
  });

  it("marks the child env as the server bundle watcher while preserving inherited env", () => {
    const calls = [];
    startServerBundleWatcher({
      spawnImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return createFakeChild();
      },
      desktopDir,
      env: { PATH: "/usr/bin:/bin", FROM_PARENT: "kept" },
    });

    const call = calls[0];
    // The server config disables `pack.clean` only for this flagged watcher,
    // so watch rebuilds never remove apps/server/dist under dev-electron.
    const flagged = Object.entries(call.options.env ?? {}).filter(
      ([name, value]) => name.includes("WATCH") && value === "1",
    );
    assert.equal(flagged.length, 1);
    assert.equal(call.options.env.FROM_PARENT, "kept");
    assert.equal(call.options.env.PATH, "/usr/bin:/bin");
  });

  it("resolves the watcher spec for apps/server without a Windows fallback", () => {
    const env = { PATH: "/usr/bin:/bin" };
    const spec = resolveServerBundleWatcherSpec({ desktopDir, env });

    assert.equal(spec.command, process.execPath);
    assert.equal(spec.args.length, 3);
    assert.deepEqual(spec.args.slice(1), ["pack", "--watch"]);
    assert.isTrue(NodePath.isAbsolute(spec.args[0]));
    assert.equal(spec.options.cwd, NodePath.resolve(desktopDir, "../server"));
    assert.equal(spec.options.stdio, "inherit");
    assert.equal(spec.options.shell, undefined);
  });

  it("stops only the captured watcher child", async () => {
    const watched = createFakeChild();
    const unrelated = createFakeChild();

    await stopServerBundleWatcher(watched);

    assert.deepEqual(watched.killCalls, ["SIGTERM"]);
    assert.deepEqual(unrelated.killCalls, []);
  });

  it("reports watcher failure as an explicit dev error", async () => {
    const failures = [];
    const fakeChild = createFakeChild();
    startServerBundleWatcher({
      spawnImpl: () => fakeChild,
      desktopDir,
      env: {},
      onFailure: (error) => {
        failures.push(error);
      },
    });

    fakeChild.emit("error", new Error("spawn vp ENOENT"));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(failures.length, 1);
    assert.match(String(failures[0]?.message ?? failures[0]), /vp pack --watch/);
  });

  it("treats an unexpected watcher exit as an explicit dev failure", async () => {
    const failures = [];
    const fakeChild = new NodeEvents.EventEmitter();
    fakeChild.killCalls = [];
    fakeChild.kill = () => true;
    startServerBundleWatcher({
      spawnImpl: () => fakeChild,
      desktopDir,
      env: {},
      onFailure: (error) => {
        failures.push(error);
      },
    });

    fakeChild.emit("exit", 1, null);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(failures.length, 1);
    assert.match(String(failures[0]?.message ?? failures[0]), /vp pack --watch/);
  });

  it("does not report a failure for the expected stop exit", async () => {
    const failures = [];
    const fakeChild = createFakeChild();
    startServerBundleWatcher({
      spawnImpl: () => fakeChild,
      desktopDir,
      env: {},
      onFailure: (error) => {
        failures.push(error);
      },
    });

    await stopServerBundleWatcher(fakeChild);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(failures, []);
  });
});
