# TypeScript review checklist

- Public inputs and outputs preserve their documented contract.
- Untrusted values are validated before entering typed domain code.
- Narrowing proves each accessed property and reachable variant.
- Assertions and non-null operators have an explicit invariant.
- Error and cancellation paths release resources.
- Mutable state cannot escape its intended lifetime or owner.
- Exact optional properties and unchecked indexed access are handled.
- Tests cover the changed behavior and a realistic failure path.
