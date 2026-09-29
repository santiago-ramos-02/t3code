import {
  GENTLE_AI_PACKAGE,
  PI_GENTLE_PACKAGES,
  type ModelSelection,
  type PiGentleComposerState,
  type ServerProviderModel,
} from "@t3tools/contracts";

const GENTLE_PACKAGES: ReadonlySet<string> = new Set([GENTLE_AI_PACKAGE, ...PI_GENTLE_PACKAGES]);

/**
 * The commands or skills a thread can use. With Gentle AI off the thread's agent loads nothing
 * from Gentle AI, so what it provides is not offered.
 */
export function resourcesForGentle<T extends { readonly package?: string | undefined }>(
  items: ReadonlyArray<T>,
  gentleEnabled: boolean,
): ReadonlyArray<T> {
  return gentleEnabled
    ? items
    : items.filter((item) => item.package === undefined || !GENTLE_PACKAGES.has(item.package));
}

export type GentleProfileOption = NonNullable<PiGentleComposerState["profiles"]>[number];

/**
 * What applying a Gentle profile does to a Pi thread's model: Gentle AI switches the live
 * session to the profile's orchestrator, so the thread moves to that model and thinking level.
 * A profile without an orchestrator keeps the thread's model; one Pi does not list is reported.
 */
export type GentleProfileModelChange =
  | { readonly kind: "keep" }
  | { readonly kind: "switch"; readonly selection: ModelSelection; readonly label: string }
  | { readonly kind: "unavailable"; readonly model: string };

export function gentleProfileModelChange(
  current: ModelSelection,
  profile: GentleProfileOption,
  models: ReadonlyArray<ServerProviderModel>,
): GentleProfileModelChange {
  const slug = profile.orchestrator?.model;
  if (slug === undefined) return { kind: "keep" };
  const model = models.find((entry) => entry.slug === slug);
  if (model === undefined) return { kind: "unavailable", model: slug };
  const thinking = profile.orchestrator?.thinking;
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (entry) => entry.id === "thinkingLevel",
  );
  const thinkingOption =
    descriptor?.type === "select"
      ? descriptor.options.find((option) => option.id === thinking)
      : undefined;
  // The profile's thinking level replaces the thread's; one the model lacks falls to its default.
  const options = [
    ...(current.options?.filter((option) => option.id !== "thinkingLevel") ?? []),
    ...(thinkingOption === undefined ? [] : [{ id: "thinkingLevel", value: thinkingOption.id }]),
  ];
  return {
    kind: "switch",
    selection: {
      instanceId: current.instanceId,
      model: model.slug,
      ...(options.length === 0 ? {} : { options }),
    },
    label: [model.shortName ?? model.name, thinkingOption?.label].filter(Boolean).join(" · "),
  };
}

/** Menu detail for a profile: the model applying it moves the thread to. */
export function gentleProfileModelLabel(
  current: ModelSelection,
  profile: GentleProfileOption,
  models: ReadonlyArray<ServerProviderModel>,
): string {
  const change = gentleProfileModelChange(current, profile, models);
  if (change.kind === "switch") return change.label;
  return change.kind === "unavailable"
    ? `${change.model.slice(change.model.lastIndexOf("/") + 1)} unavailable`
    : "Keeps model";
}
