import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { findMachineProject } from "./machineProject.ts";

const remoteUrl = "https://github.com/MappTech-COL/MappStock";
const identity = (url: string) => ({ locator: { remoteUrl: url } });

it("finds the machine's checkout by its origin, or by its path while its origin is unknown", () => {
  const byOrigin = {
    id: ProjectId.make("by-origin"),
    workspaceRoot: "/home/user/elsewhere",
    repositoryIdentity: identity("git@github.com:MappTech-COL/MappStock.git"),
  };
  const fresh = {
    id: ProjectId.make("fresh"),
    workspaceRoot: "/home/user/mappstock",
    repositoryIdentity: null,
  };
  const otherRepo = {
    id: ProjectId.make("other"),
    workspaceRoot: "/home/user/mappstock",
    repositoryIdentity: identity("https://github.com/someone/MappStock.git"),
  };
  assert.strictEqual(findMachineProject([fresh, byOrigin], remoteUrl)?.id, "by-origin");
  // A second task moments after the first clone, before the machine resolved its origin.
  assert.strictEqual(findMachineProject([fresh], remoteUrl)?.id, "fresh");
  assert.isUndefined(findMachineProject([otherRepo], remoteUrl));
});
