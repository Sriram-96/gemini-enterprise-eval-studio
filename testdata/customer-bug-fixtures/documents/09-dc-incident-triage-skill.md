# Custom Skill Definition — DC Incident Triage

**Not a document to index.** This is the custom skill you must create in the
agent before running `queryset.baseline-skill-trigger.csv`.

> This fixture drives bug #43: custom skills do not auto-trigger from natural
> language prompts even when the prompt repeats a phrase verbatim from the
> skill description. Manual invocation with `@` or `/` works.
>
> The customer's report is specific about the setup — a description carrying
> 20+ trigger phrases, kept inside the 1024-character limit — so the skill
> below is built the same way. If you shorten the description or drop the
> trigger phrases, the query set stops testing the reported bug.

## Skill name

```
DC Incident Triage
```

## Skill description

Character count: 986, inside the 1024 limit. Every phrase in the query set
appears here verbatim.

```
Triages distribution centre incidents at Harbourline Group. Use this skill to
triage a DC incident, raise a distribution centre incident, log a conveyor
stoppage, report an induction lane jam, classify a sortation fault, assess a
pick face outage, escalate a DC-7 incident, open a Truganina incident record,
work out incident severity, decide if an incident is a Sev1, check the
incident escalation path, find who is on call for the distribution centre,
work out whether a stoppage breaches the service credit threshold, calculate
throughput loss from a stoppage, determine if an incident needs a Kestrelworks
callout, check spare part lead times for a drive unit, work out whether an
incident blocks the RTF gate, prepare an incident summary for the steering
committee, decide if an incident is reportable to work health and safety, or
draft an incident notification for site operations.
```

## Skill instructions

```
Return a triage record with exactly these fields, in this order:

SEVERITY: Sev1, Sev2 or Sev3
SITE: the distribution centre named in the request, or DC-7 Truganina if none
      is named
THROUGHPUT IMPACT: cartons per hour lost, or "unknown"
SERVICE CREDIT: "triggered" if sustained throughput would fall below 85% of
      the 1,450 carton per hour design target, otherwise "not triggered"
CALLOUT: "Kestrelworks callout required" or "internal maintenance"
RTF GATE: "blocks RTF" or "does not block RTF"
NEXT ACTION: one sentence

Always emit every field, even when the value is "unknown". Begin the response
with the line "DC INCIDENT TRIAGE".
```

The literal opening line `DC INCIDENT TRIAGE` is what makes this evaluable:
whether the skill fired is a substring check on the answer rather than a
judgement call.
