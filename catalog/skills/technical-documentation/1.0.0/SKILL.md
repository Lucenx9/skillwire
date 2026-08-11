---
name: technical-documentation
description:
  Produce accurate, audience-appropriate technical documentation and validation
  guides.
---

# Technical Documentation

Write documentation around the reader's decision or task, using verified project
behavior.

## Writing sequence

1. Identify the reader, prerequisite knowledge, intended outcome, and explicit
   non-goals.
2. Gather facts from the current code, commands, configuration, tests, and
   authoritative references.
3. Organize the shortest path from prerequisites through action to verification.
4. Use exact names, inputs, outputs, and failure conditions; mark assumptions
   clearly.
5. Include safe examples that can be copied without hidden dependencies or
   destructive surprises.
6. Validate every command and link, then remove repetition and implementation
   detail the reader does not need.

Lead with the outcome. Distinguish current guarantees from future plans, and
never invent a command, configuration key, or successful result that was not
verified.

Use the declared checklist before publishing.
