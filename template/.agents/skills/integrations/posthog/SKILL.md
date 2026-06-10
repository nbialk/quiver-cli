---
name: posthog
description: Add and use PostHog in Next.js (App Router) applications. Use when needing to (1) integrate PostHog analytics, (2) set up LLM analytics for AI SDK / Anthropic generations, (3) add error tracking, or (4) implement feature flags. Covers SDK setup, user identification, event capture, exception tracking, source maps, and server/client flag evaluation. Curated for a Next.js + Vercel AI SDK stack.
license: MIT. Curated from PostHog's official skills (github.com/PostHog/skills).
allowed-tools:
  - WebFetch(domain:posthog.com)
  - Bash(curl *posthog.com/*)
  - Read(references/**)
---

# PostHog

This skill helps you add and use PostHog effectively in Next.js App Router applications across four workflows: product analytics integration, LLM analytics, error tracking, and feature flags.

It is curated for a Next.js + Vercel AI SDK stack. For providers, frameworks, or surfaces not covered here, fetch the current docs (see "Documentation" below) before implementing.

## Core principles

Follow these for ALL PostHog work:

1. **Documentation first**: NEVER implement from memory. PostHog SDKs change frequently. Read the matching reference file below, and fetch current docs when something is unclear or unlisted.
2. **Environment variables**: Always read PostHog keys and host URLs from environment variables. Never hardcode them. The host is `https://us.i.posthog.com` (US) or `https://eu.i.posthog.com` (EU).
3. **Minimal changes**: Add PostHog code alongside existing logic. Don't replace or restructure existing code.
4. **No PII in event properties**: Never put emails, names, phone numbers, addresses, IPs, or user-generated content in `capture()` properties. PII belongs in `identify()` person properties. Safe event properties are metadata (e.g. `message_length`, `form_type`, boolean flags).

## Use-case specific references

Pick the workflow, then read the listed references before implementing.

### 1. Integration (product analytics)

Add PostHog analytics to a Next.js App Router app. Start here for any new setup.

- `references/integration-nextjs.md` — Next.js integration docs (init, pageviews, capture)
- `references/integration-example.md` — full example project showing the target pattern
- `references/identify-users.md` — identifying users on login/signup
- Setup workflow (in order): `references/integration-step-1-begin.md` → `references/integration-step-2-edit.md` → `references/integration-step-3-revise.md` → `references/integration-step-4-conclude.md`

Key guidelines:
- For Next.js 15.3+, initialize PostHog in `instrumentation-client.ts` for the simplest setup.
- Identify users during login and signup. If both frontend and backend exist, pass the client session and distinct ID via `X-POSTHOG-DISTINCT-ID` and `X-POSTHOG-SESSION-ID` headers to keep correlation.
- Add capture in event handlers where the user action occurs, NOT in `useEffect` reacting to state.

### 2. LLM analytics (Vercel AI SDK / Anthropic)

Instrument LLM generations to capture tokens, model, latency, and cost. Matches an AI SDK stack.

- `references/llm-analytics-basics.md` — concepts and what gets captured
- `references/llm-analytics-vercel-ai.md` — Vercel AI SDK setup via OpenTelemetry + `@posthog/ai` (primary path)
- `references/llm-analytics-anthropic.md` — Anthropic SDK instrumentation
- `references/llm-analytics-manual-capture.md` — generic fallback for any provider via manual `$ai_generation` events
- `references/llm-analytics-traces.md` — grouping generations into traces
- `references/llm-analytics-costs.md` — cost calculation

Key guidelines:
- The Vercel AI SDK path uses `@posthog/ai/otel` `PostHogTraceExporter` + OpenTelemetry; pass `experimental_telemetry` (with `posthog_distinct_id` metadata) on AI SDK calls. The SDKs do NOT proxy your LLM calls; they only send analytics in the background.
- Only instrument provider(s) actually present in the codebase. One provider at a time.
- Link generations to identified users via distinct IDs where possible.

### 3. Error tracking

Capture exceptions with resolved stack traces.

- `references/error-tracking-nextjs.md` — Next.js error tracking install
- `references/error-tracking-monitoring.md` — monitor and search issues
- `references/error-tracking-source-maps.md` — upload source maps so traces resolve to original source
- `references/error-tracking-alerts.md` — error tracking alerts
- `references/error-tracking-assigning-issues.md` — assign issues to teammates
- `references/error-tracking-fingerprints.md` — custom fingerprints for grouping

Key guidelines:
- Enable exception autocapture in SDK init before adding manual captures.
- Upload source maps, otherwise stack traces point at minified bundles.
- Use `captureException()` at error boundaries and catch blocks for errors that don't reach the global handler.

### 4. Feature flags

Evaluate boolean and multivariate flags, server- and client-side.

- `references/feature-flags-best-practices.md` — flag best practices
- `references/feature-flags-react.md` — React hooks (`useFeatureFlagEnabled`, `useFeatureFlagPayload`)

Key guidelines:
- Default to boolean flag checks unless multivariate is explicitly requested.
- Prefer server-side evaluation to avoid UI flicker: in Server Components / Route Handlers use the `posthog-node` SDK (`getFeatureFlag` / `getAllFlags`, then `await posthog.shutdown()`), and pass values to client components as props.
- The React hooks work WITHOUT `PostHogProvider` if `posthog-js` is already initialized (e.g. via `instrumentation-client.ts`). Don't add a provider just for flags.
- Client-side hooks may return `undefined` while flags load — handle the loading state.
- If a PostHog MCP server is connected, use its flag-management tools to create/list/update flags directly instead of asking the user to do it in the dashboard.

## Documentation

When a reference doesn't cover the case, fetch current PostHog docs. Prefer your native web fetch/search tools over `curl`.

- Browse `https://posthog.com/docs` or fetch a page as markdown by appending `.md` to its path:
  ```bash
  curl -s "https://posthog.com/docs/libraries/next-js.md"
  ```
- The full doc index lives at `https://posthog.com/llms.txt`.

## Attribution

Curated from PostHog's official skills collection (`github.com/PostHog/skills`, MIT). Reference files are sourced from the `integration`, `llm-analytics`, `error-tracking`, and `feature-flags` skills, trimmed to the Next.js + AI SDK stack.
