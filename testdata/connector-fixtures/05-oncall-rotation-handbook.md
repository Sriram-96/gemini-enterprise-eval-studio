# On-Call Rotation Handbook

**Owner:** Platform Reliability
**Last revised:** 3 February 2026
**Classification:** Internal — Engineering

## Acknowledgement and escalation

A paged primary has **12 minutes** to acknowledge. If no acknowledgement is
recorded within 12 minutes, the secondary is paged automatically. If the
secondary does not acknowledge within a further 8 minutes, the reliability
manager is paged.

For a Sev1, an **exec bridge must be opened within 25 minutes** of the page,
regardless of whether the incident is already mitigated.

## Rotation mechanics

- Rotation length: **6 days**
- Handoff: **Tuesdays at 10:00 UTC**
- Handoff requires a written summary of open issues in the rotation channel;
  a verbal handoff alone is not sufficient.
- No engineer may be scheduled for more than two consecutive rotations.

## Compensation

| Shift | Rate |
| --- | --- |
| Weeknight (18:00–08:00 local) | $145 |
| Weekend day (per day) | **$340** |
| Public holiday (per day) | $510 |

## Severity definitions

| Severity | Definition | Response |
| --- | --- | --- |
| Sev1 | Revenue-path outage or data-integrity risk | Page immediately, exec bridge within 25 min |
| Sev2 | Degraded service, workaround exists | Page during business hours |
| Sev3 | Non-urgent defect | Ticket only, no page |

## Escalation contacts by area

| Area | Primary escalation |
| --- | --- |
| Payments and checkout | Priya Vellanki |
| Identity | Marcus Oyelaran |
| Data platform | Ingrid Solberg |

## Post-incident obligations

A Sev1 requires a written postmortem within **5 business days**, with action
items assigned to named owners and dated. Postmortems are blameless; the
timeline is reconstructed from logs, not from recollection.
