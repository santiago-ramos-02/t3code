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
