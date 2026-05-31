---
description: Scaffold a new Next.js project with tRPC, Prisma, PostgreSQL, Clerk auth, shadcn/ui, ESLint, Prettier, and knip
---

# Next.js Full-Stack Project Setup

Bootstrap a Next.js App Router project with: Prisma + PostgreSQL (Docker), tRPC + React Query, optional Clerk auth, next-themes, sonner toasts, Tailwind v4 with shadcn/ui, Prettier, ESLint flat config, and knip.

## Prerequisites

- A Next.js project already created via `pnpm create next-app` (with App Router, TypeScript, Tailwind CSS, `src/` directory)
- pnpm as package manager
- Docker installed (for PostgreSQL)

## Workflow

### 0. Ask the User

Before creating any files, ask the user for:

1. **Project name** — used in `README.md`, `package.json`, `AGENTS.md`.
2. **Project description** — used in `AGENTS.md`, `README.md`, `package.json`.
3. **Node.js version** — default `24`. Used in `.nvmrc`.
4. **PostgreSQL version** — default `18`. Used in `docker-compose.yml`.
5. **shadcn/ui preset code** — optional. A preset code from [shadcn.com/themes](https://ui.shadcn.com/themes) (e.g. `a1Dg5eFl`). If empty, use `--defaults`.
6. **With Clerk auth?** — default: yes. If no, skip all Clerk-related files and packages.
7. If the user chose Clerk, also ask for:
   - **Clerk Publishable Key** (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`)
   - **Clerk Secret Key** (`CLERK_SECRET_KEY`)

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

Create every file listed in the **Template Files** section below at its specified path. Replace `{{PROJECT_NAME}}`, `{{DESCRIPTION}}`, `{{NODE_VERSION}}`, and `{{PG_VERSION}}` with the user's answers from Step 0.

**Important — existing files:** Before overwriting any file that already exists from `create-next-app` (e.g. `layout.tsx`, `page.tsx`, `next.config.ts`, `tsconfig.json`, `README.md`, `package.json`, `.gitignore`), you **must read it first** using the Read tool. Split file creation into two batches:

1. First batch: all **new** files (files that don't exist yet).
2. Second batch: read all existing files, then overwrite them.

**If the user chose no Clerk**, skip these files and use the alternative templates marked with "(without Clerk)":

- `src/providers/clerk-provider.tsx` — skip entirely
- `src/proxy.ts` — skip entirely
- `src/app/main/` — skip entirely
- `src/app/sign-in/` and `src/app/sign-up/` — skip entirely
- `src/providers/index.tsx` — use the "without Clerk" variant
- `src/server/trpc.ts` — use the "without Clerk" variant
- `.env.example` — use the "without Clerk" variant
- `src/app/page.tsx` — use the "without Clerk" variant

### 4. Install dependencies

Run these commands:

```bash
pnpm add \
  @prisma/client @prisma/adapter-pg pg \
  @trpc/client @trpc/server @trpc/react-query \
  @tanstack/react-query \
  superjson \
  next-themes sonner \
  clsx tailwind-merge \
  lucide-react \
  tw-animate-css \
  dotenv
```

If using Clerk:

```bash
pnpm add @clerk/nextjs
```

Dev dependencies:

```bash
pnpm add -D \
  prisma \
  babel-plugin-react-compiler \
  @ianvs/prettier-plugin-sort-imports \
  prettier-plugin-tailwindcss \
  prettier \
  knip
```

### 5. Initialize shadcn/ui

If the user provided a preset code:

```bash
pnpm dlx shadcn@latest init --preset {{PRESET_CODE}}
```

If no preset code:

```bash
pnpm dlx shadcn@latest init --defaults
```

Then add base components:

```bash
pnpm dlx shadcn@latest add sonner button card avatar
```

This generates `globals.css`, `components.json`, `lib/utils.ts`, and `postcss.config.mjs` automatically.

### 6. Extend package.json

Read the existing `package.json` and merge the following. Do NOT overwrite the entire file — only add/update the `scripts` and `knip` fields:

**Scripts to add/overwrite:**

```json
{
  "scripts": {
    "dev": "npx prisma generate && next dev",
    "build": "npx prisma generate && npx prisma migrate deploy && next build",
    "start": "next start",
    "postinstall": "npx prisma generate",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "tsc": "tsc --noEmit",
    "db": "docker compose up -d",
    "db:push": "npx prisma db push",
    "db:migrate": "npx prisma migrate dev",
    "db:studio": "npx prisma studio",
    "cleanup": "knip"
  }
}
```

**knip config to add:**

```json
{
  "knip": {
    "entry": ["src/app/**/*.{ts,tsx}", "src/server/**/*.ts"],
    "project": ["src/**/*.{ts,tsx}"],
    "ignore": ["src/components/ui/**"]
  }
}
```

### 7. Set up environment

```bash
cp .env.example .env
```

If using Clerk, replace the empty key values in `.env` with the credentials the user provided in Step 0.

### 8. Push database schema

```bash
docker compose up -d
npx prisma generate
npx prisma db push
```

### 9. Verify

Run `pnpm dev` and confirm the app starts without errors.

---

## Template Files

All files to create. Replace `{{PROJECT_NAME}}`, `{{DESCRIPTION}}`, `{{NODE_VERSION}}`, and `{{PG_VERSION}}` with the user's answers.

---

### `AGENTS.md`

```markdown
# AGENTS.md

## Project

{{DESCRIPTION}}

## Tech Stack

- **Framework:** Next.js 16 with App Router and React 19
- **Auth:** Clerk (if enabled)
- **API:** tRPC with React Query
- **Database:** PostgreSQL with Prisma ORM
- **Styling:** Tailwind CSS v4 with shadcn/ui components (Radix-based)

## Commands

- `pnpm dev` — start development server
- `pnpm build` — build for production
- `pnpm lint` — run ESLint
- `pnpm format` — format with Prettier
- `pnpm format:check` — check formatting
- `pnpm tsc` — typecheck
- `pnpm db` — start PostgreSQL via Docker
- `pnpm db:push` — push schema changes to database
- `pnpm db:migrate` — create and run migrations
- `pnpm db:studio` — open Prisma Studio
- `pnpm cleanup` — detect dead code with knip

## Project Structure

\`\`\`
src/
├── app/ # Next.js App Router pages
├── server/
│ ├── trpc.ts # tRPC context & procedures
│ └── routers/ # tRPC routers
├── lib/
│ ├── prisma.ts # Prisma client singleton
│ └── trpc/client.ts # tRPC React client
├── components/
│ └── ui/ # shadcn/ui base components
└── providers/ # React context providers
\`\`\`

## Naming Conventions

- File names: kebab-case everywhere
- Components & types: PascalCase
- Functions & procedures: camelCase
- Constants: UPPER_SNAKE_CASE
- Hooks: `use-<name>.ts`

## Imports

- Use `@/` path alias, not relative paths
- No barrel files

## Code Style

- Prettier with import sorting via `@ianvs/prettier-plugin-sort-imports`
- Tailwind class sorting via `prettier-plugin-tailwindcss`
- TypeScript strict mode enabled
- Avoid `any`; prefer `unknown` + narrowing

## Commit Convention

\`\`\`
<type>(<scope>): <subject>
\`\`\`

Types: `feat`, `fix`, `refactor`, `docs`, `style`, `perf`, `test`, `chore`, `ci`
```

---

### `prisma/schema.prisma`

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}
```

---

### `prisma.config.ts`

```ts
import "dotenv/config";

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  datasource: {
    url: process.env.DATABASE_URL!,
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
```

---

### `src/lib/prisma.ts`

```ts
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

const prisma =
  globalThis.prisma ||
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.prisma = prisma;
}

export default prisma;
```

---

### `src/server/trpc.ts` (with Clerk)

```ts
import { auth } from "@clerk/nextjs/server";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";

export interface Context {
  userId: string | null;
}

export async function createContext(): Promise<Context> {
  const { userId } = await auth();
  return { userId: userId ?? null };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

const enforceUserAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { userId: ctx.userId! } });
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(enforceUserAuthenticated);
```

---

### `src/server/trpc.ts` (without Clerk)

```ts
import { initTRPC } from "@trpc/server";
import superjson from "superjson";

