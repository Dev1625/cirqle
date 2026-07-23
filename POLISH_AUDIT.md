# Cirqle — Design Polish Audit

Walked the app as a seeded test user (`polish-test@cirqle.dev`) at 1440×900, 1024×768, and 768×1000, using a local Firebase Auth/Firestore emulator (see `POLISH_REPORT.md` for why) and headless-browser screenshots for every screen, tab, and modal. Findings below are grouped by screen and tagged by category. Items are checked off as they're fixed in Phase 2.

Cirqle's identity — cream "paper" background, hard ink borders, offset drop-shadows, Playfair Display italic serif headers, Inconsolata uppercase mono labels, dot-grid texture — is distinctive and well-executed. The goal below is refinement, not a reskin.

Legend: `[ALIGN]` `[COLOR]` `[TYPE]` `[MOTION]` `[STATE]` `[FLOW]` `[RESPONSIVE]`

---

## Global / Shared (affects every screen)

- [x] **[FLOW] Floating global search bar overlaps page content.** On Dashboard, Directory, and every Tracker view, the last visible row/card at the bottom of the initial viewport is visually cut off by the fixed "Ask AI" search bar (`AppLayout.tsx`). The `pb-48` reserved space isn't enough once shadows/borders are counted, and there's no scroll affordance hinting more content exists below. Reproduced at 1440, 1024, and 768.
- [x] **[COLOR] Inactive/secondary text fails WCAG AA via opacity dimming.** Nav items use `opacity-40` on 10px uppercase mono labels (contrast ≈2.47:1 against paper — fails even large-text AA). Most "subtle" subtitles use `opacity-50` (≈3.24:1). Measured against the actual token colors; this pattern repeats across every screen (page subtitles, inactive nav, muted metadata). Needs a solid muted-ink token tuned to pass 4.5:1 instead of opacity tricks.
- [x] **[COLOR] Relationship-tier badges carry no color coding.** Strong/Warm/Cold/Dormant chips all render in the same tan `bg-accent` in Directory, Tracker, and Dashboard rolodex — the one signal a "skim your network" product should make instantly scannable is currently invisible.
- [x] **[MOTION] No mount/unmount transition on modals.** Draft Outreach, Add Contact, Help & Tours, and Filter panel all pop in/out with zero transition (instant `{show && <div>}`). Per the polish standard, these should fade+scale in ~150–200ms.
- [x] **[STATE] Tracker tab bar clips text at 1024px.** "Industry" renders as "INDUS" with a hard clip and no ellipsis or scroll affordance — `overflow-x-auto` + `no-scrollbar` hides the only cue that more tabs exist off-screen.
- [x] **[RESPONSIVE] Sidebar never collapses responsively.** Below ~1100px the fixed 256px sidebar plus content squeezes dashboards/grids (4-col metric rows) uncomfortably tight at 768–1024px; only a manual click collapses it.
- [ ] **[STATE] `alert()` / `window.confirm()` used for feedback and destructive confirmation** (Settings save, PDF parse errors, Templates delete, reply/draft failures, Clear Directory/Tracker). These block the render thread and look unfinished next to the rest of the product's custom UI. Needs a toast system + a styled confirm dialog matching the app's modal pattern.
- [ ] **[MOTION] No `prefers-reduced-motion` handling anywhere new motion is added** — needs to be baked into whatever transition utility we introduce.

## Dashboard

- [x] **[STATE] "This Week's AI Priorities" has no timeout or error state.** If the Gemini call fails or hangs, the card is stuck forever on "Reading tracker data and generating your brief..." with the refresh button disabled — a dead end with no retry, no honest error message. (Verified: in this sandbox, with no reachable AI gateway, this is exactly what happens.)
- [x] **[FLOW] Misleading empty-state copy on brief failure.** On failure the catch-block silently swallows the error; next render falls through to "Not enough data to calculate priorities yet." even though there are 15 contacts — actively misleading.
- [x] **[STATE] AI-brief fetch re-fires on every Firestore snapshot change**, not once per session. During seeding (15 sequential writes) this fired ~15 wasted AI calls. Needs a "fetched this session" guard, decoupled from the live `contacts` array reference.
- [x] **[FLOW] 4th Follow-Up Queue card collides with the floating search bar** (see global finding) — first thing a user sees is a half-hidden card.

## Directory

- [x] **[COLOR] Tier badges uncolored** (see global finding).
- [ ] **[TYPE] Contact card summary uses Markdown renderer for a one-line AI summary** — for short single-sentence summaries this is overkill and can produce odd block spacing; a plain-text line is simpler and safer against off-target Markdown syntax the AI might emit.
- [x] **[FLOW] "Clear Directory" and "Import CSV" use native `window.confirm`/`alert`** instead of the app's own modal language.

## Network Graph (the demo "wow" screen)

Overall this screen is already excellent — token-matched industry colors, radial layout, live detail panel, cluster intelligence, gap analysis. Treat as high-leverage, not high-risk.

