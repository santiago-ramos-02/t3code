/**
 * Downloads a program's GitHub release for this machine: the latest version, the archive
 * checked against the release's `checksums.txt`, and the archive unpacked. Used by the
 * installers T3 Code runs for CLIProxyAPI and gentle-ai.
 *
 * @module githubRelease
 */
import * as Crypto from "effect/Crypto";

import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** The sha256 `checksums.txt` lists for `asset` (`<hash>  <file>` lines), or null. */
export function releaseChecksum(checksums: string, asset: string): string | null {
  for (const line of checksums.split("\n")) {
    const [hash, file] = line.trim().split(/\s+/);
    if (hash && file?.replace(/^\*/, "") === asset) return hash.toLowerCase();
  }
  return null;
}

/** Reads GitHub releases with the services of the installer that builds it. */
export const makeGitHubReleases = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;

  const get = (url: string, timeout: `${number} seconds`) =>
    httpClient
      .execute(
        HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders({ "user-agent": "t3code" })),
      )
      .pipe(
        Effect.timeout(timeout),
        Effect.filterOrFail((response) => response.status >= 200 && response.status < 300),
      );

  /** The latest release's version (its tag without the leading v), or null when unreachable. */
  const latestVersion = (repository: string) =>
    get(`https://api.github.com/repos/${repository}/releases/latest`, "10 seconds").pipe(
      Effect.flatMap((response) => response.text),
      Effect.map((text) => /"tag_name"\s*:\s*"v?([^"]+)"/.exec(text)?.[1] ?? null),
      Effect.orElseSucceed(() => null),
    );

  /**
   * Downloads `asset` from release `v<version>` of `repository`, checks it against the
   * release's checksums, unpacks it into a temporary folder, and runs `use` on that folder,
   * which is removed afterwards. Every failure goes through `fail` with a sentence a user can
   * read; nothing is unpacked when the checksum does not match.
   */
  const withVerifiedRelease = <A, E, R, F>(
    input: {
      readonly repository: string;
      readonly version: string;
      readonly asset: string;
      /** The program's name in messages, such as "gentle-ai". */
      readonly label: string;
      readonly fail: (detail: string) => F;
    },
    use: (unpacked: string) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const { fail, asset, label } = input;
      const base = `https://github.com/${input.repository}/releases/download/v${input.version}`;
      const checksums = yield* get(`${base}/checksums.txt`, "30 seconds").pipe(
        Effect.flatMap((response) => response.text),
        Effect.mapError(() => fail("The release checksums could not be downloaded.")),
      );
      const expected = releaseChecksum(checksums, asset);
      if (expected === null) {
        return yield* Effect.fail(fail(`${asset} is not listed in the release checksums.`));
      }
      const bytes = yield* get(`${base}/${asset}`, "300 seconds").pipe(
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.mapError(() => fail(`${label} could not be downloaded.`)),
      );
      const digest = yield* crypto.digest("SHA-256", bytes).pipe(
        Effect.map((hash) => Buffer.from(hash).toString("hex")),
        Effect.mapError(() => fail("The download checksum could not be verified.")),
      );
      if (digest !== expected) {
        return yield* Effect.fail(
          fail("The download does not match its checksum, so nothing was installed."),
        );
      }

      const work = yield* fileSystem
        .makeTempDirectory({ prefix: "t3-release-" })
        .pipe(Effect.mapError(() => fail("A download folder could not be made.")));
      return yield* Effect.gen(function* () {
        const archive = path.join(work, asset);
        const unpacked = path.join(work, "unpacked");
        yield* fileSystem.writeFile(archive, bytes).pipe(
          Effect.andThen(fileSystem.makeDirectory(unpacked)),
          Effect.mapError(() => fail("The download could not be saved.")),
        );
        // tar unpacks both .zip and .tar.gz on Windows 10+, macOS, and Linux. On Windows the
        // bundled bsdtar is named by path: a GNU tar earlier on PATH, such as Git's, cannot read zips.
        const tar =
          platform === "win32"
            ? path.join(environment.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
            : "tar";
        const unpackedOk = yield* spawner
          .string(
            ChildProcess.make(tar, ["-xf", archive, "-C", unpacked], {
              stdin: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(
            Effect.timeout("120 seconds"),
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
        if (!unpackedOk) {
          return yield* Effect.fail(fail("The download could not be unpacked; tar is needed."));
        }
        return yield* use(unpacked);
      }).pipe(Effect.ensuring(fileSystem.remove(work, { recursive: true }).pipe(Effect.ignore)));
    });

  return { latestVersion, withVerifiedRelease };
});
