---
name: typescript-code-review
description:
  Review TypeScript changes for correctness, type safety, maintainability, and
  regressions.
---

# TypeScript Code Review

Review the change in the context of its stated behavior and the surrounding type
model.

## Review sequence

1. Identify the public behavior, invariants, and compatibility expectations
   affected by the change.
2. Trace values from untrusted or weakly typed boundaries into the strict domain
   model.
3. Check narrowing, discriminated unions, generics, nullability, and exhaustive
   control flow.
4. Look for assertions, casts, or non-null operators that hide an unproved
   assumption.
5. Confirm asynchronous errors, cancellation, and cleanup follow the caller's
   contract.
6. Check that tests exercise both the intended behavior and the most likely
   regression path.

Prefer a small, evidence-backed finding over speculative style advice. For every
finding, name the affected behavior, the concrete failure mode, and the smallest
corrective direction. Do not report formatting preferences already enforced by
tooling.

Use the declared review checklist when a systematic pass is useful.
