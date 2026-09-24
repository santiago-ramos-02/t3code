/** A provider can continue without another user message, so only its last reply is final. */
export function finalAssistantMessageIds(
  messages: ReadonlyArray<{ readonly id: string; readonly role: string }>,
): ReadonlySet<string> {
  const finalIds = new Set<string>();
  let latestAssistantId: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      if (latestAssistantId !== null) finalIds.add(latestAssistantId);
      latestAssistantId = null;
    } else if (message.role === "assistant") {
      latestAssistantId = message.id;
    }
  }
  if (latestAssistantId !== null) finalIds.add(latestAssistantId);

  return finalIds;
}

/** A parent reply remains an update when another agent turn follows it without a new user prompt. */
export function continuingAssistantTurnIds(
  messages: ReadonlyArray<{
    readonly role: string;
    readonly turnId?: string | null;
  }>,
  options: {
    readonly activeTurnId?: string | null;
    readonly backgroundWorkContinues?: boolean;
  } = {},
): ReadonlySet<string> {
  const continuing = new Set<string>();
  let latestAssistantTurnId: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      latestAssistantTurnId = null;
      continue;
    }
    if (message.role !== "assistant" || message.turnId == null) continue;
    if (latestAssistantTurnId !== null && latestAssistantTurnId !== message.turnId) {
      continuing.add(latestAssistantTurnId);
    }
    latestAssistantTurnId = message.turnId;
  }

  if (
    latestAssistantTurnId !== null &&
    (options.backgroundWorkContinues === true ||
      (options.activeTurnId != null && options.activeTurnId !== latestAssistantTurnId))
  ) {
    continuing.add(latestAssistantTurnId);
  }
  return continuing;
}
