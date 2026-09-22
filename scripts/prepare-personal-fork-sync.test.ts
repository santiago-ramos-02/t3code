// @effect-diagnostics nodeBuiltinImport:off - This integration test drives native Git and shell boundaries.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const scriptPath = NodePath.resolve(
  import.meta.dirname,
  "../.github/scripts/prepare-personal-fork-sync.sh",
);

function git(repo: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

function writeOutputsEnv(repo: string, eventName: string) {
  const outputFile = NodePath.join(repo, "github-output.txt");
  return {
    outputFile,
    env: {
      GITHUB_OUTPUT: outputFile,
      GITHUB_EVENT_NAME: eventName,
    } as NodeJS.ProcessEnv,
  };
}

function parseOutputs(content: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const index = trimmed.indexOf("=");
    outputs[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return outputs;
}

async function initRepo(): Promise<string> {
  const repo = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fork-sync-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "test-bot"]);
  git(repo, ["config", "user.email", "test-bot@example.com"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  return repo;
}

function commitFile(repo: string, name: string, content: string, message: string): string {
  NodeChildProcess.execFileSync("node", [
    "-e",
    "require('fs').writeFileSync(process.argv[1], process.argv[2])",
    NodePath.join(repo, name),
    content,
  ]);
  git(repo, ["add", name]);
  git(repo, ["commit", "-m", message, "--no-gpg-sign"]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function pointUpstreamAt(repo: string, sha: string): void {
  git(repo, ["update-ref", "refs/remotes/upstream/main", sha]);
}

function runSync(
  repo: string,
  eventName: string,
  upstreamRef = "upstream/main",
): {
  status: number | null;
  output: string;
  outputs: Record<string, string>;
} {
  const { outputFile, env } = writeOutputsEnv(repo, eventName);
  const readOutputs = (): Record<string, string> => {
    try {
      return parseOutputs(NodeFS.readFileSync(outputFile, "utf8"));
    } catch {
      return {};
    }
  };
  try {
    const stdout = NodeChildProcess.execFileSync(scriptPath, [upstreamRef, eventName], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: 0, output: String(stdout), outputs: readOutputs() };
  } catch (error) {
    const result = error as { status?: number | null; stdout?: unknown; stderr?: unknown };
    return {
      status: result.status ?? 1,
      output: String(result.stdout ?? "") + String(result.stderr ?? ""),
      outputs: readOutputs(),
    };
  }
}

describe("prepare-personal-fork-sync", () => {
  it("keeps fork-only files when syncing upstream changes", async () => {
    const repo = await initRepo();
    try {
      commitFile(repo, "shared.txt", "base\n", "base");
      const forkSha = commitFile(repo, "fork-only.txt", "fork work\n", "fork work");
      const base = git(repo, ["rev-parse", "HEAD~1"]);
      git(repo, ["checkout", "--quiet", base]);
      const upstreamSha = commitFile(repo, "upstream-only.txt", "upstream work\n", "upstream work");
      pointUpstreamAt(repo, upstreamSha);
      git(repo, ["checkout", "--quiet", forkSha]);

      const { status, outputs } = runSync(repo, "schedule");

      expect(status).toBe(0);
      expect(outputs["fork_sha"]).toBe(forkSha);
      expect(outputs["upstream_sha"]).toBe(upstreamSha);
      expect(outputs["needs_push"]).toBe("true");
      expect(outputs["should_build"]).toBe("true");
      expect(git(repo, ["rev-parse", "HEAD"])).toBe(outputs["build_sha"]);
      expect(await NodeFSP.readFile(NodePath.join(repo, "fork-only.txt"), "utf8")).toBe(
        "fork work\n",
      );
      expect(await NodeFSP.readFile(NodePath.join(repo, "upstream-only.txt"), "utf8")).toBe(
        "upstream work\n",
      );
      const secondParents = git(repo, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ");
      expect(secondParents).toContain(forkSha);
      expect(secondParents).toContain(upstreamSha);
    } finally {
      await NodeFSP.rm(repo, { recursive: true, force: true });
    }
  });

  it("lands upstream-only changes when the fork has nothing new", async () => {
    const repo = await initRepo();
    try {
      const base = commitFile(repo, "shared.txt", "base\n", "base");
      const upstreamSha = commitFile(repo, "upstream-only.txt", "upstream work\n", "upstream work");
      pointUpstreamAt(repo, upstreamSha);
      git(repo, ["checkout", "--quiet", base]);

      const { status, outputs } = runSync(repo, "schedule");

      expect(status).toBe(0);
      expect(outputs["fork_sha"]).toBe(base);
      expect(outputs["upstream_sha"]).toBe(upstreamSha);
      expect(outputs["needs_push"]).toBe("true");
      expect(outputs["should_build"]).toBe("true");
      expect(await NodeFSP.readFile(NodePath.join(repo, "upstream-only.txt"), "utf8")).toBe(
        "upstream work\n",
      );
      expect(git(repo, ["merge-base", "--is-ancestor", upstreamSha, "HEAD"]) === "").toBe(true);
    } finally {
      await NodeFSP.rm(repo, { recursive: true, force: true });
    }
  });

  it("keeps non-conflicting edits to the same file from both sides", async () => {
    const repo = await initRepo();
    try {
      const baseContent = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";
      commitFile(repo, "shared.txt", baseContent, "base");
      const forkSha = commitFile(
        repo,
        "shared.txt",
        baseContent.replace("two", "fork-two"),
        "fork edit",
      );
      const base = git(repo, ["rev-parse", "HEAD~1"]);
      git(repo, ["checkout", "--quiet", base]);
      const upstreamSha = commitFile(
        repo,
        "shared.txt",
        baseContent.replace("six", "upstream-six"),
        "upstream edit",
      );
      pointUpstreamAt(repo, upstreamSha);
      git(repo, ["checkout", "--quiet", forkSha]);

      const { status, outputs } = runSync(repo, "schedule");

      expect(status).toBe(0);
      expect(outputs["needs_push"]).toBe("true");
      expect(await NodeFSP.readFile(NodePath.join(repo, "shared.txt"), "utf8")).toBe(
        baseContent.replace("two", "fork-two").replace("six", "upstream-six"),
      );
    } finally {
      await NodeFSP.rm(repo, { recursive: true, force: true });
    }
  });

  it("fails closed on merge conflicts without publishing a candidate", async () => {
    const repo = await initRepo();
    try {
      commitFile(repo, "shared.txt", "base\n", "base");
      const forkSha = commitFile(repo, "shared.txt", "fork edit\n", "fork edit");
      const base = git(repo, ["rev-parse", "HEAD~1"]);
      git(repo, ["checkout", "--quiet", base]);
      const upstreamSha = commitFile(repo, "shared.txt", "upstream edit\n", "upstream edit");
      pointUpstreamAt(repo, upstreamSha);
      git(repo, ["checkout", "--quiet", forkSha]);

      const { status, output, outputs } = runSync(repo, "schedule");

      expect(status).not.toBe(0);
      expect(output).toMatch(/CONFLICT/i);
      expect(outputs).toEqual({});
      expect(git(repo, ["rev-parse", "HEAD"])).toBe(forkSha);
      expect(await NodeFSP.readFile(NodePath.join(repo, "shared.txt"), "utf8")).toBe("fork edit\n");
      await expect(NodeFSP.stat(NodePath.join(repo, ".git", "MERGE_HEAD"))).rejects.toThrow();
      expect(git(repo, ["diff", "--name-only", "--diff-filter=U"])).toBe("");
      expect(git(repo, ["status", "--porcelain"])).toBe("");
    } finally {
      await NodeFSP.rm(repo, { recursive: true, force: true });
    }
  });

  it.each([
    { eventName: "push", shouldBuild: "true" },
    { eventName: "workflow_dispatch", shouldBuild: "true" },
    { eventName: "schedule", shouldBuild: "false" },
  ])("leaves an up-to-date fork alone (event: $eventName)", async ({ eventName, shouldBuild }) => {
    const repo = await initRepo();
    try {
      const head = commitFile(repo, "shared.txt", "base\n", "base");
      pointUpstreamAt(repo, head);

      const { status, outputs } = runSync(repo, eventName);

      expect(status).toBe(0);
      expect(outputs["build_sha"]).toBe(head);
      expect(outputs["fork_sha"]).toBe(head);
      expect(outputs["upstream_sha"]).toBe(head);
      expect(outputs["needs_push"]).toBe("false");
      expect(outputs["should_build"]).toBe(shouldBuild);
      expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
    } finally {
      await NodeFSP.rm(repo, { recursive: true, force: true });
    }
  });
});
