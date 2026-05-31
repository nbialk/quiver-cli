#!/bin/bash
set -e

# Parse flags
NO_CLERK=false
for arg in "$@"; do
  case $arg in
    --no-clerk) NO_CLERK=true ;;
  esac
done

# Check prerequisites
if ! command -v pnpm &> /dev/null; then
  echo "Error: pnpm is not installed. Install it first: npm install -g pnpm"
  exit 1
fi

if ! command -v docker &> /dev/null; then
  echo "Warning: docker is not installed. You will need it for the PostgreSQL database."
fi

echo "Installing runtime dependencies..."
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

if [ "$NO_CLERK" = false ]; then
  echo "Installing Clerk..."
  pnpm add @clerk/nextjs
fi

echo "Installing dev dependencies..."
pnpm add -D \
  prisma \
  babel-plugin-react-compiler \
  @ianvs/prettier-plugin-sort-imports \
  prettier-plugin-tailwindcss \
  prettier

echo "Setup complete!"
