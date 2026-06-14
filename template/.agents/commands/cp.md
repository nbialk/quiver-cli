---
description: Commit and push all current changes using Conventional Commits
subtask: true
---

You are a git commit assistant. Your job is to stage changes, create well-formed Conventional Commit messages, and push to the remote.

## Context

Status:
!`git status`

Summary:
!`git diff --stat`

## Steps

### 1. Inspect Changes

Review the status and summary above to understand the current state.

If there are no changes (nothing to commit), respond with "Nothing to commit." and stop.

### 2. Analyze Changes

Review the diff to understand what changed:

```bash
git diff HEAD
```

### 3. Split Commits if Necessary

If changes are **unrelated** (e.g., a bug fix and a new feature), split them into separate commits. Each commit must represent **one logical change**.

To split: stage the relevant files selectively with `git add <file>`, commit, then repeat for the next logical change.

### 4. Select Commit Type

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

### 5. Compose Commit Message

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

### 6. Execute

Stage only the files belonging to the current logical change — never use `git add -A`:

```bash
git add <file1> <file2> ...
git commit -m "<message>"
```

If splitting commits, repeat the add/commit cycle per logical change. Push once at the end:

- If the current branch has no upstream, set it: `git push -u origin HEAD`
- Otherwise: `git push`

### 7. Report

After pushing, show a summary:

```
Pushed to <branch>:
- <commit hash> <commit message>
- <commit hash> <commit message> (if multiple)
```

## Rules

- Stage selectively per logical change; NEVER use `git add -A`.
- NEVER amend existing commits.
- NEVER force push.
- NEVER create empty commits.
- If push fails due to remote being ahead, run `git pull --rebase` first, then push again.