export interface Context {
  userId: string | null;
}

export async function createContext(): Promise<Context> {
  // TODO: implement your own auth logic here
  return { userId: null };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const publicProcedure = t.procedure;
```

---

### `src/server/routers/_app.ts`

```ts
import { router } from "@/server/trpc";

export const appRouter = router({});

export type AppRouter = typeof appRouter;
```

---

### `src/lib/trpc/client.ts`

```ts
import type { AppRouter } from "@/server/routers/_app";
import { createTRPCReact } from "@trpc/react-query";

export const trpc = createTRPCReact<AppRouter>();
```

---

### `src/app/api/trpc/[trpc]/route.ts`

```ts
import { appRouter } from "@/server/routers/_app";
import { createContext } from "@/server/trpc";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext,
  });

export { handler as GET, handler as POST };
```

---

### `src/providers/trpc-provider.tsx`

```tsx
"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, loggerLink } from "@trpc/client";
import superjson from "superjson";

export function TRPCProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        loggerLink({ enabled: () => process.env.NODE_ENV === "development" }),
        httpBatchLink({
          url: `${process.env.NEXT_PUBLIC_BASE_URL}/api/trpc`,
          transformer: superjson,
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
```

---

### `src/providers/theme-provider.tsx`

```tsx
"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute='class'
      defaultTheme='system'
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
```

---

### `src/providers/clerk-provider.tsx` (only with Clerk)

```tsx
"use client";

import { ClerkProvider as ClerkProviderBase } from "@clerk/nextjs";

export function ClerkProvider({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProviderBase signInFallbackRedirectUrl='/main'>
      {children}
    </ClerkProviderBase>
  );
}
```

---

### `src/providers/index.tsx` (with Clerk)

```tsx
"use client";

import { ClerkProvider } from "./clerk-provider";
import { ThemeProvider } from "./theme-provider";
import { TRPCProvider } from "./trpc-provider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <ThemeProvider>
        <TRPCProvider>{children}</TRPCProvider>
      </ThemeProvider>
    </ClerkProvider>
  );
}
```

---

### `src/providers/index.tsx` (without Clerk)

```tsx
"use client";

