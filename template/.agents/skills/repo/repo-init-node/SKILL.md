---
name: repo-init-node
description: Scaffold a new Node.js/pnpm project with TypeScript, ESLint, Prettier, .gitignore, and CLAUDE.md.
disable-model-invocation: true
allowed-tools: Read, Write, Bash(pnpm *), Bash(git *), Bash(mkdir *)
---

# /repo-init-node — Project Scaffolding

Scaffold a new TypeScript + pnpm project with opinionated defaults.

## Step 1: Ask the User

Before creating any files, ask the user for:

1. **Project description** — used in `package.json` description and `CLAUDE.md` project section.
2. **Node.js version** — default `20`.
3. **Any additional ESLint rules or Prettier overrides** — default: none.

## Step 2: Create Project Files

Create the following files. Replace `{{DESCRIPTION}}` with the user's project description and `{{NODE_VERSION}}` with the chosen Node.js version.

### `package.json`

```json
{
  "name": "{{DIRECTORY_NAME}}",
  "version": "1.0.0",
  "description": "{{DESCRIPTION}}",
  "main": "index.js",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "lint": "eslint src/",
    "format": "prettier --write src/",
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "packageManager": "pnpm@10.15.0"
}
```

Use the current directory name for `{{DIRECTORY_NAME}}`.

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

### `.prettierrc`

```json
{
  "tabWidth": 2,
  "semi": true,
  "quoteProps": "as-needed",
  "arrowParens": "always",
  "embeddedLanguageFormatting": "auto",
  "importOrder": ["<THIRD_PARTY_MODULES>", "", "^@/(.*)$", "", "^[./]"],
  "importOrderSeparation": false,
  "importOrderSortSpecifiers": true,
  "importOrderBuiltinModulesToTop": true,
  "importOrderParserPlugins": ["typescript", "decorators-legacy"],
  "importOrderMergeDuplicateImports": true,
  "importOrderCombineTypeAndValueImports": true,
  "plugins": ["@ianvs/prettier-plugin-sort-imports"]
}
```

Apply any Prettier overrides the user requested on top of this config.

### `eslint.config.mjs`

```js
import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    ignores: ["node_modules/", "dist/"],
  },
);
```

Add any extra ESLint rules the user requested.

### `.gitignore`

```
node_modules/
dist/
.env
.env.*
!.env.example
*.tsbuildinfo
```

### `CLAUDE.md`

```markdown
# CLAUDE.md

## Project

{{DESCRIPTION}}

## Tech Stack

- **Language:** TypeScript 5.9 (strict mode, ES2022 target, Node16 modules)
- **Runtime:** Node.js {{NODE_VERSION}}
- **Package Manager:** pnpm 10

## Commands

- `pnpm dev` — run with tsx (hot reload)
- `pnpm build` — compile TypeScript to `dist/`
- `pnpm start` — run compiled output
- `pnpm lint` — ESLint check
- `pnpm format` — Prettier format

## Project Structure

\`\`\`
src/ → application source code
dist/ → compiled output (gitignored)
\`\`\`

## Code Style

- ESLint 9 flat config with TypeScript support
- Prettier: semicolons, 2-space indent, trailing commas
- Import sorting via `@ianvs/prettier-plugin-sort-imports`

## Commit Convention

Use **Conventional Commits** format.

\`\`\`
<type>(<scope>): <subject>
\`\`\`

Types: `feat`, `fix`, `refactor`, `docs`, `style`, `perf`, `test`, `chore`, `ci`
```

### `src/index.ts`

```ts
console.log("Hello, world!");
```

## Step 3: Install Dependencies

Run:

```bash
pnpm add @ianvs/prettier-plugin-sort-imports
pnpm add -D typescript tsx @eslint/js eslint eslint-config-prettier prettier typescript-eslint globals
```

## Step 4: Initialize Git

If the directory is not already a git repo, run:

```bash
git init
```

## Step 5: Confirm

Tell the user the project is ready and list the created files.
