import type { MachineStartRow } from "../../lib/machineStartSteps";
import { SetupStepRow } from "./WorktreeSetupCard";

/** The rows of adding a project to another machine, in the same look as a worktree's setup. */
export function BoatMachineStartSteps({ rows }: { rows: ReadonlyArray<MachineStartRow> }) {
  return (
    <section aria-label="Adding project to machine">
      {rows.map((row) => (
        <SetupStepRow
          key={row.id}
          id={row.id}
          label={row.label}
          status={row.status}
          detail={row.detail}
          elapsed={null}
        />
      ))}
    </section>
  );
}
