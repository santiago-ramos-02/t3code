/**
 * Every flow the Gentle AI page can open in place, keyed for the URL. `agent` is one agent's
 * own page. `setup` and `uninstall` carry an agent when they act on that one agent: setting it
 * up alongside the agents already set up, or removing Gentle AI from it alone.
 */
export type GentleAiFlow =
  | { readonly kind: "agent"; readonly agent: string }
  | { readonly kind: "setup"; readonly agent?: string }
  | { readonly kind: "uninstall"; readonly agent?: string }
  | { readonly kind: "models"; readonly agent: string }
  | { readonly kind: "builder" }
  | { readonly kind: "backups" }
  | { readonly kind: "claudeProfiles" }
  | { readonly kind: "doctor" };

const AGENT_FLOWS = ["agent", "setup", "uninstall", "models"] as const;
const PLAIN_FLOWS = [
  "setup",
  "uninstall",
  "builder",
  "backups",
  "claudeProfiles",
  "doctor",
] as const;

export function gentleAiFlowKey(flow: GentleAiFlow): string {
  return "agent" in flow && flow.agent !== undefined ? `${flow.kind}:${flow.agent}` : flow.kind;
}

export function parseGentleAiFlow(value: unknown): GentleAiFlow | null {
  if (typeof value !== "string") return null;
  const plain = PLAIN_FLOWS.find((kind) => kind === value);
  if (plain !== undefined) return { kind: plain };
  const separator = value.indexOf(":");
  const kind = AGENT_FLOWS.find((candidate) => candidate === value.slice(0, separator));
  const agent = value.slice(separator + 1);
  if (separator < 0 || kind === undefined || agent === "") return null;
  return { kind, agent };
}
