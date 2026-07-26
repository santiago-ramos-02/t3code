# Bug Reproducer

## ✅ FIX_PROVEN — Bug reproduced and fix proven

> Both focused reproducers changed from deterministic failures to passes, and the affected server suites, typecheck, changed-production lint, formatting, and integrated boot/pairing check passed.

**Project:** T3 Code

**Bug:** Interrupted provider sessions remain falsely active and miss completed harness output after desktop restart

**Environment:** Windows, Vite+ 0.2.2, Vitest 4.1.9, isolated local T3 server and fake Codex runtimes; no real model calls

**Generated:** 2026-07-26

## Original report

Closing T3 Code while agents are working leaves the reopened chat showing agents as running even though the harness continued. Sending Continue then starts from T3's stale visible history and appears to fork the conversation. T3 should recover provider truth and display output missed while disconnected.

| Contract          | Expected                                                                                                                                                                                                                      | Actual                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observed behavior | On restart, an interrupted active session resumes from its persisted provider cursor, imports assistant output completed while T3 was closed, and settles to the provider's current status without sending another user turn. | The provider command reactor listened only for future events and Codex resume discarded thread history, leaving the projection stuck as running and the chat missing completed provider messages. |

## Minimal reproduction

One focused reactor test seeds a projected running session with an active turn before reactor startup and expects provider recovery without sendTurn. A second adapter test resumes a fake Codex thread containing a completed assistant message and expects a canonical item.completed event.

**Confirming signal:** Before the fix, startup called startSession zero times and resumed Codex called readThread zero times.

### Reproduction files approved at Gate 1

- [ProviderCommandReactor.test.ts](C:\Users\Santiago\Desktop\Projects\Azure\t3code\apps\server\src\orchestration\Layers\ProviderCommandReactor.test.ts:1821) — Seeds an active projected turn before startup and proves recovery occurs without sendTurn.
- [CodexAdapter.test.ts](C:\Users\Santiago\Desktop\Projects\Azure\t3code\apps\server\src\provider\Layers\CodexAdapter.test.ts:427) — Proves latest resumed assistant output enters the canonical event stream.

## Red to green evidence

| Evidence      | Before fix |    After fix |
| ------------- | ---------: | -----------: |
| Exit code     |          1 |            0 |
| Timed out     |      False |        False |
| Duration      |   4,400 ms | 4,878.522 ms |
| Same command  |          — |         True |
| Broader suite |          — |       passed |

### Before — failing evidence

```text
FAIL: expected startSession to be called 1 time, but got 0 times.
```

### After — fixed evidence

```text
Test Files 1 passed (1); Tests 1 passed | 34 skipped (35).
```

## Root cause

Desktop shutdown correctly stops local provider runtimes but leaves the last durable orchestration projection intact. On the next server start, ProviderCommandReactor subscribed only to future intent events, so it never reconciled projected active turns with persisted provider bindings. CodexAdapter resumed the provider thread but never read the returned durable thread history, so messages completed while T3 was offline never entered canonical ingestion.

## Approved fix

After subscribing to live domain events, ProviderCommandReactor scans lightweight thread shells and resumes only sessions with a projected active turn, without sending a new turn. On a Codex resume, CodexAdapter reads the latest provider turn and replays its assistant messages as stable canonical item.completed events. Recovery errors are isolated per thread so startup remains available.

**Why this is causal:** The startup scan repairs the exact durable/runtime state split that produced the false spinner, while the history replay feeds missed provider-owned assistant messages through the same canonical event path used during live streaming. Stable provider item IDs make replay idempotent and no synthetic user turn is sent.

### Production files approved at Gate 2

- [ProviderCommandReactor.ts](C:\Users\Santiago\Desktop\Projects\Azure\t3code\apps\server\src\orchestration\Layers\ProviderCommandReactor.ts:1087) — Reconciles projected active sessions during reactor startup.
- [CodexAdapter.ts](C:\Users\Santiago\Desktop\Projects\Azure\t3code\apps\server\src\provider\Layers\CodexAdapter.ts:1488) — Reads resumed Codex history and replays latest assistant messages canonically.

## Verification

| Check                                                     | Status    | Evidence                                                                                                                                                             |
| --------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup recovery reproducer                               | ✅ passed | Red before (startSession 0), green after.                                                                                                                            |
| History replay reproducer                                 | ✅ passed | Red before (readThread 0), green after.                                                                                                                              |
| ProviderCommandReactor suite                              | ✅ passed | 35 tests passed.                                                                                                                                                     |
| CodexAdapter suite                                        | ✅ passed | 26 tests passed.                                                                                                                                                     |
| ProviderRuntimeIngestion assistant completion cases       | ✅ passed | 4 focused tests passed.                                                                                                                                              |
| Server typecheck, changed-production lint, and formatting | ✅ passed | All completed successfully; typecheck emitted only pre-existing suggestions. The full reactor test file retains an unrelated lint violation already present at HEAD. |
| Integrated web boot and pairing                           | ✅ passed | Isolated server listened, client loaded, pairing redirected to the authenticated T3 Code dev app, and the server was stopped afterward.                              |

## Reproduce

```bash
vp test run apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts -t "recovers a projected active session when the reactor starts"
```

```bash
vp test run apps/server/src/provider/Layers/CodexAdapter.test.ts -t "replays the latest resumed Codex turn into the canonical event stream"
```

## Limitations

- The regression uses fake provider runtimes and does not spend model tokens.
- The integrated browser confirmed boot, authentication, and client load; the provider-resume state transition is verified at the server layer.
- The changed production files and Codex adapter test lint cleanly; the full ProviderCommandReactor test file has an unrelated pre-existing manual Effect runtime lint violation.

## Residual risks

- A crash before any provider resume cursor is persisted cannot reconstruct provider work that never received a durable continuation identity.
- Recovery currently imports assistant messages from the latest resumed Codex turn, which matches the interrupted-turn scenario.

## Notes

- No provider API calls or agent subscription usage were used for testing.
- No synthetic user turn is sent during startup recovery.

---

Generated by `$bug-reproducer`. A fix is proven only by the same red-to-green reproducer plus relevant broader checks.
