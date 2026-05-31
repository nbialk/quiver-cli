---
name: db-query
description: 'Ad-hoc Prisma-Queries gegen die Neon PostgreSQL DB ausführen. Nutzen wenn der User DB-Abfragen, Datenanalyse, Datenkorrekturen, oder explorative Queries anfragt. Trigger: "query the db", "check the database", "how many workouts", "show me the data", "DB abfragen", "Daten pruefen", "loesch den Eintrag", "welche Daten".'
---

# Ad-hoc Database Queries

Run Prisma queries against the Neon PostgreSQL database (eu-central-1, `neondb`).

## Setup

Every query needs the Prisma + pg adapter boilerplate and `dotenv/config` loaded via `-r` flag (since `tsx -e` does not read `.env` automatically).

**Do not import from `src/lib/prisma.ts`** — its default export does not work with `tsx -e`.

## Inline Query (short, single-purpose)

```bash
npx tsx -r dotenv/config -e "
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const result = await prisma.<model>.<method>({ /* query */ });
console.log(result);

await prisma.\$disconnect();
"
```

## Script Query (complex, multi-step)

For longer queries, create a temporary script file and run it:

```bash
npx tsx -r dotenv/config scripts/<name>.ts
```

The script file uses the same boilerplate. Delete temporary scripts after use.

## Rules

1. Always call `await prisma.$disconnect()` at the end.
2. Never run mutations (create, update, delete, deleteMany) without explicit user confirmation.
3. For schema details (models, fields, relations, indexes), read `references/schema.md`.
4. Use `console.log()` or `console.table()` to output results.
5. Wrap in try/finally to guarantee disconnect on errors:
   ```ts
   try {
     // query
   } finally {
     await prisma.$disconnect();
   }
   ```
