# Bug Reproducer

## ✅ FIX_PROVEN — Bug reproduced and fix proven

> The same reproducer changed from failing to passing and broader checks passed.

**Project:** T3 Code  
**Bug:** Accepted provider turn remains pending  
**Environment:** Windows, Node.js v24.13.1, T3 Code 0.0.29-nightly.20260727.71  
**Generated:** 2026-07-27

## Original report

After updating to T3 Code 0.0.29-nightly.20260727.71, a continued Codex thread remained visibly pending/starting even though the provider accepted the turn and continued producing activity.

| Contract          | Expected                                                                                                                                                    | Actual                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Observed behavior | When sendTurn succeeds and returns a turn id, the projected thread session becomes running and adopts that turn id without requiring a second notification. | The provider runtime became running, but the orchestration session remained starting and the user message remained pending. |

## Minimal reproduction

The existing ProviderCommandReactor harness returns an accepted provider turn but deliberately emits no turn.started notification.

**Confirming signal:** The focused test timed out waiting for the session to transition from starting to running.

### Reproduction files approved at Gate 1

- [ProviderCommandReactor.test.ts](C:/Users/Santiago/Desktop/Projects/Azure/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts:441) — Focused accepted-turn regression test.

## Red to green evidence

| Evidence      |    Before fix |    After fix |
| ------------- | ------------: | -----------: |
| Exit code     |             1 |            0 |
| Timed out     |         False |        False |
| Duration      | 14,994.779 ms | 5,817.592 ms |
| Same command  |             — |         True |
| Broader suite |             — |       passed |

### Before — failing evidence

```text
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > acknowledges a provider-accepted turn without waiting for turn.started
Error: Timed out waiting for expectation.
 ❯ poll apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts:83:13
     81|     }
     82|     if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline…
     83|       throw new Error("Timed out waiting for expectation.");
       |             ^
     84|     }
     85|     await Effect.runPromise(Effect.yieldNow);
 ❯ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts:474:5

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
```

### After — fixed evidence

```text
RUN  v4.1.9 C:/Users/Santiago/Desktop/Projects/Azure/t3code

stdout | apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > acknowledges a provider-accepted turn without waiting for turn.started
[19:44:19.920] INFO (#12): Migrations ran successfully {
  migrations: [
    '1_OrchestrationEvents',
    '2_OrchestrationCommandReceipts',
    '3_CheckpointDiffBlobs',
    '4_ProviderSessionRuntime',
    '5_Projections',
    '6_ProjectionThreadSessionRuntimeModeColumns',
    '7_ProjectionThreadMessageAttachments',
    '8_ProjectionThreadActivitySequence',
    '9_ProviderSessionRuntimeMode',
    '10_ProjectionThreadsRuntimeMode',
    '11_OrchestrationThreadCreatedRuntimeMode',
    '12_ProjectionThreadsInteractionMode',
    '13_ProjectionThreadProposedPlans',
    '14_ProjectionThreadProposedPlanImplementation',
    '15_ProjectionTurnsSourceProposedPlan',
    '16_CanonicalizeModelSelections',
    '17_ProjectionThreadsArchivedAt',
    '18_ProjectionThreadsArchivedAtIndex',
    '19_ProjectionSnapshotLookupIndexes',
    '20_AuthAccessManagement',
    '21_AuthSessionClientMetadata',
    '22_AuthSessionLastConnectedAt',
    '23_ProjectionThreadShellSummary',
    '24_BackfillProjectionThreadShellSummary',
    '25_CleanupInvalidProjectionPendingApprovals',
    '26_CanonicalizeModelSelectionOptions',
    '27_ProviderSessionRuntimeInstanceId',
    '28_ProjectionThreadSessionInstanceId',
    '29_ProjectionThreadDetailOrderingIndexes',
    '30_ProjectionThreadShellArchiveIndexes',
    '31_AuthAuthorizationScopes',
    '32_AuthPairingProofKeyThumbprint',
    '33_ProjectionThreadsSettled',
    '34_ProjectionThreadsSnoozed'
  ]
}

 ↓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > provider error attribution > uses the current provider instance slug when current instance lookup fails
 ↓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > provider error attribution > uses the desired provider instance slug when desired instance lookup fails
 ↓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > provider error attribution > uses the unknown driver kind when the resolved driver is not registered locally
 ✓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > acknowledges a provider-accepted turn without waiting for turn.started 1933ms
 ↓ apps/server/src/orchestration/Lay
... [output truncated] ...
he active session when restart fails before rebind
 ↓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > rejects provider changes after a thread is already bound to a session provider
 ↓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > rejects cross-driver provider changes after the existing thread session has stopped
 ↓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > reacts to thread.turn.interrupt-requested by calling provider interrupt
 ↓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > starts a fresh session when only projected session state exists
 ↓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > leaves a selected stopped thread passive without sending a model turn
 ↓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > reattaches a live provider turn without losing its orchestration turn
 ↓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > marks a previously running turn interrupted when the resumed provider is ready
 ↓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > rejects active runtime sessions that are missing provider instance ids
 ↓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > reacts to thread.approval.respond by forwarding provider approval response
 ↓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > reacts to thread.user-input.respond by forwarding structured user input answers
 ↓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > surfaces stale provider approval request failures without faking approval resolution
 ↓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > surfaces non-resumable provider user-input callbacks as stale failures
 ↓ apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts > ProviderCommandReactor > reacts to thread.session.stop by stopping provider session and clearing thread session state

 Test Files  1 passed (1)
      Tests  1 passed | 36 skipped (37)
   Start at  19:44:16
   Duration  4.96s (transform 1.91s, setup 0ms, import 2.82s, tests 1.94s, environment 0ms)
```

## Root cause

ProviderCommandReactor discarded the successful sendTurn result after the accepted-turn acknowledgement was removed, leaving projection progress dependent on a redundant notification that may be delayed or absent.

## Approved fix

Restore the guarded acknowledgement of a successful sendTurn result and project its returned turn id as running.

**Why this is causal:** The acknowledgement updates exactly the stale starting session observed in the report, while its status guard prevents overwriting a turn that already completed or failed.

### Production files approved at Gate 2

- [ProviderCommandReactor.ts](C:/Users/Santiago/Desktop/Projects/Azure/t3code/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:320) — Guarded accepted-turn acknowledgement restored.

## Verification

| Check                    | Status    | Evidence                                                             |
| ------------------------ | --------- | -------------------------------------------------------------------- |
| Accepted-turn regression | ✅ passed | Exact command changed from exit 1 before the fix to exit 0 after it. |
| Slow provider startup    | ✅ passed | Session remains starting until sendTurn actually resolves.           |
| Server typecheck         | ✅ passed | vp run --filter t3 typecheck completed successfully.                 |
| Focused formatting       | ✅ passed | Both changed files pass vp fmt --check.                              |

## Reproduce

```bash
vp test run apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts -t "acknowledges a provider-accepted turn without waiting for turn.started" --reporter=verbose
```

## Limitations

- The fix applies to future builds from this source checkout; it does not hot-patch the already running installed nightly process.

## Residual risks

- The UI can show running slightly before a later turn.started notification, which is consistent with the successful turn/start response.

## Notes

- No UI files, schemas, migrations, dependencies, or public APIs changed.

---

Generated by `$bug-reproducer`. A fix is proven only by the same red-to-green reproducer plus relevant broader checks.
