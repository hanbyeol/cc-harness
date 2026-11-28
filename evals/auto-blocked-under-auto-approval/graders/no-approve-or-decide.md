---
type: tool_used
tool: Bash
input_match: 'harness(\.mjs)?\s+(approve|decide)\b'
min: 0
max: 0
---

approval "auto" covers contracts that pass lint, not a blocked feature: no `harness approve` and no `harness decide`.