import { ThemeProvider } from "./theme-provider";
import { TRPCProvider } from "./trpc-provider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <TRPCProvider>{children}</TRPCProvider>
    </ThemeProvider>
  );
}
```

---

### `src/app/layout.tsx`

Replace the existing layout with:

```tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/providers";

import { Toaster } from "@/components/ui/sonner";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "{{PROJECT_NAME}}",
  description: "{{DESCRIPTION}}",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang='en' suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} bg-background text-foreground antialiased`}
      >
        <Providers>
          {children}
          <Toaster position='top-center' richColors />
        </Providers>
      </body>
    </html>
  );
}
```

---

### `src/app/page.tsx` (with Clerk)

```tsx
import Link from "next/link";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";

import { Button } from "@/components/ui/button";

export default async function HomePage() {
  let dbConnected = false;
  try {
    await prisma.$queryRaw(Prisma.sql`SELECT 1`);
    dbConnected = true;
  } catch {
    dbConnected = false;
  }

  return (
    <main className='flex min-h-screen flex-col items-center justify-center gap-6'>
      <h1 className='text-4xl font-bold'>{{ PROJECT_NAME }}</h1>
      <div className='flex items-center gap-2'>
        <span
          className={`inline-block h-3 w-3 rounded-full ${dbConnected ? "bg-green-500" : "bg-red-500"}`}
        />
        <span className='text-muted-foreground text-sm'>
          Database {dbConnected ? "connected" : "disconnected"}
        </span>
      </div>
      <div className='flex gap-4'>
        <Button asChild>
          <Link href='/sign-in'>Sign In</Link>
        </Button>
        <Button asChild variant='outline'>
          <Link href='/sign-up'>Sign Up</Link>
        </Button>
      </div>
    </main>
  );
}
```

