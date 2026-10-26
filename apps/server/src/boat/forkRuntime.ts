/**
 * Puts the exact T3 Code build this server runs on a Boat machine. A template's own `t3`, or the
 * upstream one `npx` fetches, may not match the fork's protocol, so the machine downloads this
 * server's version from the fork's releases, which publish the Linux x64 CLI archive.
 *
 * @module boat/forkRuntime
 */

import * as Context from "effect/Context";

import packageJson from "../../package.json" with { type: "json" };

/** The build a machine is made to run: this server's own version. */
export const HostVersion = Context.Reference<string>("t3/boat/HostVersion", {
  defaultValue: () => packageJson.version,
});

const RELEASES_URL = "https://github.com/santiago-ramos-02/t3code/releases/download";
// Nightly releases are tagged `v<version>` and stable ones `personal-v<version>`.
const RELEASE_TAG_PREFIXES = ["v", "personal-v"] as const;
// Each version extracts into its own directory below this one, and `current` points at the one in use.
const RUNTIME_DIR = `"$HOME/.t3-runtime"`;

// Versions are spliced into shell text, so only characters a release version uses are accepted.
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

/**
 * What a machine runs as `t3`: the installed fork build, else the template's `t3`, else the
 * published one. Evaluated by the machine's shell, so it follows whatever is installed there.
 */
export const T3_COMMAND = `$(if [ -x ${RUNTIME_DIR}/current/t3 ]; then echo ${RUNTIME_DIR}/current/t3; elif command -v t3 >/dev/null 2>&1; then echo t3; else echo "npx -y t3@latest"; fi)`;

/** The notice a machine carries when it could not get this server's build. */
export const forkRuntimeUnavailableNotice = (version: string) =>
  `T3 Code ${version} could not be installed on this machine, so it runs the template's T3 Code, which may not match this server.`;

export type ForkRuntimeCommands = {
  /** Prints `current` when this version is installed and in use, else `other`. */
  readonly probe: string;
  /** Installs this version when needed; prints `installed`, or `unavailable` after removing `current`. */
  readonly install: string;
};

// The archive's own layout: `t3-<version>-linux-x64/` holding `t3` and its `client/`, as written by
// scripts/build-cli-archive.ts and checked by scripts/smoke-cli-archive.ts.
const archiveStem = (version: string) => `t3-${version}-linux-x64`;

/** Shell commands for a machine, or null for a version that is not safe to put in a command. */
export const forkRuntimeCommands = (version: string): ForkRuntimeCommands | null => {
  if (!SAFE_VERSION.test(version)) return null;
  const stem = archiveStem(version);
  const target = `${RUNTIME_DIR}/${version}/${stem}`;
  const downloads = RELEASE_TAG_PREFIXES.map(
    (prefix) =>
      `curl -fsSL --retry 2 -o ${RUNTIME_DIR}/${version}.partial/${stem}.tar.gz ${RELEASES_URL}/${prefix}${version}/${stem}.tar.gz`,
  );
  const fetchArchive = downloads
    .map(
      (download) =>
        `(${download} && tar -xzf ${RUNTIME_DIR}/${version}.partial/${stem}.tar.gz -C ${RUNTIME_DIR}/${version}.partial)`,
    )
    .join(" || ");
  return {
    probe: `[ "$(readlink ${RUNTIME_DIR}/current)" = ${target} ] && [ -x ${target}/t3 ] && echo current || echo other`,
    install: [
      `if [ ! -x ${target}/t3 ]; then`,
      `rm -rf ${RUNTIME_DIR}/${version} ${RUNTIME_DIR}/${version}.partial;`,
      `mkdir -p ${RUNTIME_DIR}/${version}.partial;`,
      `(${fetchArchive}) && rm -f ${RUNTIME_DIR}/${version}.partial/${stem}.tar.gz && mv ${RUNTIME_DIR}/${version}.partial ${RUNTIME_DIR}/${version};`,
      `rm -rf ${RUNTIME_DIR}/${version}.partial;`,
      `fi;`,
      `if [ -x ${target}/t3 ]; then`,
      `ln -sfn ${target} ${RUNTIME_DIR}/current;`,
      `for old in ${RUNTIME_DIR}/*; do case "$old" in ${RUNTIME_DIR}/${version}|${RUNTIME_DIR}/current) ;; *) rm -rf "$old";; esac; done;`,
      `echo installed;`,
      `else rm -f ${RUNTIME_DIR}/current; echo unavailable; fi`,
    ].join(" "),
  };
};

/** The last line a probe or install printed, since a shell may print noise before it. */
export const lastLine = (stdout: string) => stdout.trim().split("\n").pop()?.trim() ?? "";
