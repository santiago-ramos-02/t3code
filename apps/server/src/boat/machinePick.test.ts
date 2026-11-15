import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { parseUsage, pickMachine, type PickCandidate } from "./machinePick.ts";

const running = (sandboxId: string, usage: number | null, hasCheckout = false): PickCandidate => ({
  sandboxId,
  state: "running",
  hasCheckout,
  usage,
});
const stopped = (sandboxId: string, hasCheckout = false): PickCandidate => ({
  sandboxId,
  state: "stopped",
  hasCheckout,
  usage: null,
});

describe("pickMachine", () => {
  it("prefers, in order: running with the checkout, stopped with it, running with room, stopped", () => {
    const busyWithCheckout = running("busy-checkout", 0.5, true);
    const idle = running("idle", 0.1);
    const idleWithCheckout = running("idle-checkout", 0.4, true);
    const stoppedWithCheckout = stopped("stopped-checkout", true);
    const plainStopped = stopped("stopped");

    const order = [
      [idle, plainStopped, stoppedWithCheckout, idleWithCheckout, busyWithCheckout],
      [idle, plainStopped, stoppedWithCheckout, busyWithCheckout],
      [idle, plainStopped, busyWithCheckout],
      [plainStopped, busyWithCheckout, running("unknown", null)],
    ].map((candidates) => pickMachine(candidates)?.sandboxId);

    assert.deepStrictEqual(order, ["idle-checkout", "stopped-checkout", "idle", "stopped"]);
  });

  it("takes the least used of equals, and nothing when every machine is busy", () => {
    assert.strictEqual(
      pickMachine([running("a", 0.4, true), running("b", 0.2, true)])?.sandboxId,
      "b",
    );
    assert.isUndefined(pickMachine([running("a", 0.5), running("b", null, true)]));
  });
});

describe("parseUsage", () => {
  it("takes the busier of load per core and memory in use", () => {
    // 1 / 4 cores = 0.25 load, and 1 - 6000 / 8000 = 0.25 memory.
    assert.deepStrictEqual(parseUsage("noise\n1.00 4 8000 6000\n"), Option.some(0.25));
    assert.deepStrictEqual(parseUsage("4.00 4 8000 6000"), Option.some(1));
    assert.deepStrictEqual(parseUsage("0.00 4 8000 1000"), Option.some(0.875));
  });

  it("gives nothing for output it cannot trust", () => {
    for (const output of ["", "1.0 4 8000", "x 4 8000 6000", "1.0 0 8000 6000", "1.0 4 0 0"]) {
      assert.isTrue(Option.isNone(parseUsage(output)), output);
    }
  });
});
