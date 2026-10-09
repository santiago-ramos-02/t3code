/**
 * OpenCodeGentleDriver — upstream's OpenCode driver plus Gentle AI off: a T3-started server
 * launches without gentle-ai for a thread that turned it off, and OpenCode 2, which serves every
 * thread from one server, refuses that switch. The driver takes both through its
 * OpenCodeGentleHooks service, so @t3tools/provider-opencode stays upstream's.
 */
import type { OpenCodeSettings } from "@t3tools/provider-opencode/settings";
import type { ProviderDriver, ProviderUsageReaderEnv } from "@t3tools/provider-core/server/driver";
import { OpenCodeDriver, type OpenCodeDriverEnv } from "@t3tools/provider-opencode/server";
import { OpenCodeGentleHooks } from "@t3tools/provider-opencode/server/gentleHooks";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import { withoutGentleAiOff } from "../../gentleAi/GentleAiSessionPolicy.ts";
import {
  makeOpenCodeGentleOffSession,
  OPENCODE_SERVER_GENTLE_OFF_UNSUPPORTED,
} from "../../gentleAi/GentleAiSessions.ts";

export type OpenCodeGentleDriverEnv = OpenCodeDriverEnv | Crypto.Crypto;

export const OpenCodeGentleDriver: ProviderDriver<
  OpenCodeSettings,
  OpenCodeGentleDriverEnv,
  ProviderUsageReaderEnv<typeof OpenCodeDriver>
> = {
  ...OpenCodeDriver,
  create: (input) =>
    Effect.gen(function* () {
      const prepareSession = yield* makeOpenCodeGentleOffSession(
        OpenCodeDriver.driverKind,
        input.instanceId,
      );
      return yield* OpenCodeDriver.create(input).pipe(
        Effect.provideService(OpenCodeGentleHooks, {
          prepareSession,
          wrapSharedServerAdapter: (adapter) =>
            withoutGentleAiOff(adapter, OPENCODE_SERVER_GENTLE_OFF_UNSUPPORTED),
        }),
      );
    }),
};
