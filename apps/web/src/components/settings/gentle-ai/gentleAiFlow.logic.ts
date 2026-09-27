/** Every flow the Gentle AI page can open in place, keyed for the URL. */
export type GentleAiFlow =
  | { readonly kind: "setup" }
  | { readonly kind: "builder" }
  | { readonly kind: "uninstall" }
  | { readonly kind: "doctor" }
  | { readonly kind: "models"; readonly agent: string };

export function gentleAiFlowKey(flow: GentleAiFlow): string {
  return flow.kind === "models" ? `models:${flow.agent}` : flow.kind;
}

export function parseGentleAiFlow(value: unknown): GentleAiFlow | null {
  if (typeof value !== "string") return null;
  if (value === "setup" || value === "builder" || value === "uninstall" || value === "doctor")
    return { kind: value };
  if (value.startsWith("models:") && value.length > "models:".length)
    return { kind: "models", agent: value.slice("models:".length) };
  return null;
}
