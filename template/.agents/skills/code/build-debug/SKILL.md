---
name: build-debug
description: 
  Debug failed builds and CI runs. Fetches logs from Cloud Build or GitHub
  Actions, identifies the error, and suggests a fix. Trigger: "build failed"
  "CI failed", "debug the build", "deploy failed", "Cloud Build error"
  "GitHub Actions failed", "why did the build fail", "check the build"
  "what broke", /build-debug.
---

# /build-debug — Debug Failed Builds

Fetch the latest failure from Cloud Build and/or GitHub Actions, identify the root cause, and suggest a concrete fix.

## Step 1: Determine Which System to Check

Based on the user's message:

- **Cloud Build only**: user mentions "cloud build", "deploy", "production", "Cloud Run"
- **GitHub Actions only**: user mentions "CI", "github actions", "lint", "PR checks", "workflow"
- **Both**: no specific mention, or user says "build" generically

## Step 2: Cloud Build

### 2a: Find the latest failed build

```bash
gcloud builds list --project=nb-webentwicklung --filter="status=FAILURE" --limit=1 --format="value(id,createTime,status)"
```

If no failures found, report that Cloud Build is green and skip to Step 3.

### 2b: Fetch logs

```bash
gcloud builds log <BUILD_ID> --project=nb-webentwicklung
```

### 2c: Analyze

Look for these project-specific failure patterns:

| Pattern                                | Likely cause                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| `prisma generate` / `prisma` not found | Prisma CLI missing in Docker image or `prisma generate` not in build step            |
| `Type error` / `tsc` errors            | TypeScript build failure — read the referenced file and fix                          |
| `ERR_PNPM_FROZEN_LOCKFILE`             | `pnpm-lock.yaml` out of sync — run `pnpm install` locally and commit lockfile        |
| `COPY failed` / `file not found`       | Dockerfile COPY referencing missing file — check paths                               |
| `OOMKilled` / `signal: killed`         | Kaniko or build step ran out of memory — increase `machineType` in `cloudbuild.yaml` |
| `Cloud Run deployment failed`          | Check service logs, often port mismatch or missing env vars                          |
| `ECONNREFUSED` / `connect ETIMEDOUT`   | Network issue during build (npm registry, database)                                  |

## Step 3: GitHub Actions

### 3a: Find the latest failed run

```bash
gh run list --status=failure --limit=1 --json databaseId,headBranch,name,conclusion,event,createdAt
```

If no failures found, report that GitHub Actions is green.

### 3b: Fetch failed job logs

```bash
gh run view <RUN_ID> --log-failed
```

### 3c: Analyze

Look for these CI-specific failure patterns:

| Pattern                                      | Likely cause                                                  |
| -------------------------------------------- | ------------------------------------------------------------- |
| `ESLint` / `Parsing error` / lint rule name  | Lint failure — read the file, fix the violation               |
| `Prettier` / `--check` / `Code style issues` | Formatting — run `pnpm format` locally and commit             |
| `Type error` / `TS2xxx`                      | TypeScript error — read the referenced file and fix           |
| `prisma generate` / `schema out of sync`     | Prisma client outdated — run `npx prisma generate` and commit |
| `ERR_PNPM_FROZEN_LOCKFILE`                   | Lockfile mismatch — run `pnpm install` and commit lockfile    |
| `ENOENT` / module not found                  | Missing dependency or incorrect import path                   |

## Step 4: Report

Present findings in this format:

1. **System**: which system failed (Cloud Build / GitHub Actions / both)
2. **When**: timestamp of the failure
3. **Branch**: which branch (if GitHub Actions)
4. **Error**: the relevant error lines from the logs (quote them)
5. **Root cause**: one-sentence explanation
6. **Fix**: concrete steps or code changes to resolve the issue

If the fix involves code changes, offer to apply them. If it requires re-running the build, tell the user the command (`gcloud builds submit` or `gh run rerun`).
