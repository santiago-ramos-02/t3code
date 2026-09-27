import { GENTLE_SDD_LABELS } from "@t3tools/client-runtime/piGentleComposer";
import type { PiGentleSddPreferences } from "@t3tools/contracts";
import { useId, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { useComposerMenuProps } from "./composerEventScope";

/**
 * SDD preflight for a project: the user confirms or changes Gentle AI's suggested choices, and
 * setup saves them before Gentle AI prepares the project.
 */
export function GentleSddSetupDialog({
  open,
  setUp,
  initial,
  pending,
  error,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  /** True once the project has saved choices, so submitting updates them. */
  readonly setUp: boolean;
  readonly initial: PiGentleSddPreferences;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (preferences: PiGentleSddPreferences) => void;
}) {
  const floatingLayer = useComposerMenuProps();
  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogPopup {...floatingLayer} className="sm:max-w-md">
        {/* Remounts per opening so the form starts from the project's current choices. */}
        {open ? (
          <SddSetupForm
            setUp={setUp}
            initial={initial}
            pending={pending}
            error={error}
            onCancel={() => onOpenChange(false)}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function SddSetupForm({
  setUp,
  initial,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  readonly setUp: boolean;
  readonly initial: PiGentleSddPreferences;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (preferences: PiGentleSddPreferences) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const [budget, setBudget] = useState<number | null>(initial.reviewBudgetLines);
  const budgetValid = budget !== null && Number.isInteger(budget) && budget > 0;
  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (budgetValid) onSubmit({ ...draft, reviewBudgetLines: budget });
      }}
    >
      <DialogHeader>
        <DialogTitle>{setUp ? "SDD preferences" : "Set up SDD"}</DialogTitle>
        <DialogDescription>
          Saved in .pi/gentle-ai/sdd-preflight.json. Gentle AI asks you to confirm them the first
          time each thread uses SDD.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SddChoiceField
            id={`${id}-execution`}
            label="Execution"
            value={draft.executionMode}
            labels={GENTLE_SDD_LABELS.executionMode}
            disabled={pending}
            onChange={(executionMode) => setDraft((current) => ({ ...current, executionMode }))}
          />
          <SddChoiceField
            id={`${id}-artifacts`}
            label="Artifacts"
            value={draft.artifactStore}
            labels={GENTLE_SDD_LABELS.artifactStore}
            disabled={pending}
            onChange={(artifactStore) => setDraft((current) => ({ ...current, artifactStore }))}
          />
          <SddChoiceField
            id={`${id}-delivery`}
            label="Delivery"
            value={draft.chainedPrStrategy}
            labels={GENTLE_SDD_LABELS.chainedPrStrategy}
            disabled={pending}
            onChange={(chainedPrStrategy) =>
              setDraft((current) => ({ ...current, chainedPrStrategy }))
            }
          />
          <NumberField
            id={`${id}-budget`}
            min={1}
            step={1}
            value={budget}
            disabled={pending}
            onValueChange={setBudget}
          >
            <Label htmlFor={`${id}-budget`}>Review budget (lines)</Label>
            <NumberFieldGroup>
              <NumberFieldDecrement aria-label="Decrease review budget" />
              <NumberFieldInput required />
              <NumberFieldIncrement aria-label="Increase review budget" />
            </NumberFieldGroup>
          </NumberField>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !budgetValid}>
          {pending ? <Spinner className="size-3.5" /> : null}
          {setUp ? "Save" : "Set up"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function SddChoiceField<T extends string>({
  id,
  label,
  value,
  labels,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: T;
  readonly labels: Record<T, string>;
  readonly disabled: boolean;
  readonly onChange: (value: T) => void;
}) {
  const options = Object.keys(labels).filter((key): key is T => Object.hasOwn(labels, key));
  return (
    <Label className="flex min-w-0 flex-col items-stretch" htmlFor={id}>
      {label}
      <Select
        value={value}
        items={labels}
        disabled={disabled}
        onValueChange={(next) => {
          const option = options.find((candidate) => candidate === next);
          if (option !== undefined) onChange(option);
        }}
      >
        <SelectTrigger id={id} className="min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {labels[option]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Label>
  );
}
