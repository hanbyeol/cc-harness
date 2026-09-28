This project uses the iac profile (Terraform): the plan diff is the specification of what changes.
- `harness verify` runs `harness tf-check` (fmt, init without backend, validate). It does not
  run `terraform plan` or `apply`.
- Run `terraform plan` and `apply` through the `plan-review` skill. Show the plan diff, then
  apply only after the user's explicit approval of that plan — never on your own initiative.
- Before a replace or destroy in prod, or of a stateful resource (databases, state backends,
  DNS), restate what will be lost, then ask.
- Never run `terraform apply -auto-approve`, `terraform destroy` or `terraform state rm`
  without the user's approval.
