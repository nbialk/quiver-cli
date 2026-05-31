# Cleanup Skill

Find unused code, dependencies, and exports using knip.

## Instructions

1. Run `pnpm cleanup` and capture the full output
2. Analyze the results by category:
   - **Unlisted dependencies** (highest priority — potential runtime bugs)
   - **Unused dependencies** (safe to remove)
   - **Unused files** (dead code)
   - **Unused exports** (review needed — may be used dynamically)
3. Report findings to the user, grouped by category and sorted by priority
4. Do NOT apply any fixes automatically — wait for explicit user confirmation on what to remove
5. When the user confirms removals:
   - For unused dependencies: `pnpm remove <package>`
   - For unused files: delete the file
   - For unused exports: remove the export keyword or the entire declaration if fully unused
6. After applying fixes, run `pnpm cleanup` again to verify
7. Run `pnpm build` to confirm nothing broke

## Notes

- shadcn/ui components may report unused exports — these are typically false positives since components are used via their public API
- `ignoreExportsUsedInFile` is enabled in `knip.json` to reduce noise from utility files
- If knip reports issues with auto-detected plugins (Next.js, ESLint, Prisma), check `knip.json` config before acting
