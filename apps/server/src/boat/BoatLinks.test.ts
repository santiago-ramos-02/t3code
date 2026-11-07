import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, type BoatStatus, type PeerLink } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as BoatLinks from "./BoatLinks.ts";
import * as BoatMachines from "./BoatMachines.ts";

const sandboxId = "bx_link0001";
const machineUrl = "https://box-node-abc-3773.on.boat.dev";
const machineEnvironment = EnvironmentId.make("environment:boat-machine");
const otherEnvironment = EnvironmentId.make("environment:other");

const storedLink = (environmentId: EnvironmentId, url: string, expiresAt: string): PeerLink => ({
  environmentId,
  label: "Boat",
  urls: [url],
  access: "full-access",
  linkedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe(expiresAt),
  lastReachedAt: null,
  lastError: null,
});

const statusWith = (input: Partial<BoatStatus>) =>
  ({
    machines: [{ sandboxId, state: "running", httpBaseUrl: machineUrl }],
    deleted: [],
    ...input,
  }) as unknown as BoatStatus;

const run = <A, E>(
  input: {
    readonly enabled?: boolean;
    readonly stored?: PeerLink;
    readonly status?: BoatStatus;
    readonly listed?: ReadonlyArray<PeerLink>;
  },
  body: (
    links: BoatLinks.BoatLinks["Service"],
    calls: Ref.Ref<ReadonlyArray<string>>,
    unlinked: Deferred.Deferred<EnvironmentId>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const unlinked = yield* Deferred.make<EnvironmentId>();
    const record = (call: string) => Ref.update(calls, (all) => [...all, call]);
    const status = input.status ?? statusWith({});
    const layer = BoatLinks.layer.pipe(
      Layer.provide(
        Layer.mock(BoatMachines.BoatMachines)({
          current: Effect.succeed(status),
          streamChanges: Stream.make(status),
          pair: (pairing) =>
            record(`pair ${pairing.sandboxId}`).pipe(
              Effect.as({ httpBaseUrl: machineUrl, pairingCredential: "PAIR-CODE" }),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(PeerLinks.PeerLinks)({
          enabled: Effect.succeed(input.enabled ?? true),
          describe: () => Effect.succeedSome({ environmentId: machineEnvironment, label: "Boat" }),
          get: () => Effect.succeed(Option.fromNullishOr(input.stored)),
          link: (linking) =>
            record(`link ${linking.url} ${linking.pairingCode} ${linking.access}`).pipe(
              Effect.as(storedLink(machineEnvironment, machineUrl, "2026-12-31T00:00:00.000Z")),
            ),
          list: Effect.succeed(
            (input.listed ?? []).map((link) => ({ ...link, status: "reachable" as const })),
          ),
          unlink: (environmentId) =>
            Deferred.succeed(unlinked, environmentId).pipe(Effect.as(true)),
        }),
      ),
    );
    // Built in the test's scope, so the watcher for deleted machines keeps running.
    const links = Context.get(yield* Layer.build(layer), BoatLinks.BoatLinks);
    return yield* body(links, calls, unlinked);
  }).pipe(Effect.scoped);

describe("BoatLinks", () => {
  it.effect("keeps a link the machine still answers to, without a new pairing", () =>
    run(
      { stored: storedLink(machineEnvironment, machineUrl, "2099-01-01T00:00:00.000Z") },
      (links, calls) =>
        Effect.gen(function* () {
          assert.strictEqual(yield* links.link(sandboxId), machineEnvironment);
          assert.deepStrictEqual(yield* Ref.get(calls), []);
        }),
    ),
  );

  it.effect("links the machine with a new pairing when its link expired", () =>
    run(
      // The test clock starts at the epoch.
      { stored: storedLink(machineEnvironment, machineUrl, "1969-12-31T00:00:00.000Z") },
      (links, calls) =>
        Effect.gen(function* () {
          assert.strictEqual(yield* links.link(sandboxId), machineEnvironment);
          assert.deepStrictEqual(yield* Ref.get(calls), [
            `pair ${sandboxId}`,
            `link ${machineUrl} PAIR-CODE full-access`,
          ]);
        }),
    ),
  );

  it.effect("says to turn on Linked environments when it is off here", () =>
    run({ enabled: false }, (links, calls) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(links.link(sandboxId));
        assert.isTrue(Exit.isFailure(exit));
        assert.include(JSON.stringify(exit), "Settings → Labs");
        assert.deepStrictEqual(yield* Ref.get(calls), []);
      }),
    ),
  );

  it.effect("drops the link of a deleted machine and keeps the others", () =>
    run(
      {
        status: statusWith({
          machines: [],
          deleted: [
            {
              sandboxId,
              label: "Boat",
              httpBaseUrl: machineUrl,
              reason: "Deleted from Settings.",
              deletedAt: "2026-11-06T00:00:00.000Z",
            },
          ],
        }),
        listed: [
          storedLink(otherEnvironment, "https://laptop.example.ts.net", "2099-01-01T00:00:00.000Z"),
          storedLink(machineEnvironment, `${machineUrl}/`, "2099-01-01T00:00:00.000Z"),
        ],
      },
      (_links, _calls, unlinked) =>
        Effect.gen(function* () {
          assert.strictEqual(yield* Deferred.await(unlinked), machineEnvironment);
        }),
    ),
  );
});
