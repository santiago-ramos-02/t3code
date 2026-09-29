import type {
  PiGentleRouting,
  PiGentleRoutingEntry,
  ServerProviderModel,
} from "@t3tools/contracts";
import { ChevronDownIcon, PlusIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../../ui/combobox";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";

type Thinking = NonNullable<PiGentleRoutingEntry["thinking"]>;
const THINKING: ReadonlyArray<Thinking> = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const THINKING_LABELS = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
} satisfies Record<Thinking, string>;
const INHERIT = "__inherit__";

// gentle-pi's roles, grouped and named as Claude Code's phases are (see GentleAiModelEditor), so
// ODD and RDD read the same for every agent. Roles outside these, such as a custom agent's, show
// under "Other roles" and are the only ones that can be removed.
const GROUPS = [
  { label: "Orchestrator", roles: [["orchestrator", "Orchestrator"]] },
  {
    label: "ODD",
    roles: [
      ["gentle-ai-explore", "ODD Explorer"],
      ["gentle-ai-worker", "ODD Worker"],
      ["gentle-ai-verify", "ODD Verify"],
    ],
  },
  {
    label: "Judgment Day",
    roles: [
      ["jd-judge-a", "JD Judge A"],
      ["jd-judge-b", "JD Judge B"],
      ["jd-fix-agent", "JD Fix Agent"],
    ],
  },
  {
    label: "RDD review",
    roles: [
      ["review-risk", "RDD Risk"],
      ["review-readability", "RDD Readability"],
      ["review-reliability", "RDD Reliability"],
      ["review-resilience", "RDD Resilience"],
      ["review-refuter", "RDD Refuter"],
      ["review-validator", "RDD Validator"],
    ],
  },
] as const;
const KNOWN_ROLES: ReadonlySet<string> = new Set(
  GROUPS.flatMap((group) => group.roles.map(([role]) => role)),
);

/**
 * One gentle-pi profile as a table: the model and effort each role runs. Every change saves
 * at once through `onChange`, like the rest of Pi's settings.
 */
export function PiRoutingEditor({
  routing,
  models,
  disabled,
  onChange,
}: {
  readonly routing: PiGentleRouting;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly disabled: boolean;
  readonly onChange: (routing: PiGentleRouting) => void;
}) {
  const [adding, setAdding] = useState<string | null>(null);
  const others = Object.keys(routing).filter((role) => !KNOWN_ROLES.has(role));
  const set = (role: string, entry: PiGentleRoutingEntry) =>
    onChange({ ...routing, [role]: entry });
  const row = (role: string, label: string, removable: boolean) => (
    <RoutingRow
      key={role}
      role={role}
      label={label}
      entry={routing[role] ?? {}}
      models={models}
      disabled={disabled}
      onChange={(entry) => set(role, entry)}
      onRemove={
        removable
          ? () => {
              const { [role]: _removed, ...rest } = routing;
              onChange(rest);
            }
          : null
      }
    />
  );
  const newRole = adding?.trim() ?? "";
  const canAdd = newRole !== "" && !Object.hasOwn(routing, newRole);

  return (
    <div className="@container/routing space-y-4">
      {GROUPS.map((group) => (
        <RoutingGroup key={group.label} label={group.label}>
          {group.roles.map(([role, label]) => row(role, label, false))}
        </RoutingGroup>
      ))}
      {others.length === 0 && adding === null ? null : (
        <RoutingGroup label="Other roles">
          {others.map((role) => row(role, role, true))}
          {adding === null ? null : (
            <div className="flex items-center gap-2">
              <Input
                size="sm"
                font="mono"
                autoFocus
                aria-label="Role name"
                placeholder="agent-name"
                value={adding}
                onChange={(event) => setAdding(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canAdd) {
                    set(newRole, {});
                    setAdding(null);
                  }
                  if (event.key === "Escape") setAdding(null);
                }}
              />
              <Button
                size="sm"
                disabled={!canAdd}
                onClick={() => {
                  set(newRole, {});
                  setAdding(null);
                }}
              >
                Add
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>
                Cancel
              </Button>
            </div>
          )}
        </RoutingGroup>
      )}
      {adding === null ? (
        <Button size="xs" variant="ghost" disabled={disabled} onClick={() => setAdding("")}>
          <PlusIcon className="size-3" aria-hidden />
          Route another agent
        </Button>
      ) : null}
    </div>
  );
}

