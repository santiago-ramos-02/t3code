// Text Pi or its extensions hand to the UI is capped so one runaway tool result or label cannot
// bloat every runtime event that carries it.
export const MAX_TOOL_DETAIL_CHARS = 2_048;

export function boundedText(value: string, maxChars = MAX_TOOL_DETAIL_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** The trimmed value, or the fallback when the value is blank; both are bounded. */
export function nonEmpty(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return boundedText(trimmed.length > 0 ? trimmed : fallback);
}
