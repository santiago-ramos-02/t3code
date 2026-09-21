import { describe, expect, it } from "vite-plus/test";

import { resolveFirstRunGateDecisionAfterCompletion } from "./FirstRunGate";

describe("resolveFirstRunGateDecisionAfterCompletion", () => {
  it("releases an active welcome gate after its completion authority persists", () => {
    expect(resolveFirstRunGateDecisionAfterCompletion("wizard", false)).toBe("wizard");
    expect(resolveFirstRunGateDecisionAfterCompletion("wizard", true)).toBe("app");
  });

  it("does not rewrite decisions that did not enter the welcome wizard", () => {
    expect(resolveFirstRunGateDecisionAfterCompletion("pending", true)).toBe("pending");
    expect(resolveFirstRunGateDecisionAfterCompletion("app", true)).toBe("app");
  });
});
