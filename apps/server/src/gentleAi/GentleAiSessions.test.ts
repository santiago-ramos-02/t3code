import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { GentleAiFootprints } from "./GentleAiFootprints.ts";
import { makePiGentleSession } from "./GentleAiSessions.ts";

const PI = ProviderDriverKind.make("pi");
const FORK_GENTLE_AI = process.platform === "win32" ? "C:\\bin\\gentle-ai.exe" : "/bin/gentle-ai";

const input = () => ({
  threadId: ThreadId.make("thread-pi-gentle"),
  providerSessionId: ProviderSessionId.make("session-pi-gentle"),
  modelSelection: {
    instanceId: ProviderInstanceId.make("pi"),
    model: "claude-opus",
  },
  runtimePolicy: {
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    cwd: null,
  },
});

const withBinary = (binary: string | null) =>
  Effect.provideService(GentleAiFootprints, {
    forAgents: () => Effect.succeed(null),
    binary: Effect.succeed(binary),
  });

it.layer(NodeServices.layer)("makePiGentleSession", (it) => {
  it.effect("names T3 Code's gentle-ai for gentle-pi on Gentle AI threads", () =>
    Effect.gen(function* () {
      const prepare = yield* makePiGentleSession(PI).pipe(withBinary(FORK_GENTLE_AI));
      const launch = yield* prepare(input(), { args: [], environment: {}, cwd: "/repo" });
      expect(launch.environment.GENTLE_PI_T3_GENTLE_AI).toBe(FORK_GENTLE_AI);
      expect(launch.environment.GENTLE_SHELL_INTERACTIVE_HOST).toBe("1");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps an explicit value and names nothing without an absolute gentle-ai", () =>
    Effect.gen(function* () {
      const explicit = yield* makePiGentleSession(PI).pipe(withBinary(FORK_GENTLE_AI));
      const kept = yield* explicit(input(), {
        args: [],
        environment: { GENTLE_PI_T3_GENTLE_AI: "/custom/gentle-ai" },
        cwd: "/repo",
      });
      expect(kept.environment.GENTLE_PI_T3_GENTLE_AI).toBe("/custom/gentle-ai");

      for (const binary of [null, "gentle-ai"]) {
        const prepare = yield* makePiGentleSession(PI).pipe(withBinary(binary));
        const launch = yield* prepare(input(), { args: [], environment: {}, cwd: "/repo" });
        expect(launch.environment.GENTLE_PI_T3_GENTLE_AI).toBeUndefined();
      }
    }).pipe(Effect.scoped),
  );
});
