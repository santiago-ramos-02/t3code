import { ForkWsRpcGroup, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CliProxy from "./cliProxy/CliProxy.ts";
import * as GentleAi from "./gentleAi/GentleAi.ts";
import * as Engram from "./memory/Engram.ts";
import { RpcInstrumentation } from "./observability/RpcInstrumentation.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import { runPiGentle, runPiGentleAction } from "./provider/PiGentleRpc.ts";

const ServerForkWsRpcGroup = ForkWsRpcGroup.middleware(RpcInstrumentation);

/** Handlers for the fork's RPCs, served next to the core WebSocket handlers. */
export const layer = ServerForkWsRpcGroup.toLayer(
  Effect.gen(function* () {
    const gentleAi = yield* GentleAi.GentleAi;
    const cliProxy = yield* CliProxy.CliProxy;
    const engram = yield* Engram.Engram;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const providerSessionManager = yield* ProviderSessionManager.ProviderSessionManagerV2;

    return ServerForkWsRpcGroup.of({
      [WS_METHODS.gentleAiRead]: () => gentleAi.current,
      [WS_METHODS.gentleAiAction]: (input) => gentleAi.action(input),
      [WS_METHODS.gentleAiQuery]: (input) =>
        gentleAi.query(input.method, input.params).pipe(Effect.map((data) => ({ data }))),
      [WS_METHODS.gentleAiStartJob]: (input) => gentleAi.startJob(input.method, input.params),
      [WS_METHODS.gentleAiSubscribeStatus]: () => gentleAi.streamChanges,
      [WS_METHODS.gentleAiSubscribeJob]: () => gentleAi.streamJob,
      [WS_METHODS.cliProxySubscribeStatus]: () => cliProxy.streamChanges,
      [WS_METHODS.cliProxyAction]: (input) => cliProxy.action(input.action),
      [WS_METHODS.cliProxyManagement]: (input) => cliProxy.management(input),
      [WS_METHODS.memoryOverview]: () => engram.overview,
      [WS_METHODS.memorySearch]: (input) => engram.search(input),
      [WS_METHODS.memoryObservation]: (input) => engram.observation(input.id),
      [WS_METHODS.memoryHealth]: () => engram.health,
      [WS_METHODS.memoryJudge]: (input) => engram.judge(input).pipe(Effect.as({})),
      [WS_METHODS.memoryExportObsidian]: (input) => engram.exportObsidian(input),
      [WS_METHODS.providerPiGentleRead]: (input) =>
        runPiGentle(providerInstances, input.instanceId, "pi-gentle-read", (gentle) =>
          gentle.read(input.cwd, { refresh: input.refresh === true }),
        ),
      [WS_METHODS.providerPiGentleComposerRead]: (input) =>
        runPiGentle(providerInstances, input.instanceId, "pi-gentle-composer-read", (gentle) =>
          gentle.readComposer(input.cwd),
        ),
      [WS_METHODS.providerPiGentleAction]: (input) =>
        runPiGentleAction(
          providerInstances,
          providerSessionManager,
          input.instanceId,
          input.action,
        ),
    });
  }),
);
