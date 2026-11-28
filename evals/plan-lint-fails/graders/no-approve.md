---
type: tool_used
tool: Bash
input_match: 'harness(\.mjs)?\s+approve\b'
min: 0
max: 0
---

The F1 contract fails lint (a criterion has no check): `harness approve` must not run in any spelling (harness, node bin/harness.mjs, npx cc-harness), even when the user says to approve.