function RoutingGroup({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium text-muted-foreground">{label}</h4>
      {children}
    </div>
  );
}

function RoutingRow({
  role,
  label,
  entry,
  models,
  disabled,
  onChange,
  onRemove,
}: {
  readonly role: string;
  readonly label: string;
  readonly entry: PiGentleRoutingEntry;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly disabled: boolean;
  readonly onChange: (entry: PiGentleRoutingEntry) => void;
  readonly onRemove: (() => void) | null;
}) {
  const { model: _model, ...withoutModel } = entry;
  const { thinking: _thinking, ...withoutThinking } = entry;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_7rem_1.5rem] items-center gap-x-2 gap-y-1 @min-[30rem]/routing:grid-cols-[6.5rem_minmax(0,1fr)_7.5rem_1.5rem]">
      <span className="col-span-3 truncate text-sm @min-[30rem]/routing:col-span-1">{label}</span>
      <GentleModelSelect
        agent={label}
        value={entry.model}
        models={models}
        disabled={disabled}
        onChange={(model) => onChange(model === undefined ? withoutModel : { ...entry, model })}
      />
      <Select
        value={entry.thinking ?? INHERIT}
        onValueChange={(next) => {
          if (next === null || next === (entry.thinking ?? INHERIT)) return;
          const thinking = THINKING.find((level) => level === next);
          onChange(thinking === undefined ? withoutThinking : { ...entry, thinking });
        }}
        disabled={disabled}
      >
        <SelectTrigger size="sm" className="min-w-0" aria-label={`${label} effort`}>
          <SelectValue>
            {entry.thinking === undefined ? "Default" : THINKING_LABELS[entry.thinking]}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={INHERIT}>Default</SelectItem>
          {THINKING.map((level) => (
            <SelectItem key={level} value={level}>
              {THINKING_LABELS[level]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {onRemove === null ? (
        <span />
      ) : (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Stop routing ${role}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <XIcon />
        </Button>
      )}
    </div>
  );
}

function GentleModelSelect({
  agent,
  value,
  models,
  disabled,
  onChange,
}: {
  readonly agent: string;
  readonly value: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly disabled: boolean;
  readonly onChange: (model: string | undefined) => void;
}) {
  const [query, setQuery] = useState("");
  const options = [INHERIT, ...models.map((model) => model.slug)];
  if (value && !options.includes(value)) options.push(value);
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = normalized
    ? options.filter((slug) => {
        if (slug === INHERIT) return "pi's default".includes(normalized);
        const model = models.find((entry) => entry.slug === slug);
        return `${model?.name ?? ""} ${model?.subProvider ?? ""} ${slug}`
          .toLocaleLowerCase()
          .includes(normalized);
      })
    : options;
  const selected = models.find((model) => model.slug === value);

  return (
    <Combobox
      items={options}
      filteredItems={filtered}
      value={value ?? INHERIT}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
      onValueChange={(model) => {
        if (model) onChange(model === INHERIT ? undefined : model);
      }}
    >
      <ComboboxTrigger
        render={<Button size="sm" variant="outline" />}
        className="w-full min-w-0 justify-between"
        aria-label={`${agent} model`}
        disabled={disabled}
      >
        <span className="min-w-0 truncate">
          {selected?.name ?? (value ? `Unavailable: ${value}` : "Pi's default")}
        </span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 opacity-60" />
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="w-80 min-w-0 max-w-[calc(100vw-1rem)]">
        <ComboboxSearchInput
          placeholder="Search Pi models…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No matching Pi models.</ComboboxEmpty>
        <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
          {filtered.map((slug) => {
            const model = models.find((entry) => entry.slug === slug);
            return (
              <ComboboxItem key={slug} value={slug} className="w-full min-w-0">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">
                    {slug === INHERIT ? "Pi's default" : (model?.name ?? `Unavailable: ${slug}`)}
                  </span>
                  {model ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {model.subProvider ?? "Pi"} · {slug}
                    </span>
                  ) : null}
                </span>
              </ComboboxItem>
            );
          })}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
