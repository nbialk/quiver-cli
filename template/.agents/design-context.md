# Design Context

## Users

Single user (the developer), using this as a personal AI assistant and life dashboard. The primary context is daily routines: morning check-ins reviewing health data and calendar, grocery tracking after shopping, and ongoing task management throughout the day. The AI chat is the primary interface -- most interactions start as conversations that surface structured data via tool calls. The user is technical, values density over hand-holding, and expects the UI to respect their time.

## Brand Personality

**Clean, warm, capable.** The app should feel like a well-made personal tool -- competent and reliable without being cold or clinical. It knows what matters and presents it without fuss. There is a subtle warmth (the off-white background, the hint of orange in the sidebar) that keeps it from feeling sterile, but decoration never competes with function.

**Emotional goal: Grounded awareness.** The interface should provide a steady, unhurried overview of life data. Not anxious, not gamified, not trying to impress. Just a clear, honest view of what's happening, presented with care.

## Aesthetic Direction

**Visual tone:** High-density, data-forward, quietly modern. Information is the decoration. Monospace numerals, tight card layouts, and deliberate whitespace create rhythm without ornament.

**Reference:** Arc Browser -- tasteful color accents, modern feel, functional but not boring, personality without being loud.

**Anti-references:**

- Notion: too many options, visual clutter, flexibility over focus.
- Playful consumer apps: too colorful, too many illustrations, gamified.
- Generic dashboards: bland corporate charts, Bootstrap/Material Design aesthetic.

**Theme:** Full dark and light mode support. Monochrome neutral base (OKLCH, shadcn/ui neutral palette) with warm undertones. Semantic color used sparingly and purposefully -- status indicators, priority badges -- never for decoration.

**Typography:** Geist Sans for prose, Geist Mono for all numeric data. Small text sizes (`text-sm`, `text-xs`) with tight leading. Section headers use uppercase tracking with `text-[11px]` weight. The overall feel is compact and precise.

**Spacing:** Tight but breathable. Cards use reduced padding, rows use `py-1.5` to `py-2`, gaps are `gap-1` to `gap-4`. Density is high, but dividers and subtle borders provide structure.

**German locale** is used for all user-facing text, dates, and number formatting. Always proper umlauts, never ASCII transliterations.

## Design Principles

1. **Data is the interface.** Every element should earn its space by conveying information or enabling action. No filler, no decorative chrome, no empty states that waste screen real estate.

2. **Warm precision.** Be technically precise (monospace numbers, aligned columns, consistent spacing) while remaining approachable. The subtle warm tones and rounded corners soften what could otherwise feel like a terminal.

3. **Chat-first, cards-second.** The conversation is the primary interaction model. Structured UI (cards, charts, tables) appears in service of the conversation, not as standalone dashboards competing for attention.

4. **Quiet confidence.** The UI should never shout. Status, urgency, and importance are communicated through subtle color shifts, weight changes, and spatial hierarchy -- not through bold banners or animated alerts.

5. **Respect the single user.** This is a personal tool, not a product for strangers. Optimize for the owner's workflows rather than discoverability. Assume familiarity; skip onboarding patterns.
