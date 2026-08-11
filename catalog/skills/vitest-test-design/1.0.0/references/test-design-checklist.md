# Vitest test design checklist

- Every test names an observable behavior or regression.
- The chosen test layer owns the boundary being asserted.
- Fixtures are independent of the implementation under test.
- Success, boundary, and failure paths are represented.
- Repeated cases use one parameterized matrix.
- Time, randomness, network, and filesystem state are controlled.
- Assertions avoid private implementation details.
- Servers, files, timers, and clients are always cleaned up.
