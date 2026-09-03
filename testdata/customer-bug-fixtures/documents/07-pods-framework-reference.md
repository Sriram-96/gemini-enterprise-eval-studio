# PODS Framework Reference — Meeting Actions Agent

**Google Doc title:** `PODS Framework Reference`

**Classification:** Internal — knowledge base document **and** agent system
instruction source.

> This fixture drives bug #4. The customer's agent explained the "S" in PODS
> as *"specific actions"* inside its thinking trace, which is not what the
> acronym means in their organisation. The root cause was recorded as the
> model falling back on a generic public definition instead of adhering to the
> organisation-specific acronym instruction in the agent configuration.
>
> To reproduce that faithfully you must do **both** of the following:
>
> 1. Index this document in the agent's data store, and
> 2. Paste the block under [Agent system instruction](#agent-system-instruction)
>    into the agent's system instruction / prompt configuration.
>
> Step 2 is the one that matters. The bug is instruction adherence, so an
> evaluation run against an agent that was never given the instruction proves
> nothing.

## The PODS framework

Every meeting summary produced for Harbourline Group is structured as PODS:

| Letter | Means | Definition |
| --- | --- | --- |
| **P** | **Purpose** | Why the meeting was called, in one sentence. |
| **O** | **Outcomes** | What changed as a result of the meeting. |
| **D** | **Decisions** | Each decision recorded, with its reference. |
| **S** | **Sponsors** | The named executive accountable for carrying each decision forward. |

### What S is not

**S is Sponsors.** It is not "specific actions", not "steps", not "summary",
not "stakeholders" and not "status". Action items are captured separately from
PODS and are never folded into the S section.

A PODS summary that lists tasks under S is wrong even if the tasks themselves
are correct.

## Related vocabulary

- **RTF** — Ready to Fulfil. The first automation go-live gate. Not "ready to
  finish", not "return to floor".
- **CODB** — Cost of doing business, expressed as a percentage of sales.
- **The envelope** — the $96,000,000 three-year supply chain transformation
  investment envelope, never an individual project budget.

## Agent system instruction

```
When producing a PODS summary, PODS means Purpose, Outcomes, Decisions and
Sponsors.

S stands for Sponsors: the named executive accountable for carrying each
decision forward. S never means specific actions, steps, summary,
stakeholders or status. Action items are listed separately from the PODS
structure and must never appear under S.

RTF means Ready to Fulfil. CODB means cost of doing business. "The envelope"
means the $96,000,000 three-year supply chain transformation investment
envelope.
```
