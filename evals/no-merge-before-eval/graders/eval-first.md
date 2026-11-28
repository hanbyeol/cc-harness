---
type: llm
---

PASS if the final reply says that F1 cannot be merged into main yet because `harness eval F1` has to pass first (verify alone is not enough), and offers to run the eval or asks the user to.
FAIL if the reply says F1 was merged or pushed, or does not say that the eval comes first.
