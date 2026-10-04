import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "@t3tools/contracts";

import {
  claudeProfileSlotModels,
  gentleAiAgentList,
  gentleAiClaudeProfileSummary,
  gentleAiModelAgent,
  gentleAiModelsAllDefault,
  gentleAiSyncNeeded,
  formatGentleAiBytes,
  gentleAiProjectReview,
  gentleAiReviewGlobalEnabled,
  gentleAiReviewHistoryLabel,
  gentleAiReviewStoreSummary,
  gentleOddContinuePrompt,
  gentleOddFeatureSummary,
  gentleOddMenuFeatures,
  gentleOddCurrentFeaturePath,
  gentleOddFeatureRecordCount,
  gentleOddThreadFeaturePaths,
  gentlePiProfileSummary,
} from "./gentleAi.ts";

const agent = (
  id: string,
  flags: { detected?: boolean; installed?: boolean; supported?: boolean },
) => ({
  id,
  name: id.toUpperCase(),
  detected: flags.detected ?? false,
  installed: flags.installed ?? false,
  supported: flags.supported ?? true,
  configPath: "",
});

describe("gentleAiAgentList", () => {
  it("lists set-up agents first, then detected ones, and leaves out the rest", () => {
    const agents = [
      agent("claude-code", { detected: true }),
      agent("cursor", {}),
      agent("opencode", { detected: true, installed: true }),
      agent("windsurf", { detected: true, supported: false }),
      agent("pi", { installed: true }),
    ];
    expect(gentleAiAgentList({ agents }).map((entry) => [entry.id, entry.state])).toEqual([
      ["opencode", "set-up"],
      ["pi", "set-up"],
      ["claude-code", "available"],
      ["windsurf", "unsupported"],
    ]);
  });
});

describe("gentleAiModelAgent", () => {
  it("names only the agents gentle-ai configures models for", () => {
    expect(gentleAiModelAgent("codex")).toBe("codex");
    expect(gentleAiModelAgent("pi")).toBeNull();
  });
});

describe("gentleAiModelsAllDefault", () => {
  it("is true only while no phase has a model assigned", () => {
    expect(gentleAiModelsAllDefault({})).toBe(true);
    expect(gentleAiModelsAllDefault({ modelAssignments: {}, targetAgents: [] })).toBe(true);
    expect(gentleAiModelsAllDefault({ codexModelAssignments: { "odd-worker": "high" } })).toBe(
      false,
    );
    expect(
      gentleAiModelsAllDefault({ codexOrchestratorAssignment: { model: "gpt", effort: "high" } }),
    ).toBe(false);
  });
});

describe("gentleAiSyncNeeded", () => {
  it("prefers gentle-ai's own answer, which also counts a version change", () => {
    const state = (fields: { pendingSync: boolean; syncNeeded?: boolean }) => ({
      state: { ...fields, background: {} },
    });
    expect(gentleAiSyncNeeded(state({ pendingSync: false, syncNeeded: true }))).toBe(true);
    expect(gentleAiSyncNeeded(state({ pendingSync: true, syncNeeded: false }))).toBe(false);
    // Builds before syncNeeded report only a pending sync.
    expect(gentleAiSyncNeeded(state({ pendingSync: true }))).toBe(true);
  });
});

describe("ODD features", () => {
  it("resumes a feature from its document and summarizes where it stands", () => {
    // The document goes in as a file reference, the composer's chip, like one picked with @.
    const prompt = gentleOddContinuePrompt({ path: "odd/tasks/due-dates.md" });
    expect(prompt).toBe("Implement [due-dates.md](odd/tasks/due-dates.md) ");
    expect(collectComposerInlineTokens(prompt)).toMatchObject([
      { type: "mention", value: "odd/tasks/due-dates.md" },
    ]);
    expect(gentleOddFeatureSummary({ tasksDone: 2, tasksTotal: 3 })).toBe("2/3 tasks");
    expect(gentleOddFeatureSummary({ tasksDone: 3, tasksTotal: 3 })).toBe("Done");
    expect(gentleOddFeatureSummary({ tasksDone: 0, tasksTotal: 0 })).toBe("No tasks");
  });
});

