import { EnvironmentId, type BoatStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import type { EnvironmentPresentation } from "../state/environments";
import { useBoatMachineWake } from "./useBoat";

const HOST = EnvironmentId.make("host");
const MACHINE_ENVIRONMENT = EnvironmentId.make("machine");

const testState = vi.hoisted(() => ({
  status: null as BoatStatus | null,
  wakeBoatMachine: vi.fn<(input: { readonly sandboxId: string }) => Promise<void>>(),
}));

vi.mock(import("../lib/boatMachine"), async () => ({
  wakeBoatMachine: testState.wakeBoatMachine,
}));
vi.mock(import("../state/environments"), async () => ({
  usePrimaryEnvironmentId: () => HOST,
  useEnvironment: () => null,
}));
vi.mock(import("../state/query"), async () => ({
  useEnvironmentQuery: (() => ({ data: testState.status })) as never,
}));
vi.mock(import("../state/server"), async () => ({
  serverEnvironment: { boatStatus: () => null } as never,
}));
vi.mock(import("../state/session"), async () => ({
  useEnvironmentScope: () => true,
}));

function setup(state: "stopped" | "running") {
  testState.wakeBoatMachine.mockReset();
  testState.wakeBoatMachine.mockResolvedValue(undefined);
  // Only the fields the hook reads.
  testState.status = {
    machines: [{ sandboxId: "box-1", state, httpBaseUrl: "https://box-1.example" }],
  } as never;
}

const environment = {
  environmentId: MACHINE_ENVIRONMENT,
  displayUrl: "https://box-1.example/",
} as EnvironmentPresentation;

function Probe() {
  const wake = useBoatMachineWake(environment);
  return wake ? (
    <button type="button" onClick={() => void wake.wake()}>
      Resume
    </button>
  ) : (
    <output>awake</output>
  );
}

describe("useBoatMachineWake", () => {
  it("leaves a stopped machine stopped when its thread opens, and wakes it on request", async () => {
    setup("stopped");
    await using screen = await render(<Probe />, { router: false });
    await expect.element(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(testState.wakeBoatMachine).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(testState.wakeBoatMachine).toHaveBeenCalledOnce();
    expect(testState.wakeBoatMachine).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "box-1" }),
    );
  });

  it("offers nothing for a machine that is running", async () => {
    setup("running");
    await using screen = await render(<Probe />, { router: false });
    await expect.element(screen.getByText("awake")).toBeInTheDocument();
    expect(testState.wakeBoatMachine).not.toHaveBeenCalled();
  });
});
