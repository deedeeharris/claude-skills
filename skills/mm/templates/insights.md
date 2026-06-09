# Insights — <TASK>

Living capture of three kinds of knowledge that emerge during this task. The PM writes here as work progresses (see Section 4.8). At the wrap-up Status row, the PM presents an inline summary in chat and the user picks which entries to promote to durable Claude memory (Sections 4.9-4.10).

Entries are H3 with the actual content as the heading. No opaque IDs. Body has exactly three terse fields: `Confidence`, `Why future-PM cares`, `Promote-to`. No timestamps, no source-file pointers — citations belong in research notes.

---

## User preferences

(Add H3 entries here as user signals arrive. Example structure:)

<!--
### <preference stated by this task's user>

- Confidence: high
- Why future-PM cares: <why this preference affects future PM behavior>
- Promote-to: feedback
-->

---

## Codebase

(Add H3 entries here as codebase gotchas surface. The unifying test: would a future task plausibly make a mistake without knowing this? Example:)

<!--
### severity=ERROR on asset_check blocks downstream materialization

- Confidence: staged
- Why future-PM cares: downgrading to WARNING re-introduces broken state silently
- Promote-to: project
-->

---

## Mistakes

(Add H3 entries here for mistakes anyone in the loop made — Claude, engineering agents, the user, external stakeholders. Capture what happened, how it was caught, what to do differently. Example:)

<!--
### Claimed "ROOT CAUSE CONFIRMED" without citation

- Confidence: high
- Why future-PM cares: investigation rigor demands FINDING / HYPOTHESIS / INTERPRETATION labels with citations; uncited claims later proved wrong cost trust
- Promote-to: feedback
-->
