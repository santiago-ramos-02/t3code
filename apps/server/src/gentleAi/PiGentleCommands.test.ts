import { describe, expect, it } from "vite-plus/test";

import { parsePiDiscoveredCommands } from "../provider/PiCommands.ts";

const command = (name: string, path: string) => ({
  name,
  source: "extension",
  sourceInfo: { source: path, path },
});

describe("gentle-pi terminal-only commands", () => {
  it("keeps gentle-pi's terminal panels out of the composer", () => {
    const { slashCommands } = parsePiDiscoveredCommands({
      commands: [
        command("gentle:profiles", "/home/me/.pi/agent/npm/gentle-pi/index.ts"),
        command("gentle:review", "/home/me/.pi/agent/npm/gentle-pi/index.ts"),
        // Another extension may use the same name; only gentle-pi's is terminal-only.
        command("history", "/home/me/.pi/agent/extensions/history.ts"),
      ],
    });
    expect(slashCommands.map((entry) => entry.name)).toEqual(["gentle:review", "history"]);
  });
});
