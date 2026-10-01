import { describe, expect, it } from "vite-plus/test";

import { releaseChecksum } from "./githubRelease.ts";

describe("release checksums", () => {
  const checksums = [
    "aaa111  gentle-ai_3.7.0-t3.7533e49_linux_amd64.tar.gz",
    "BBB222  gentle-ai_3.7.0-t3.7533e49_windows_amd64.tar.gz",
    "ccc333 *gentle-ai_3.7.0-t3.7533e49_windows_amd64.zip",
    "",
  ].join("\n");

  it("finds the asset's own line, not one whose name it is a prefix or suffix of", () => {
    expect(releaseChecksum(checksums, "gentle-ai_3.7.0-t3.7533e49_windows_amd64.tar.gz")).toBe(
      "bbb222",
    );
    expect(releaseChecksum(checksums, "amd64.tar.gz")).toBeNull();
  });

  it("reads binary-mode lines, whose file name starts with *", () => {
    expect(releaseChecksum(checksums, "gentle-ai_3.7.0-t3.7533e49_windows_amd64.zip")).toBe(
      "ccc333",
    );
  });

  it("returns null for an asset the release does not list", () => {
    expect(releaseChecksum(checksums, "gentle-ai_3.7.0-t3.7533e49_darwin_arm64.tar.gz")).toBeNull();
  });
});
