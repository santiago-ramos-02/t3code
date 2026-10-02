/**
 * gentle-pi commands that only drive its terminal UI: panels Pi cannot show over RPC, and
 * preferences for its TUI chrome. T3 Code offers native equivalents for profiles, model routing,
 * and subagents, so these stay out of the composer.
 */
const GENTLE_TUI_ONLY_COMMANDS = new Set([
  "gentle:models",
  "gentle:profiles",
  "gentle:agents",
  "gentle:usage",
  "gentle:changes",
  "gentle:commands",
  "gentle:animations",
  "gentle:double-esc-cancel",
  "gentle:banner",
  "gentle:banner-color",
  "gentle:toggle-rose",
  "gentle:toggle-text-logo",
  "gentle:customize",
  "gentle:vim",
  "history",
]);

const GENTLE_PI_LOCATION = /(?:^|[:/\\])gentle-pi(?:$|[@/\\])/;

/** Whether a Pi command is one of gentle-pi's terminal-only commands. */
export function isGentleTuiOnlyCommand(
  name: string,
  locations: ReadonlyArray<string | undefined>,
): boolean {
  return (
    GENTLE_TUI_ONLY_COMMANDS.has(name) &&
    locations.some((location) => location !== undefined && GENTLE_PI_LOCATION.test(location))
  );
}
