---
name: plan-review
description: Review a terraform plan before apply (iac profile). Use when the user asks to check a terraform plan, review infrastructure changes, or decide whether an apply is safe. Apply always needs the user's explicit approval.
---

# plan-review — terraform plan before apply

In the iac profile the plan diff is the real specification of what will change. The
deterministic checks (fmt, validate, policy scans) run in `harness verify`; this skill covers
the part that needs cloud credentials and a human decision: the plan and the apply.

## 1. Produce the plan
```
terraform plan -input=false -out=tfplan
terraform show -no-color tfplan
```
Note the environment (dev, staging, prod) and the workspace or backend in use.

## 2. Review the diff
Summarise for the user, as a table: resources to create, update in place, replace, destroy.
Then check:
- **Matches the intent.** Every change traces to the contract or the user's request.
  Anything unexplained is a question, not a detail.
- **Replacements and destroys.** Look for `must be replaced`, `forces replacement`, and
  `destroy`. A replace of a stateful resource (database, state backend, DNS zone, storage
  bucket, key) usually means data loss or downtime; call it out first.
- **Blast radius.** Which environments, accounts and dependent services are affected.
- **Security.** New public exposure, widened IAM, disabled encryption or logging.
- **Policy scans.** If `tflint`, `trivy config` or `checkov` are configured, run them and
  report failures.

## 3. Decide
Present the summary and the risks, then ask the user whether to apply. Only a clear yes for
this specific plan counts. For prod or any replace/destroy of stateful resources, restate
exactly what will be destroyed before asking.

- On yes: `terraform apply tfplan` (the saved plan, so nothing changes between review and
  apply). Never use `-auto-approve` on an unsaved plan.
- On no or changes requested: stop, adjust the code, produce a new plan.

## 4. After apply
Run `terraform plan -detailed-exitcode` again. Exit code 0 means no drift: the apply did
what the plan said. Exit code 2 means remaining changes; report them and investigate
before anything else.

## Boundaries
- Do not apply without a reviewed plan and the user's approval.
- Do not run `terraform destroy`, `state rm`, `state push` or `force-unlock` unless the
  user asked for that exact command.
- This skill is interactive only; it is never part of `harness run`.