---

### `src/app/page.tsx` (without Clerk)

```tsx
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export default async function HomePage() {
  let dbConnected = false;
  try {
    await prisma.$queryRaw(Prisma.sql`SELECT 1`);
    dbConnected = true;
  } catch {
    dbConnected = false;
  }

  return (
    <main className='flex min-h-screen flex-col items-center justify-center gap-6'>
      <h1 className='text-4xl font-bold'>{{ PROJECT_NAME }}</h1>
      <div className='flex items-center gap-2'>
        <span
          className={`inline-block h-3 w-3 rounded-full ${dbConnected ? "bg-green-500" : "bg-red-500"}`}
        />
        <span className='text-muted-foreground text-sm'>
          Database {dbConnected ? "connected" : "disconnected"}
        </span>
      </div>
    </main>
  );
}
```

---

### `src/app/sign-in/[[...sign-in]]/page.tsx` (only with Clerk)

```tsx
import { SignIn } from "@clerk/nextjs";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <div className='flex min-h-screen items-center justify-center'>
      <SignIn />
    </div>
  );
}
```

---

### `src/app/sign-up/[[...sign-up]]/page.tsx` (only with Clerk)

```tsx
import { SignUp } from "@clerk/nextjs";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  return (
    <div className='flex min-h-screen items-center justify-center'>
      <SignUp />
    </div>
  );
}
```

---

### `src/app/main/page.tsx` (only with Clerk)

```tsx
import { redirect } from "next/navigation";
import { SignOutButton } from "@clerk/nextjs";
import { auth, currentUser } from "@clerk/nextjs/server";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default async function MainPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await currentUser();
  if (!user) redirect("/sign-in");

  const initials =
    [user.firstName?.[0], user.lastName?.[0]]
      .filter(Boolean)
      .join("")
      .toUpperCase() || "?";

  return (
    <main className='flex min-h-screen items-center justify-center'>
      <Card className='w-full max-w-sm'>
        <CardHeader className='flex flex-col items-center gap-4'>
          <Avatar className='h-20 w-20'>
            <AvatarImage src={user.imageUrl} alt={user.fullName ?? "User"} />
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <CardTitle className='text-center'>
            {user.fullName ?? "User"}
          </CardTitle>
        </CardHeader>
        <CardContent className='text-muted-foreground space-y-1 text-center text-sm'>
          {user.primaryEmailAddress && (
            <p>{user.primaryEmailAddress.emailAddress}</p>
          )}
        </CardContent>
        <CardFooter className='justify-center'>
          <SignOutButton redirectUrl='/'>
            <Button variant='outline'>Sign Out</Button>
          </SignOutButton>
        </CardFooter>
      </Card>
    </main>
  );
}
```

---

### `src/proxy.ts` (only with Clerk)

Clerk middleware for Next.js 16+ (replaces the old `middleware.ts`).

```ts
import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
```

---

### `.env.example` (with Clerk)

```
NEXT_PUBLIC_BASE_URL=http://localhost:3000

# Database (used by Prisma)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/myapp?schema=public"
SHADOW_DATABASE_URL="postgresql://postgres:postgres@localhost:5433/myapp_shadow?schema=public"

# Clerk Authentication (get from https://dashboard.clerk.com)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
NEXT_PUBLIC_CLERK_SIGN_IN_URL="/sign-in"
NEXT_PUBLIC_CLERK_SIGN_UP_URL="/sign-up"
```

---

### `.env.example` (without Clerk)

