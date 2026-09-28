This project uses the ops profile (Kubernetes): manifests are the desired state.
- Manifests are validated offline: `harness verify` runs `kubeconform`, never a live cluster.
- Change a live cluster only through the `rollout` skill, one change at a time, and
  only after the user's approval of that change. Live changes are never part of `harness run`.
- Before a change, tell the user the kubectl context and the namespace it will run in.
- Present the rollback command (previous image tag or revision) before applying.
