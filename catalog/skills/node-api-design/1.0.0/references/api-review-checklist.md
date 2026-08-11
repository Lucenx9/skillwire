# Node API review checklist

- Resource and operation names describe one stable behavior.
- Authentication and authorization happen before protected lookup.
- Request and response schemas reject unknown or unbounded input.
- Retry and idempotency behavior is explicit.
- Status and error codes distinguish caller action from transient failure.
- Pagination and concurrency semantics are deterministic.
- Compatibility impact is documented for every contract change.
- Responses and logs exclude secrets and internal implementation detail.
