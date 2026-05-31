---
name: repo-init-next-js
description: >
  Bootstrap a Next.js project with Prisma (PostgreSQL), tRPC, React Query,
  optional Clerk auth, next-themes, sonner, shadcn/ui config, and a clean folder
  structure. Use when the user says "set up this project", "scaffold with
  Prisma and tRPC", "/repo-init-next-js", "add Prisma and tRPC to this Next.js
  app", or wants to initialize a fresh Next.js project with the full stack.
---

# Next.js Project Setup

Bootstrap a Next.js App Router project with the full stack: Prisma + PostgreSQL, tRPC + React Query, optional Clerk auth, next-themes, sonner toasts, Tailwind v4 with shadcn/ui theme, and Prettier.

## Prerequisites

- A Next.js project already created (`pnpm create next-app`)
- pnpm as package manager

## Workflow

### 0. Ask the User

Before creating any files, ask the user for:

1. **Project name** — used in `README.md` title and `package.json` name.
2. **Project description** — used in `CLAUDE.md`, `README.md`, and `package.json`.
3. **Node.js version** — default `24`. Used in `.nvmrc`.
4. **PostgreSQL version** — default `16`. Used in `docker-compose.yml`.
5. **With Clerk auth?** — default: yes. If no, skip all Clerk-related files and packages.
6. If the user chose Clerk, also ask for:
   - **Clerk Publishable Key** (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`) — from https://dashboard.clerk.com
   - **Clerk Secret Key** (`CLERK_SECRET_KEY`) — from https://dashboard.clerk.com

### 1. Create folder structure

Create these directories (skip any that already exist):

```
src/server/routers/
src/lib/trpc/
src/providers/
src/components/ui/
src/app/api/trpc/[trpc]/
prisma/
```

If using Clerk, also create:

```
src/app/main/
src/app/sign-in/[[...sign-in]]/
src/app/sign-up/[[...sign-up]]/
```

### 2. Clean public folder

Remove Next.js boilerplate assets:

```bash
rm -rf public/*.svg public/*.ico
```

### 3. Create all template files

Read [references/file-contents.md](references/file-contents.md) and create every file listed there at its specified path. Replace `{{PROJECT_NAME}}`, `{{DESCRIPTION}}`, `{{NODE_VERSION}}`, and `{{PG_VERSION}}` with the user's answers from Step 0.

**Important — existing files:** Before overwriting any file that already exists from `create-next-app` (e.g. `layout.tsx`, `page.tsx`, `next.config.ts`, `tsconfig.json`, `README.md`), you **must read it first** using the Read tool. The Write tool will reject writes to unread existing files, and if one write fails in a parallel batch, all sibling writes in that batch fail too. To avoid this, split file creation into two batches:

1. First batch: all **new** files (files that don't exist yet).
2. Second batch: read all existing files, then overwrite them.

Replace existing Next.js defaults for `layout.tsx`, `next.config.ts`, and `tsconfig.json`. Note: `src/proxy.ts` is the Next.js 16 equivalent of `middleware.ts` (only created with Clerk).

**If the user chose no Clerk**, skip these files and use the alternative templates marked with "(without Clerk)" in file-contents.md:

- `src/providers/clerk-provider.tsx` — skip entirely
- `src/proxy.ts` — skip entirely
- `src/app/main/` — skip entirely
- `src/app/sign-in/` and `src/app/sign-up/` — skip entirely
- `src/providers/index.tsx` — use the "without Clerk" variant
- `src/server/trpc.ts` — use the "without Clerk" variant
- `.env.example` — use the "without Clerk" variant
- `src/app/page.tsx` — use the "without Clerk" variant

### 4. Install dependencies

Run the setup script:

```bash
bash <skill-path>/scripts/setup.sh
```

If the user chose **no Clerk**, pass the `--no-clerk` flag:

```bash
bash <skill-path>/scripts/setup.sh --no-clerk
```

### 5. Initialize shadcn/ui

```bash
npx shadcn@latest init --defaults
npx shadcn@latest add sonner button card avatar
```

This generates `globals.css`, `components.json`, `lib/utils.ts`, and `postcss.config.mjs` automatically.

### 6. Set up environment

Copy `.env.example` to `.env`. If using Clerk, replace the empty `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` values with the credentials the user provided in Step 0:

```bash
cp .env.example .env
```

Then update the Clerk key lines in `.env` with the user's provided values.

### 7. Push database schema

```bash
docker compose up -d
npx prisma generate
npx prisma db push
```

### 8. Verify

Run `pnpm dev` and confirm the app starts without errors.
