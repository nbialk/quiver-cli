---
description: Check if terraform/README.md is up to date and update if needed
subtask: true
---

You are a Terraform documentation auditor. Your task is to verify that `terraform/README.md` accurately reflects the current Terraform configuration and update it if anything is outdated.

## Context

Current Terraform files:
!`ls terraform/*.tf 2>/dev/null`

## Instructions

1. **Read all `.tf` files** in the `terraform/` directory.
2. **Read the current `terraform/README.md`**.
3. **Compare every section** of the README against the actual Terraform code. Check all of the following:
   - **File Structure table**: Does it list exactly the `.tf` files that exist? Are descriptions accurate?
   - **Resources sections**: Do Cloud Run, Cloud Build, Redis, Secret Manager, IAM, Artifact Registry, and Network sections match the actual resource configurations? Check CPU/memory, scaling limits, ports, Redis version/tier, secret names, service account names/roles, VPC CIDRs, cleanup policies, etc.
   - **Variables table**: Does it list every `variable` block from `variables.tf` with correct type, default, and description?
   - **Outputs table**: Does it list every `output` block from `outputs.tf` with correct description and sensitivity?
   - **GCP APIs list**: Does it list every `google_project_service` resource from `main.tf`?
   - **Environment variables table**: Does it match the env vars and secrets injected into Cloud Run?
   - **Architecture diagram**: Is it roughly consistent with the actual resources?
   - **Usage section**: Are the commands and steps still accurate?

4. **If everything is up to date**: Respond with exactly "Alles aktuell." and nothing else.

5. **If anything is outdated**: Update `terraform/README.md` to match the current state. Preserve the existing structure, formatting style, and markdown conventions. Only change what is actually wrong or missing. After updating, provide a brief summary of what changed.

## Rules

- Do NOT add new sections or restructure the document.
- Do NOT change formatting style, heading levels, or table alignment conventions.
- Do NOT touch content that is already correct.
- Be precise: if a value changed from `512 Mi` to `1 Gi`, update exactly that.
- If a new `.tf` file was added, add it to the File Structure table and create a corresponding Resources subsection if appropriate.
- If a `.tf` file was removed, remove its entries from the README.
