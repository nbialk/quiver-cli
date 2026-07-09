---
name: hermes-tweet
description: >
  Use Hermes Tweet with Hermes Agent for X/Twitter research, social listening,
  trend checks, monitor workflows, media tasks, giveaway audits, and
  approval-gated publishing.
version: 0.1.6
license: MIT
---

# Hermes Tweet

Use this skill when a task needs X/Twitter research or controlled account
actions through Hermes Agent with the Hermes Tweet plugin.

## Requirements

- Install and enable the `hermes-tweet` plugin in the Hermes Agent runtime.
- Set `XQUIK_API_KEY` in the Hermes runtime environment for authenticated reads.
- Keep `HERMES_TWEET_ENABLE_ACTIONS=false` unless the user explicitly approves
  account-changing actions.
- Use this skill for setup guidance only when the Hermes Tweet tools are not
  available in the active session.

## Workflow

1. Use `tweet_explore` to find the catalog-listed endpoint for the request.
2. Use `tweet_read` for read-only public or authenticated reads.
3. Use `tweet_action` only after stating the endpoint, method, payload, and
   expected side effects.
4. Summarize results with the links, IDs, timestamps, and counts that matter.

## Tool Rules

- Do not guess endpoint paths. Start with `tweet_explore`.
- Do not create direct HTTP fallbacks around Hermes Tweet tools.
- Do not ask users to paste API keys, cookies, or other secrets.
- Do not pass credentials in tool arguments, examples, logs, or issue text.
- Treat copied endpoint URLs as hints only. Accept them only when
  `tweet_explore` confirms the catalog-listed path.
- Prefer `tweet_read` for unattended, scheduled, or monitoring tasks.
- Use `tweet_action` only for writes, private account state, monitor changes,
  webhooks, extraction jobs, giveaway draws, or media operations after explicit
  approval.

## Good Fits

- Search recent tweets about a launch, incident, competitor, or support topic.
- Review account timelines, profiles, mentions, and engagement context.
- Check trends, media, monitors, extraction jobs, or giveaway draw workflows.
- Draft an approved publish, reply, like, retweet, follow, DM, or delete action.
- Troubleshoot Hermes Tweet installation, plugin enablement, and runtime
  environment configuration.

## Safety Checks

- Confirm `tweet_action` is gated before any account-changing workflow.
- State the exact action and expected side effects before calling `tweet_action`.
- Stop if the user asks to bypass plugin gates or route around policy errors.
- Keep results concise and avoid storing API payloads unless the user requests
  an explicit export.