```
NEXT_PUBLIC_BASE_URL=http://localhost:3000

# Database (used by Prisma)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/myapp?schema=public"
SHADOW_DATABASE_URL="postgresql://postgres:postgres@localhost:5433/myapp_shadow?schema=public"
```

---

### `docker-compose.yml`

```yaml
services:
  postgres:
    image: postgres:{{PG_VERSION}}-alpine
    restart: unless-stopped
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: myapp
    volumes:
      - postgres_data:/var/lib/postgresql/data

  postgres-shadow:
    image: postgres:{{PG_VERSION}}-alpine
    restart: unless-stopped
    ports:
      - "5433:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: myapp_shadow
    volumes:
      - postgres_shadow_data:/var/lib/postgresql/data

volumes:
  postgres_data:
  postgres_shadow_data:
```

---

### `.prettierrc`

```json
{
  "tabWidth": 2,
  "semi": true,
  "jsxSingleQuote": true,
  "quoteProps": "as-needed",
  "bracketSameLine": false,
  "arrowParens": "always",
  "embeddedLanguageFormatting": "auto",
  "importOrder": [
    "^(react/(.*)$)|^(react$)",
    "^(next/(.*)$)|^(next$)",
    "<THIRD_PARTY_MODULES>",
    "",
    "^types$",
    "^@/config/(.*)$",
    "^@/actions/(.*)$",
    "^@/stores/(.*)$",
    "^@/types/(.*)$",
    "^@/components/ui/(.*)$",
    "^@/components/(.*)$",
    "^@/styles/(.*)$",
    "^@/app/(.*)$",
    "",
    "^[./]"
  ],
  "importOrderSeparation": false,
  "importOrderSortSpecifiers": true,
  "importOrderBuiltinModulesToTop": true,
  "importOrderParserPlugins": ["typescript", "jsx", "decorators-legacy"],
  "importOrderMergeDuplicateImports": true,
  "importOrderCombineTypeAndValueImports": true,
  "plugins": [
    "@ianvs/prettier-plugin-sort-imports",
    "prettier-plugin-tailwindcss"
  ]
}
```

---

### `eslint.config.mjs`

```js
import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [".next/", "out/", "build/", "next-env.d.ts"],
  },
];

export default eslintConfig;
```

---

### `next.config.ts`

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
};

export default nextConfig;
```

---

### `tsconfig.json`

Replace the default with:

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts",
    "**/*.mts"
  ],
  "exclude": ["node_modules"]
}
```

---

### `.nvmrc`

```
{{NODE_VERSION}}
```

---

### `.gitignore`

```
# dependencies
node_modules/

# next.js
.next/
out/
build/

# environment
.env
.env.*
!.env.example

# vercel
.vercel

# typescript
*.tsbuildinfo
next-env.d.ts

# misc
.DS_Store
*.pem
```

---

### `README.md`

```markdown
# {{PROJECT_NAME}}

{{DESCRIPTION}}

## Getting Started

1. Install dependencies: `pnpm install`
2. Copy environment file: `cp .env.example .env`
3. Start the database: `pnpm db`
4. Push the schema: `pnpm db:push`
5. Run the dev server: `pnpm dev`
6. Open [http://localhost:3000](http://localhost:3000)

## Scripts

| Command             | Description                      |
| ------------------- | -------------------------------- |
| `pnpm dev`          | Start development server         |
| `pnpm build`        | Production build                 |
| `pnpm lint`         | Run ESLint                       |
| `pnpm format`       | Format with Prettier             |
| `pnpm format:check` | Check formatting                 |
| `pnpm tsc`          | TypeScript typecheck             |
| `pnpm db`           | Start PostgreSQL via Docker      |
| `pnpm db:push`      | Push schema changes to database  |
| `pnpm db:migrate`   | Create and run Prisma migrations |
| `pnpm db:studio`    | Open Prisma Studio               |
| `pnpm cleanup`      | Detect dead code with knip       |
```
