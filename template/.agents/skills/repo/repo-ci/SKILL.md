---
name: repo-ci
description: Create a GitHub repo (if needed) and set up Dependabot, CI workflow, auto-merge workflow, and GitHub branch ruleset.
disable-model-invocation: true
allowed-tools: Read, Write, Bash(gh *), Bash(cat *)
---

# /repo-ci — CI/CD and Dependabot Setup

Create a GitHub repo (if needed) and set up GitHub CI, Dependabot, auto-merge, and branch protection.

## Step 1: Create GitHub Repo (if needed)

1. Run `gh repo view --json nameWithOwner 2>/dev/null` to check if a remote repo already exists.
2. If no remote repo exists, create one:
   - Derive the repo name from the current directory name.
   - Run `gh repo create <name> --private --source=. --push` to create a private repo and push the current code.
3. If the repo already exists, skip this step.

## Step 2: Gather Context

1. Read `package.json` to confirm package manager and dependencies.
2. Run `gh repo view --json nameWithOwner` to get the repo identifier.
3. The GitHub reviewer username for Dependabot PRs is always `Snickers03`.

## Step 3: Create `.github/dependabot.yml`

Replace `{{REVIEWER}}` with the username from step 1.

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
      time: "06:00"
      timezone: "Europe/Berlin"

    open-pull-requests-limit: 10
    target-branch: "main"
    versioning-strategy: "increase"

    reviewers:
      - "{{REVIEWER}}"

    labels:
      - "dependencies"

    commit-message:
      prefix: "deps"

    groups:
      devtools:
        dependency-type: "development"
        patterns:
          - "eslint*"
          - "@eslint/*"
          - "prettier*"
          - "@ianvs/*"
          - "typescript"
          - "typescript-eslint"
          - "tsx"
          - "globals"
        update-types: ["patch", "minor"]

      majors:
        patterns:
          - "*"
        update-types: ["major"]

    ignore:
      - dependency-name: "node"
        update-types: ["version-update:semver-major"]
      - dependency-name: "@types/node"
        update-types: ["version-update:semver-major"]
```

## Step 4: Create `.github/workflows/ci.yml`

Replace `{{NODE_VERSION}}` with the Node.js version from `package.json` engines or default `20`.

```yaml
name: CI

on:
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    name: lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: corepack enable
      - uses: actions/setup-node@v4
        with:
          node-version: { { NODE_VERSION } }
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format --check

  build:
    name: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: corepack enable
      - uses: actions/setup-node@v4
        with:
          node-version: { { NODE_VERSION } }
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
```

## Step 5: Create `.github/workflows/dependabot-auto-merge.yml`

```yaml
name: Dependabot Auto-Merge

on:
  pull_request:

permissions:
  contents: write
  pull-requests: write

jobs:
  auto-merge:
    runs-on: ubuntu-latest
    if: github.actor == 'dependabot[bot]'
    steps:
      - name: Fetch Dependabot metadata
        id: metadata
        uses: dependabot/fetch-metadata@v2
        with:
          github-token: "${{ secrets.GITHUB_TOKEN }}"

      - name: Auto-merge patch and minor updates
        if: steps.metadata.outputs.update-type != 'version-update:semver-major'
        run: gh pr merge --auto --squash "$PR_URL"
        env:
          PR_URL: ${{ github.event.pull_request.html_url }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Step 6: Create GitHub Rulesets

Replace `{{REPO}}` with the `nameWithOwner` value from Step 1. Create both rulesets.

### 6a: `prevent-main-direct-push` ruleset (default branch)

```bash
gh api repos/{{REPO}}/rulesets --method POST --input - <<'EOF'
{
  "name": "prevent-main-direct-push",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [
    {
      "actor_id": 5,
      "actor_type": "RepositoryRole",
      "bypass_mode": "always"
    }
  ],
  "conditions": {
    "ref_name": {
      "include": ["~DEFAULT_BRANCH"],
      "exclude": []
    }
  },
  "rules": [
    {
      "type": "deletion"
    },
    {
      "type": "required_linear_history"
    },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["squash", "rebase"]
      }
    },
    {
      "type": "non_fast_forward"
    }
  ]
}
EOF
```

### 6b: `main-protection` ruleset (required status checks)

```bash
gh api repos/{{REPO}}/rulesets --method POST --input - <<'EOF'
{
  "name": "main-protection",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [
    {
      "actor_id": 5,
      "actor_type": "RepositoryRole",
      "bypass_mode": "always"
    }
  ],
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/main"],
      "exclude": []
    }
  },
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "lint" },
          { "context": "build" }
        ]
      }
    }
  ]
}
EOF
```

## Step 7: Enable Repo Settings

```bash
gh repo edit --delete-branch-on-merge
gh api repos/{{REPO}}/actions/permissions/workflow --method PUT --input - <<'EOF'
{
  "default_workflow_permissions": "read",
  "can_approve_pull_request_reviews": true
}
EOF
```

## Step 8: Confirm

Tell the user what was created:

- `.github/dependabot.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/dependabot-auto-merge.yml`
- Ruleset `prevent-main-direct-push` on default branch (deletion, linear history, PR required, no force push)
- Ruleset `main-protection` on main requiring `lint` and `build` checks
- Auto-delete branches on merge enabled
- GitHub Actions permitted to create and approve pull requests
