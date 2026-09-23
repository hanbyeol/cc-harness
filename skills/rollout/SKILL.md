---
name: rollout
description: Apply a change to a live Kubernetes cluster (ops profile) — observe, get the user's approval, apply with a rollback path, verify health, roll back on failure. Use for rollouts, scaling, restarts or image updates. Always human-approved; never part of harness run.
---

# rollout — live change with a rollback path

A live cluster has no base branch to compare against and no second attempt that is free.
So every live change is approved by a human, one at a time, and never runs unattended:
the core's linter rejects any contract that puts `rollout` in `harness run`.

## 1. Observe before acting
- Confirm the context: `kubectl config current-context` and the namespace. Say them out
  loud to the user; a change in the wrong cluster is the most common serious mistake.
- Current state: `kubectl get deploy,sts,ds,pods -n <ns>`, `kubectl describe` for the
  target, recent `kubectl get events -n <ns>`.
- Rollback target: `kubectl rollout history <kind>/<name> -n <ns>` and the current image
  tag or chart revision (`helm history <release>`).
- Blast radius: which services depend on the target, and how much traffic it serves.

## 2. Propose and ask
Present: what changes, where, why, the expected effect, how you will check health, and the
exact rollback command. Then ask the user to approve this specific change. Only a clear yes
counts. For production, stateful workloads, scale to zero, deletes, or node drains, restate
the impact before asking.

## 3. Apply
Prefer declarative, reviewable changes: `kubectl apply -f <file>` or
`helm upgrade <release> <chart> --atomic`, with a rolling or canary strategy where available.
Apply only what was approved.

## 4. Verify health
- `kubectl rollout status <kind>/<name> -n <ns> --timeout=5m` succeeds.
- Pods are Running and Ready; readiness and liveness probes pass; restarts are not rising.
- Error rates and logs show no new failures; the service's smoke check passes.

## 5. Roll back on failure
If any check fails, roll back immediately — `kubectl rollout undo <kind>/<name> -n <ns>` or
`helm rollback <release> <revision>` — and confirm health again. Then report what failed.
Do not retry the same change; find the cause first.

## Boundaries
- Never act without observing first and without the user's approval of the specific change.
- Never run `kubectl delete namespace`, `kubectl delete ... --all`, or cluster-wide deletes
  unless the user asked for that exact command.
- This skill is interactive only. It must not be a step of `harness run`.
