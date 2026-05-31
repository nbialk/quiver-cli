# AGENTS.md

Operational guide for coding agents working in this repository.

## Scope and Priority

- Follow this file for repo-specific defaults.
- Respect direct user instructions first.
- Reuse existing patterns before introducing new ones.

## Stack Snapshot

- Next.js 16 App Router, React 19, React Compiler enabled.
- TypeScript strict mode, tRPC 11, React Query.
- Prisma 7 + PostgreSQL 16.
- Tailwind CSS v4 + shadcn/ui.
- AI SDK 6, Clerk auth.
- Package manager: `pnpm@8`.

## Commands

### Install and local dev

- `pnpm install` - install dependencies.
- `pnpm dev` - generate Prisma client and run Next dev server.
- `pnpm start` - run built app.
- `pnpm db` - start local PostgreSQL via Docker.
- `pnpm db:sync` - sync database via `scripts/sync-db.sh`.
- `pnpm studio` - open Prisma Studio.

### Build, lint, formatting, typecheck, test

- `pnpm build` - production build.
- `pnpm lint` - ESLint with `--max-warnings 0` (`eslint.config.mjs`).
- `pnpm format` - Prettier write mode.
- `pnpm format:check` - Prettier check mode.
- `pnpm tsc --noEmit` - explicit typecheck (CI uses this).
- `npx prisma generate` - regenerate Prisma client.
- `pnpm test` - run Vitest unit tests.
- `pnpm test:watch` - run Vitest in watch mode.

### Project scripts

- `pnpm import` - run health data import.
- `pnpm track:start` / `pnpm track:stop` - dev-time tracker.
- `pnpm backfill:notion` - backfill Notion habits.

### Agent scripts

- `pnpm agents:sync` - regenerate all provider shims from `.agents/`.
- `pnpm agents:check` - verify shims are up to date (for CI).

## Verification Matrix

Minimum checks per change scope:

| Change scope                              | Minimum verification                                              |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `src/app/**` (UI only)                    | `pnpm lint` + `pnpm tsc --noEmit`                                 |
| `src/server/routers/**`                   | `pnpm lint` + `pnpm tsc --noEmit` + `pnpm test` (affected domain) |
| `src/server/repositories/**`              | `pnpm lint` + `pnpm tsc --noEmit` + `pnpm test` (affected domain) |
| `src/lib/**` (utilities)                  | `pnpm lint` + `pnpm tsc --noEmit`                                 |
| `src/app/api/**` (API routes)             | `pnpm lint` + `pnpm tsc --noEmit` + manual API test               |
| `prisma/schema.prisma`                    | `pnpm lint` + `prisma generate` + `pnpm build`                    |
| `prisma/migrations/**`                    | `prisma generate` + `prisma migrate deploy` against dev DB        |
| Cross-cutting (`routers` + `lib` + `api`) | `pnpm lint` + `pnpm tsc --noEmit` + `pnpm build`                  |
| `eslint.config.mjs` / CI config           | `pnpm lint` + verify CI pipeline runs correctly                   |

## CI Expectations

GitHub Actions runs four jobs on PRs to `main`:

- **Lint**: `pnpm lint` (ESLint with `--max-warnings 0`).
- **Format**: Diff-based Prettier check (only changed files).
- **Typecheck**: `prisma generate` + `pnpm tsc --noEmit`.
- **Build**: `prisma generate` + `pnpm build`.
- **Test**: `prisma generate` + `pnpm test`.

Always aim to keep local changes compatible with these checks.

## Repository Structure

```
src/
├── app/
│   ├── page.tsx                # Home (redirects based on auth)
│   ├── main/page.tsx           # Main chat interface
│   ├── main/idea/              # Idea preview pages
│   ├── api/chat/               # Chat streaming endpoint
│   │   └── personas/           # AI persona definitions
│   ├── api/trpc/               # tRPC handler
│   └── sign-in, sign-up/       # Clerk auth pages
├── server/
│   ├── trpc.ts                 # tRPC context & procedures
│   ├── routers/                # One router per domain (_app.ts aggregates)
│   └── repositories/           # Shared DB query functions (one per domain)
├── lib/
│   ├── health/                 # Health domain (workout-utils, sleep-score, import)
│   ├── groceries/              # Groceries domain (categories, group-items)
│   ├── services/               # External API clients (Notion, Google Calendar, Telegram, Weather)
│   ├── trpc/                   # tRPC client & server setup
│   ├── utils.ts                # shadcn/ui utility (cn) — do not move
│   └── utils/                  # Shared utility modules (*.utils.ts)
├── components/
│   ├── ui/                     # shadcn/ui base components
│   ├── ai-elements/            # Chat UI (streamdown, tool renderers)
│   ├── health/                 # Health feature components
│   │   ├── sleep/              # Sleep cards + sleep-score-ring
│   │   └── workout/            # Workout cards, list, weekly summary
│   ├── groceries/              # Receipt cards, groceries page
│   ├── calendar/               # Calendar events card
│   ├── books/                  # Book + author cards, book list
│   ├── idea/                   # Idea page components
│   ├── icons/                  # Custom icon components
│   └── layout/                 # Layout components
├── providers/                  # Clerk, theme, tRPC providers (barrel: index.tsx)
├── hooks/                      # Custom hooks (use-*.ts)
└── types/                      # Shared type definitions
scripts/
├── agents/                     # Agent sync tooling
└── import-health.ts            # Health data import
```

