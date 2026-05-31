# Template File Contents

All files to create when setting up a new project. Create each file at the specified path. Replace `{{PROJECT_NAME}}`, `{{DESCRIPTION}}`, `{{NODE_VERSION}}`, and `{{PG_VERSION}}` with the user's answers.

---

## `CLAUDE.md`

```markdown
# CLAUDE.md

## Project

{{DESCRIPTION}}

## Tech Stack

- **Framework:** Next.js 16 with App Router and React 19
- **Auth:** Clerk (if enabled)
- **API:** tRPC with React Query
- **Database:** PostgreSQL with Prisma ORM
- **Styling:** Tailwind CSS v4 with shadcn/ui components (Radix-based)
- **AI:** Vercel AI SDK with OpenAI (if needed)

## Commands

- `pnpm dev` — start development server
- `pnpm build` — build for production
- `pnpm lint` — run ESLint
- `npx prisma db push` — push schema changes to database
- `npx prisma generate` — regenerate Prisma client
- `npx prisma studio` — open Prisma Studio

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

## Code Style

- Prettier with import sorting via `@ianvs/prettier-plugin-sort-imports`
- Tailwind class sorting via `prettier-plugin-tailwindcss`
- Conventional Commits format

## Commit Convention

\`\`\`
<type>(<scope>): <subject>
\`\`\`

Types: `feat`, `fix`, `refactor`, `docs`, `style`, `perf`, `test`, `chore`, `ci`
```

---

## `prisma/schema.prisma`

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}
```

---

## `src/lib/prisma.ts`

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

## `src/server/trpc.ts` (with Clerk)

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

## `src/server/trpc.ts` (without Clerk)

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

## `src/server/routers/_app.ts`

```ts
import { router } from "@/server/trpc";

export const appRouter = router({});

export type AppRouter = typeof appRouter;
```

---

## `src/lib/trpc/client.ts`

```ts
import type { AppRouter } from "@/server/routers/_app";
import { createTRPCReact } from "@trpc/react-query";

export const trpc = createTRPCReact<AppRouter>();
```

---

## `src/app/api/trpc/[trpc]/route.ts`

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

## `src/providers/trpc-provider.tsx`

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

## `src/providers/theme-provider.tsx`

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

## `src/providers/clerk-provider.tsx` (only with Clerk)

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

## `src/providers/index.tsx` (with Clerk)

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

## `src/providers/index.tsx` (without Clerk)

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

## `src/app/layout.tsx`

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
  title: "My App",
  description: "My App",
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

## `src/app/sign-in/[[...sign-in]]/page.tsx` (only with Clerk)

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

## `src/app/sign-up/[[...sign-up]]/page.tsx` (only with Clerk)

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

## `src/app/main/page.tsx` (only with Clerk)

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

## `.env.example` (with Clerk)

```
NEXT_PUBLIC_BASE_URL=http://localhost:3000

# Database (used by Prisma)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/myapp?schema=public"
SHADOW_DATABASE_URL="postgresql://postgres:postgres@localhost:5433/myapp_shadow?schema=public"

# Clerk Authentication (get from https://dashboard.clerk.com)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY={{CLERK_PUBLISHABLE_KEY}}
CLERK_SECRET_KEY={{CLERK_SECRET_KEY}}
NEXT_PUBLIC_CLERK_SIGN_IN_URL="/sign-in"
NEXT_PUBLIC_CLERK_SIGN_UP_URL="/sign-up"
```

---

## `.env.example` (without Clerk)

```
NEXT_PUBLIC_BASE_URL=http://localhost:3000

# Database (used by Prisma)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/myapp?schema=public"
SHADOW_DATABASE_URL="postgresql://postgres:postgres@localhost:5433/myapp_shadow?schema=public"
```

---

## `docker-compose.yml`

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

## `.prettierrc`

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

## `src/proxy.ts` (only with Clerk)

Clerk middleware for Next.js 16+ (replaces the old `middleware.ts`).

```ts
import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
```

---

## `prisma.config.ts`

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

## `next.config.ts`

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
};

export default nextConfig;
```

---

## `tsconfig.json`

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

## `.nvmrc`

```
{{NODE_VERSION}}
```

---

## `src/app/page.tsx` (with Clerk)

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

## `src/app/page.tsx` (without Clerk)

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

## `README.md`

```markdown
# {{PROJECT_NAME}}

{{DESCRIPTION}}

## Getting Started

1. Install dependencies: `pnpm install`
2. Copy environment file: `cp .env.example .env`
3. Start the database: `docker compose up -d`
4. Push the schema: `npx prisma db push`
5. Run the dev server: `pnpm dev`
6. Open [http://localhost:3000](http://localhost:3000)
```

---

## `Makefile`

```makefile
.PHONY: dev build studio db

dev:
	@pnpm run dev

build:
	@pnpm run build

studio:
	@pnpm prisma studio

db:
	@docker compose up -d
```
