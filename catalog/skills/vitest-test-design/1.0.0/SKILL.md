---
name: vitest-test-design
description:
  Design focused Vitest unit, contract, integration, and failure-path coverage.
---

# Vitest Test Design

Place each behavior at the lowest test layer that can prove it without mocking
away the boundary.

## Design sequence

1. State the observable behavior and the regression the test must catch.
2. Choose unit tests for pure decisions, contract tests for schemas and
   adapters, and end-to-end tests for complete journeys.
3. Arrange fixtures independently from implementation output.
4. Exercise success, meaningful boundaries, and one realistic failure path
   without duplicating matrices.
5. Make time, randomness, filesystem state, and network responses deterministic.
6. Assert externally meaningful results rather than private call order or
   incidental formatting.

Keep tests small enough that a failure names one broken contract. Reuse
parameterized fixtures for repeated adversarial cases, and clean up every
resource created by a test.

Use the declared checklist when reviewing a suite.