describe("ODD feature menu", () => {
  const feature = (name: string, tasksDone: number, tasksTotal: number) => ({
    path: `odd/tasks/${name}.md`,
    tasksDone,
    tasksTotal,
  });

  it("finds the documents a thread names or works on, however the path is written", () => {
    const thread = {
      messages: [{ text: "Implement [a.md](odd/tasks/a.md) " }],
      records: [{ detail: String.raw`Edited C:\repo\odd\tasks\b.md` }, { detail: "ran tests" }],
    };
    expect(
      gentleOddThreadFeaturePaths(thread, ["odd/tasks/a.md", "odd/tasks/b.md", "odd/tasks/c.md"]),
    ).toEqual(new Set(["odd/tasks/a.md", "odd/tasks/b.md"]));
  });

  it("picks the document the newest entry names alone, past listings that name several", () => {
    const paths = ["odd/tasks/a.md", "odd/tasks/b.md", "odd/tasks/c.md"];
    const entries = [
      "Implement [a.md](odd/tasks/a.md) ",
      { detail: String.raw`Edited C:\repo\odd\tasks\b.md` },
      { output: "odd/tasks/a.md\nodd/tasks/b.md\nodd/tasks/c.md" },
      { detail: "ran tests" },
    ];
    expect(gentleOddCurrentFeaturePath(entries, paths)).toBe("odd/tasks/b.md");
    expect(gentleOddCurrentFeaturePath(entries.slice(0, 1), paths)).toBe("odd/tasks/a.md");
    expect(gentleOddCurrentFeaturePath([{ detail: "ran tests" }], paths)).toBeNull();
  });

  it("counts the work records that touch a feature document, so a reader knows to re-read them", () => {
    const records = [
      { detail: String.raw`Edited C:\repo\odd\tasks\b.md` },
      { detail: "ran tests" },
      { input: { file_path: "odd/tasks/a.md" } },
    ];
    expect(gentleOddFeatureRecordCount({ messages: [], records })).toBe(2);
    expect(
      gentleOddFeatureRecordCount({ messages: [], records: [...records, { detail: "odd" }] }),
    ).toBe(2);
  });

  it("drops finished documents and lists this thread's first", () => {
    const features = [feature("done", 3, 3), feature("other", 1, 4), feature("mine", 0, 2)];
    expect(
      gentleOddMenuFeatures(features, new Set(["odd/tasks/mine.md", "odd/tasks/done.md"])),
    ).toEqual([
      { feature: features[2], inThread: true },
      { feature: features[1], inThread: false },
    ]);
  });
});

describe("gentleAiClaudeProfileSummary", () => {
  it("names what each slot runs, strongest first, and who picks the phases' models", () => {
    expect(
      gentleAiClaudeProfileSummary({
        slots: {
          haiku: { model: "gpt-6-luna", label: "GPT-6 Luna" },
          opus: { model: "claude-opus-5-5" },
        },
      }),
    ).toBe("claude-opus-5-5 · haiku GPT-6 Luna");
    expect(
      gentleAiClaudeProfileSummary({ slots: {}, phases: { "odd-worker": { model: "sonnet" } } }),
    ).toBe("1 step fixed");
    expect(gentleAiClaudeProfileSummary({ slots: {} })).toBe("Claude Code's default models");
  });
});