- [ ] **[TYPE] Center "you" node shows "Y"** when no profile name is set — reads oddly for a demo. Should default to a friendlier glyph/label when profile name is empty.
- [ ] **[COLOR] Network Strength maxes at a flat 100** with the current seed density (all outreach clustered in the last ~10 days) — looks less credible than a good-but-imperfect score. Will age a couple of seed interactions further back for realism.
- [ ] **[MOTION] Hover-to-highlight-connections works but has no transition** — instantaneous alpha snap for faded vs. active nodes/links; a short ease would read as more "alive" per the prime directive.
- [ ] **[STATE] Tooltip/detail card on node hover doesn't exist — only click.** A lightweight hover tooltip (name + tier) before committing to a click would match the "polished tooltip" bar set in the brief.

## Tracker (Sheet / Queue / Recruiting / Firm / Industry / Timeline)

- [x] **[RESPONSIVE] Tab bar clipping at 1024px** (see global finding).
- [ ] **[FLOW] Sheet/Firm/Industry tables have no horizontal-scroll affordance.** At 1024px several columns (Response, Meeting, Next Action, AI Summary) are pushed off-screen with no gradient/shadow hinting the table scrolls.
- [x] **[TYPE] Timeline view shows negative "days ago" for future dates** — `formatRelativeDays` doesn't branch on future vs. past, so an upcoming meeting 4 days out renders "-3 days ago" (sign flips due to rounding) instead of "in 4 days" / "Upcoming".
- [x] **[COLOR] Tier chips next to names uncolored** (same global issue, visible again in Sheet/Firm/Industry/Recruiting).
- [ ] **[STATE] Recruiting pipeline columns have no scroll snap / column count indicator** beyond the header count badge — acceptable, low priority.

## Contact Detail

- [x] This screen is close to done: AI-labeled tabs (sparkle icon on Process Reply / Add AI Tags — good disclosure pattern already), clean modal, good timeline. Only minor items:
- [ ] **[MOTION] Tab switching has no transition** (instant content swap) — a quick fade would smooth it.
- [ ] **[STATE] "Draft Outreach AI" clarifying questions are hardcoded, static text inputs** — fine functionally, but per Shape-of-AI "Wayfinders/Prompt details" patterns, showing *why* each question matters (or letting the AI skip ones already answered by notes) would feel more considered. Lower priority — functional as-is.

## Outreach Calendar

- [ ] **[STATE] Empty days have no visual distinction from days with items** beyond the item chip itself — fine, low priority.
- [x] **[FLOW] Search bar overlap again** at the bottom of the grid on shorter viewports.

## Templates

- [x] **[STATE] Empty state is a plain dashed box with text only** — no icon, no inline "New Template" CTA, breaking the "icon + one line + CTA" empty-state standard used as the bar for this pass.
- [x] **[FLOW] Delete uses `window.confirm`** (global finding, repeated here).

## Settings

- [x] **[COLOR/TYPE] Native `<input type=file>` renders unstyled** inside an otherwise fully custom-styled form — visually clashes (OS chrome bleeding into a bordered, tokenized layout).
- [x] **[STATE] Save uses `alert('Settings saved!')`** instead of a toast.
- [ ] **[FLOW] No loading skeleton while profile fetches** — briefly shows plain "Loading..." text; acceptable but could match the rest of the app's tone.

## Auth / Landing

- [x] **[FLOW] Email/password sign-in is disabled at the Firebase project level**, but the signup/login form is shown as the primary path with Google buried as a secondary option and only surfaces the real reason via a raw Firebase error string after a failed submit. Either lead with Google (primary, working path) or clarify email/password status before the user hits an error. *(Environment-level; documented in the report — see there for what was/was not touched.)*
- [ ] **[TYPE] Landing hero renders in Inter, not the Playfair serif used everywhere else in-app** — intentional-looking contrast for marketing copy; left as-is, flagged for awareness only.

## Help & Tours

- [x] **[TYPE] Grammar: "1 steps"** instead of "1 step" for the Natural Language Search tour card (no singular/plural branching).
- [x] Tour system (react-joyride) is already fully built across 6 flows — just needs the visual polish pass applied consistently (transitions, spacing) rather than being built from scratch.

## Responsive (1440 / 1024 / 768)

- [x] 768px: 4-column metric-card rows (Network Graph, Tracker Queue/Timeline) become cramped; text wraps awkwardly inside ~170px cards. Breakpoint should shift from `md:` to `lg:` for these grids, or drop to 2 columns below `lg`.
- [x] 768px: sidebar remains fixed-width and always visible, consuming ~35% of a 768px viewport permanently — no responsive auto-collapse.
- [ ] 768px: floating search bar's `left-8 right-8` margins combined with fixed padding leave very little room for the input on narrow widths — acceptable but tight.

---

*Audit performed via headless Edge + Puppeteer against a local Firebase emulator seeded with 15 contacts across 7 industries, notes, and mixed outreach states (see `POLISH_REPORT.md` for methodology and why the emulator was used instead of the live backend).*
