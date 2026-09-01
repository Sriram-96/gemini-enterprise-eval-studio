# Incident Postmortem INC-4471

**Date of incident:** 12 June 2026
**Severity:** Sev1
**Incident commander:** Priya Vellanki
**Scribe:** Marcus Oyelaran
**Classification:** Internal — Engineering

## Summary

Checkout was degraded for **47 minutes**, from 14:06 to 14:53 UTC, when the
Tessellate payment router began rejecting connections under load. **3,140
transactions failed** during the window. No customer payment data was exposed
and no double-charges occurred.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 14:06 | Checkout error rate crosses 5%; primary paged |
| 14:11 | Primary acknowledges; secondary not required |
| 14:19 | Tessellate connection saturation identified as the likely cause |
| 14:31 | Exec bridge opened per Sev1 procedure |
| 14:44 | Connection pool ceiling raised from 128 to 512; error rate begins falling |
| 14:53 | Error rate returns to baseline; incident declared resolved |

## Root cause

The `tessellate-edge` service carried a **connection pool ceiling of 128**, a
value set in 2023 and never revisited. The Castellan Data Systems migration
completed on 28 May 2026 **roughly doubled per-request fan-out** to the payment
router, because Castellan's tokenization endpoint is called once per line item
rather than once per basket.

Under normal traffic the doubled fan-out stayed below the ceiling. The 12 June
promotional campaign pushed sustained concurrency past 128, at which point new
connections were refused and checkout failed for the affected sessions.

The ceiling was not caught in load testing because the pre-migration load
profile was replayed unchanged, and it did not include the per-line-item
tokenization call.

## Contributing factors

- No alert existed on connection pool utilisation, only on error rate, so the
  first signal was customer-visible failure.
- The Castellan migration runbook did not list downstream concurrency as an
  affected dimension.

## Action items

| ID | Action | Owner | Due |
| --- | --- | --- | --- |
| AI-4471-1 | Alert at 70% connection pool utilisation | Priya Vellanki | 30 June 2026 |
| AI-4471-2 | Re-run load tests with post-Castellan fan-out profile | Marcus Oyelaran | **31 July 2026** |
| AI-4471-3 | Add downstream concurrency to the migration runbook template | Ingrid Solberg | 14 August 2026 |

## Related documents

- Vendor Security Review: Castellan Data Systems (VSR-2026-018)
- On-Call Rotation Handbook