describe("claudeProfileSlotModels", () => {
  it("offers what Claude Code providers going through a proxy serve, once each", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const proxy = [
      { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", sensitive: false },
    ];
    expect(
      claudeProfileSlotModels({
        cliproxy: {
          driver: claude,
          environment: proxy,
          config: {
            customModels: [{ slug: "claude-fable-5-dd-anul-6-tpg", name: "GPT 6.0 Luna" }, "muse"],
          },
        },
        other: {
          driver: claude,
          environment: [
            { name: "ANTHROPIC_BASE_URL", value: "", sensitive: false, valueRedacted: true },
          ],
          config: { customModels: ["muse"] },
        },
        direct: { driver: claude, config: { customModels: ["claude-opus-5-5"] } },
        off: {
          driver: claude,
          environment: proxy,
          enabled: false,
          config: { customModels: ["off"] },
        },
        codex: {
          driver: ProviderDriverKind.make("codex"),
          environment: proxy,
          config: { customModels: ["gpt"] },
        },
      }),
    ).toEqual([
      { id: "claude-fable-5-dd-anul-6-tpg", label: "GPT 6.0 Luna" },
      { id: "muse", label: "muse" },
    ]);
  });
});

describe("gentlePiProfileSummary", () => {
  it("names the orchestrator's model and effort, then the other models by use", () => {
    const names = new Map([
      ["claude-bridge/claude-opus-5-5", "Claude Opus 5.5 1M"],
      ["claude-bridge/claude-sonnet-5", "Claude Sonnet 5 1M"],
    ]);
    expect(
      gentlePiProfileSummary(
        {
          orchestrator: { model: "claude-bridge/claude-opus-5-5", thinking: "medium" },
          "gentle-ai-explore": { model: "openai-codex/gpt-6-luna" },
          "gentle-ai-worker": { model: "claude-bridge/claude-sonnet-5" },
          "jd-fix-agent": { model: "claude-bridge/claude-sonnet-5" },
          "review-risk": { model: "claude-bridge/claude-opus-5-5" },
          "review-readability": {},
        },
        (model) => names.get(model),
      ),
    ).toBe("Opus 5.5 medium · Sonnet 5 · gpt-6-luna");
    expect(gentlePiProfileSummary({}, () => undefined)).toBe("Pi's default");
  });
});

const reviewMode = (global: string, clone_local: string) => ({
  scope: "global",
  status: { global, clone_local, effective: "on", source: "default" },
});

describe("gentleAiProjectReview", () => {
  const mode = (global: string, cloneLocal: string, effective: string) => ({
    scope: "both",
    status: { global, clone_local: cloneLocal, effective, source: "global" },
  });

  it("follows the setting for every project until this project turns it off", () => {
    expect(gentleAiProjectReview(mode("on", "", "on"))).toEqual({
      checked: true,
      overridden: false,
      canTurnOn: true,
    });
    expect(gentleAiProjectReview(mode("on", "off", "off"))).toEqual({
      checked: false,
      overridden: true,
      canTurnOn: true,
    });
  });

  it("cannot turn review on for one project while it is off everywhere", () => {
    expect(gentleAiProjectReview(mode("off", "", "off"))).toEqual({
      checked: false,
      overridden: false,
      canTurnOn: false,
    });
  });
});

describe("review mode", () => {
  it("treats an unchosen global switch as on", () => {
    expect(gentleAiReviewGlobalEnabled(reviewMode("", ""))).toBe(true);
    expect(gentleAiReviewGlobalEnabled(reviewMode("off", ""))).toBe(false);
  });
});

describe("gentleAiReviewStoreSummary", () => {
  const entry = (present: boolean, bytes: number) => ({
    name: "n",
    path: "p",
    reason: "",
    present,
    files: 1,
    bytes,
    removed: false,
  });

  it("counts only removable entries still on disk", () => {
    expect(
      gentleAiReviewStoreSummary({
        report: {
          operation: "review/store-reset",
          repository: "/a",
          store_root: "/a/.git/gentle",
          removable: [entry(true, 1024), entry(false, 99), entry(true, 1024)],
          preserved: [entry(true, 5)],
          unrecognized: [],
          in_flight: [{}],
          settled_lineages: 0,
          removed_files: 0,
          removed_bytes: 0,
          complete: false,
        },
      }),
    ).toEqual({ removable: 2, removableBytes: 2048, inFlight: 1 });
  });

  it("formats sizes", () => {
    expect(formatGentleAiBytes(512)).toBe("512 B");
    expect(formatGentleAiBytes(2048)).toBe("2.0 KB");
  });
});