## Naming and File Conventions

- Use kebab-case file names everywhere.
- Component files commonly use suffixes:
  - `-card` for display cards.
  - `-list` for list renderers.
  - `-page` for page-level components.
- Hooks: `use-<name>.ts`.
- Utilities: `<topic>.utils.ts` in `src/lib/utils/`.
- Routers: one domain per file in `src/server/routers/`.
- Component/type/function names in code:
  - Components and types: PascalCase.
  - Functions/procedures: camelCase.
  - Constants/maps: UPPER_SNAKE_CASE.

## Imports and Module Rules

- Use `@/` path alias imports, not long relative paths.
- Do not add barrel files in components/lib folders.
- Keep existing direct-import style.
- Import order is enforced by Prettier plugin:
  - React/Next.
  - Third-party.
  - Internal alias groups.
  - Relative imports.

## Formatting Rules

- Prettier is the source of truth.
- 2-space indentation, semicolons enabled.
- JSX single quotes enabled.
- Tailwind classes are auto-sorted.
- Run `pnpm format` after non-trivial edits.

## TypeScript Rules

- TypeScript strict mode is enabled (`strict: true`).
- Prefer explicit domain types from `src/types/` when shared.
- Keep component-local prop types inline or as `<ComponentName>Props`.
- Use Prisma types from `@prisma/client` for query typing.
- Avoid `any`; prefer `unknown` + narrowing.

## API and Error Handling Patterns

- Validate tRPC inputs with Zod.
- Use `publicProcedure` vs `protectedProcedure` intentionally.
- Throw `TRPCError` for API-layer failures.
- Preserve useful error messages when safe.
- For external API failures, map to stable user-facing errors.
- Log warnings/errors with concise context tags (example: `[weather]`).

## AI Personas

- **Default** — General conversation.
- **Fitness Coach** — Workout analysis and health data.
- **Sleep Coach** — Sleep analysis and recommendations.
- **Morning Briefing** — Daily summary (workouts, sleep, metrics).
- **Books** — Book and author information.
- **Calendar** — Google Calendar + Notion tasks.

Each persona in its own file under `src/app/api/chat/personas/`. User-dependent
personas use factory functions (`createFitnessCoach(userId)`), static personas
exported directly. `buildPersona()` in `index.ts` aggregates all personas.

## Database Models

- **Workout** — Running/exercise data with splits.
- **SleepRecord** — Sleep phases (deep, rem, core, awake).
- **HealthMetric** — Generic health metrics (HRV, resting HR, etc.).
- **Receipt** — Grocery receipts with items.
- **HealthWebhookLog** — Health data webhook logs.

## UI and UX Conventions

- Prefer shadcn/ui components from `src/components/ui/`.
- Reuse existing domain UI patterns before creating new variants.
- Keep German locale behavior consistent:
  - day.js with `dayjs/locale/de`.
  - Number/currency formatting with `de-DE`.
  - In German UI copy, always use proper umlauts and never ASCII transliterations.

## Data and Utility Conventions

- Put reusable business logic in `src/lib/<domain>/`.
- Put cross-domain helpers in `src/lib/utils/`.
- Keep `src/lib/utils.ts` reserved for `cn` helper.
- Extend existing utils before adding new utility files.

## Environment Variables

```
DATABASE_URL, SHADOW_DATABASE_URL
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY
NEXT_PUBLIC_CLERK_SIGN_IN_URL, NEXT_PUBLIC_CLERK_SIGN_UP_URL
NEXT_PUBLIC_BASE_URL
```

## Agent Workflow Recommendations

- Before editing, inspect nearby files for local patterns.
- Make focused changes; avoid unrelated refactors.
- Verify with the smallest meaningful command first.
- For broad changes, run: lint -> typecheck -> build.
- Do not commit/push/create PR unless explicitly requested.

## Shared Agent Setup

All agent configuration lives in `.agents/` (single source of truth).
Provider-specific files (`.claude/`, `.opencode/`, `.mcp.json`, `tui.json`)
are generated by `pnpm agents:sync`. See `.agents/README.md` for details.
