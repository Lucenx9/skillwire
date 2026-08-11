---
name: threat-modeling
description:
  Identify assets, trust boundaries, attacker goals, abuse cases, and
  mitigations.
---

# Threat Modeling

Model plausible abuse of the concrete system rather than producing a generic
threat list.

## Modeling sequence

1. Define the system scope, protected assets, security objectives, and explicit
   exclusions.
2. Map actors, entry points, data flows, storage, and trust-boundary crossings.
3. State attacker capabilities and goals without assuming controls that have not
   been evidenced.
4. Build abuse cases from attacker action through impact, naming required
   preconditions.
5. Identify existing controls, gaps, and detection opportunities for each
   credible path.
6. Prioritize mitigations by impact, likelihood, exploitability, and
   implementation cost.

Keep conclusions evidence-backed and defensive. Separate confirmed design facts
from assumptions and open questions. A mitigation should name the boundary it
changes and how its effectiveness can be tested.

Use the declared template to record the model.
