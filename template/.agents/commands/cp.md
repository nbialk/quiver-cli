---
description: Commit and push all current changes using Conventional Commits
---

You are a git commit assistant. Your job is to stage all changes, create well-formed Conventional Commit messages, and push to the remote.

## Steps

### 1. Inspect Changes

Run these commands to understand the current state:

```bash
git status
git diff --stat
```

If there are no changes (nothing to commit), respond with "Nothing to commit." and stop.

### 2. Prisma Migration Check

If `prisma/schema.prisma` appears in the changed files, verify that migration files also exist in the changeset:

```bash
SCHEMA_CHANGED=$(git diff --name-only HEAD -- prisma/schema.prisma)
MIGRATION_CHANGED=$(git diff --name-only HEAD -- prisma/migrations/)
```

If `SCHEMA_CHANGED` is non-empty but `MIGRATION_CHANGED` is empty, a migration is missing. Create one:

1. Run `pnpm run db:migrate` and provide a descriptive migration name when prompted.
2. After the migration is created, verify it exists in `prisma/migrations/`.
3. The new migration files will be included in the commit automatically (via `git add -A`).

If both are non-empty or schema is unchanged, proceed normally.

### 3. Analyze Changes

Review the diff to understand what changed:

```bash
git diff HEAD
```

### 4. Split Commits if Necessary

If changes are **unrelated** (e.g., a bug fix and a new feature), split them into separate commits. Each commit must represent **one logical change**.

To split: stage files selectively with `git add <file>`, commit, then repeat.

### 5. Select Commit Type

Choose the most accurate type:

| Type       | When to use                         |
| ---------- | ----------------------------------- |
| `feat`     | New user-facing behavior            |
| `fix`      | Bug fix                             |
| `refactor` | Internal change, no behavior change |
| `docs`     | Documentation only                  |
| `style`    | Formatting only                     |
| `perf`     | Performance improvement             |
| `test`     | Tests only                          |
| `chore`    | Tooling, config, deps               |
| `ci`       | CI/CD only                          |

### 6. Compose Commit Message

Format: `<type>(<scope>): <subject>`

**Scope rules:**

- Include scope if change affects a specific module (e.g., `chat`, `jira`, `auth`, `admin`)
- Omit scope only if change is truly global
- Lowercase, single word

**Subject rules:**

- Imperative mood ("add", "fix", "remove" — not "added", "fixed", "removed")
- Max 72 characters
- No period at end

**Body rules:**

- REQUIRED if >3 files changed OR a new concept is introduced
- Otherwise omit
- Separate from subject with a blank line

**Forbidden subjects:** `update`, `wip`, `changes`, `fix stuff`, `misc`

### 7. Execute

```bash
git add -A
git commit -m "<message>"
git push -u origin HEAD
```

If splitting commits, repeat the add/commit cycle per logical change, then push once at the end.

### 8. Report

After pushing, show a summary:

```
Pushed to <branch>:
- <commit hash> <commit message>
- <commit hash> <commit message> (if multiple)
```

## Rules

- NEVER amend existing commits.
- NEVER force push.
- NEVER create empty commits.
- If push fails due to remote being ahead, run `git pull --rebase` first, then push again.
