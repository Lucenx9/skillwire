---
name: react-accessibility
description:
  Review React interfaces for accessible structure, semantics, input, focus, and
  feedback.
---

# React Accessibility Review

Evaluate the rendered experience, not component names or visual appearance
alone.

## Review sequence

1. Establish the interaction's purpose, reading order, and expected keyboard
   flow.
2. Prefer native elements and semantics before adding ARIA roles or properties.
3. Verify every control has an accessible name, state, and programmatic
   relationship to help or error text.
4. Check keyboard operation, visible focus, focus restoration, and modal focus
   containment.
5. Confirm dynamic updates are perceivable without producing noisy
   announcements.
6. Review loading, empty, validation, error, and disabled states at realistic
   zoom and contrast settings.

Report barriers with the affected user action, the rendered semantic problem,
and a concrete fix. Avoid claiming conformance from static markup alone when
behavior requires browser or assistive-technology testing.

Use the declared checklist to keep the review consistent.
