import { BoatError, type BoatDeletedMachine, type EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as BoatMachines from "./BoatMachines.ts";

export const BOAT_LINKS_OFF =
  "Work on a Boat machine runs in a linked environment, and Linked environments is off here. Turn it on in Settings → Labs.";

/**
 * This server's links to its Boat machines over T3 Connect, so work there runs as ordinary
 * threads in the machine's environment. A machine's link goes when the machine does.
 */
export class BoatLinks extends Context.Service<
  BoatLinks,
  {
    /** The machine's environment, linked with a new pairing from it unless a link still holds. */
    readonly link: (sandboxId: string) => Effect.Effect<EnvironmentId, BoatError>;
  }
>()("t3/boat/BoatLinks") {}

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

const make = Effect.gen(function* () {
  const machines = yield* BoatMachines.BoatMachines;
  const links = yield* PeerLinks.PeerLinks;
  // Two tasks for one machine would each spend a pairing on the same link.
  const linking = yield* Semaphore.make(1);

  // The stored link to this machine's address; using it still checks who answers there.
  const heldLink = Effect.fn("BoatLinks.heldLink")(function* (httpBaseUrl: string) {
    const origin = originOf(httpBaseUrl);
    const now = yield* DateTime.now;
    const stored = (yield* links.list.pipe(Effect.orElseSucceed(() => []))).find(
      (link) =>
        link.urls.some((url) => originOf(url) === origin) &&
        DateTime.isGreaterThan(link.expiresAt, now),
    );
    return Option.fromNullishOr(stored?.environmentId);
  });

  const link = Effect.fn("BoatLinks.link")(function* (sandboxId: string) {
    if (!(yield* links.enabled)) return yield* new BoatError({ detail: BOAT_LINKS_OFF });
    const machine = (yield* machines.current).machines.find((m) => m.sandboxId === sandboxId);
    if (machine?.state === "running" && machine.httpBaseUrl !== null) {
      const held = yield* heldLink(machine.httpBaseUrl);
      if (Option.isSome(held)) return held.value;
    }
    const paired = yield* machines.pair({ sandboxId });
    const linked = yield* links
      .link({
        url: paired.httpBaseUrl,
        pairingCode: paired.pairingCredential,
        access: "full-access",
      })
      .pipe(Effect.mapError((error) => new BoatError({ detail: error.message })));
    return linked.environmentId;
  }, linking.withPermits(1));

  const unlinkDeleted = Effect.fn("BoatLinks.unlinkDeleted")(function* (
    deleted: ReadonlyArray<BoatDeletedMachine>,
  ) {
    const gone = new Set(
      deleted.flatMap((machine) =>
        machine.httpBaseUrl === null ? [] : [originOf(machine.httpBaseUrl)],
      ),
    );
    if (gone.size === 0) return;
    for (const stored of yield* links.list) {
      if (stored.urls.some((url) => gone.has(originOf(url)))) {
        yield* links.unlink(stored.environmentId);
      }
    }
  });

  // Each deleted machine is looked at once, including those deleted while this server was off.
  const seen = new Set<string>();
  yield* machines.streamChanges.pipe(
    Stream.map((status) => status.deleted.filter((machine) => !seen.has(machine.sandboxId))),
    Stream.filter((fresh) => fresh.length > 0),
    Stream.runForEach((fresh) =>
      unlinkDeleted(fresh).pipe(
        Effect.ensuring(Effect.sync(() => fresh.forEach((machine) => seen.add(machine.sandboxId)))),
        Effect.ignoreCause({ log: true }),
      ),
    ),
    Effect.forkScoped,
  );

  return BoatLinks.of({ link });
});

export const layer = Layer.effect(BoatLinks, make);
