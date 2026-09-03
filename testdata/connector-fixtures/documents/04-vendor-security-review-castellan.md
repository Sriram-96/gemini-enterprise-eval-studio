# Vendor Security Review: Castellan Data Systems

**Review ID:** VSR-2026-018
**Reviewer:** Ingrid Solberg, Security Assurance
**Review completed:** 14 May 2026
**Migration completed:** 28 May 2026
**Re-review due:** 28 May 2027
**Classification:** Internal — Security

## Outcome

**Approved with conditions.** Overall risk rating **Moderate**, composite score
**62 out of 100**.

## Scope of approval

Castellan Data Systems is approved to process **tokenized payment metadata
only**.

Castellan is **not approved to receive raw primary account numbers (PAN),
CVV values, or cardholder names**. Any integration that would place these in
scope requires a new review and sign-off from the Security Assurance lead
before deployment.

## Score breakdown

| Domain | Score |
| --- | --- |
| Access control | 78 |
| Encryption in transit and at rest | 81 |
| Incident response maturity | 55 |
| Subprocessor management | 49 |
| Business continuity | 47 |

## Known gaps

1. **No SOC 2 Type II report until Q1 2027.** Castellan holds a Type I only.
   This is the single largest contributor to the Moderate rating.
2. **Subprocessor list is not contractually change-notified.** Castellan may
   add subprocessors with 10 days' notice; our standard is 30.
3. **Recovery time objective is 8 hours**, against our 4-hour internal target
   for payment-path vendors.

## Conditions of approval

- Quarterly attestation call, first Tuesday of the quarter.
- Immediate notification of any Castellan security incident touching our tenant.
- Re-review triggered early if Castellan is acquired or changes its primary
  hosting region.

## Notes

The tokenization endpoint is invoked **once per line item** rather than once per
basket. Downstream teams should account for this in concurrency planning; see
Incident Postmortem INC-4471.
