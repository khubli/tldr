# Design brief: the morning broadsheet

tldr is a **newspaper printed for one reader**. Every morning there's a new edition; the reader's saves are the wire copy, and the agent is the editor who decides what runs, what's cut and what to act on.

## The feel
Newsprint, ink and hairline rules. Calm, dense, confident. It should look like it was typeset, not generated.

## Typography
Newspaper type for what you **read**; a plain sans for what you **scan or tap**. (Revised 6 Nov 2026: letter-spaced typewriter caps on every label were hard to read on a phone.)
- **Masthead:** blackletter, used only for the paper's name ("The tl;dr"). Example: UnifrakturMaguntia.
- **Headlines:** a sturdy text serif, semibold (Source Serif 4, 600–700). Avoid hairline display serifs at small sizes.
- **Body:** a readable text serif at a comfortable mobile size (Source Serif 4, 18px, line height about 1.55).
- **Section bar, kickers, labels, bylines, buttons:** IBM Plex Sans, 14–15px, normal case, no letter-spacing. Write buttons as plain verbs that say what happens ("Snooze 3 days").
- **The dateline only:** IBM Plex Mono caps, small. Rubber stamps (DONE, SPIKED) keep mono caps too.
- Secondary text in a dark grey that passes 4.5:1 contrast on the paper; no long italic lines.
- No Inter, no system UI font, no rounded geometric sans.

## Colour
- Day edition: newsprint `#F3EFE6`, ink `#141310`, grey rules `#8A857A`.
- Night edition (dark mode): paper `#16140F`, ink `#E9E3D6`.
- **One spot colour only:** sindoor red `#C2362B`, for SPIKED stamps, kickers and the active action.
- No gradients, shadows, glass, purple, or emoji.

## Layout
- Masthead with double rule under it, the short date beside the paper's name.
- **Section bar** directly under the masthead, on every page, in the same place: `Desk 2 · Reading 14 · Morgue 3 · + Add`. The current section is in ink with a heavy underline. It sticks to the top while scrolling. Nothing a reader needs should be reachable only from a footer or a "more" link.
- Mobile: one column with hairline column rules between items. Desktop: three columns of newspaper type.
- Square corners everywhere. Separation comes from rules and whitespace, never cards.
- Drop cap on the lead story.

## Sections of each edition
1. **Front page:** the top 3 stories of the day (highest value to the reader). Headline, 2–3 line TLDR, a "Why it matters to you" line in italics, the action.
2. **The Desk:** the open action list (`try in ledger`, `read`, `post`…), with Done / Snooze / Drop as rubber-stamp buttons.
3. **Briefs:** short keeps, one or two lines each.
4. **Spiked:** a collapsed column of what was cut, struck through, each with a one-word reason (`hype`, `bait`, `repost`, `stale`, `basic`). Proof the editor did the work.
5. **Morgue:** the archive. Items untouched for 30 days drop here automatically.
6. **Sunday edition (weekly):** a "circulation" box with saved / kept / spiked / acted, and the week's slop ratio.
7. **Letters to the editor:** the settings page, where me.md is edited.

## Details that make it feel real
- Bylines: the source and author ("By @handle, via X").
- Datelines: when it was saved ("SAVED 3 DAYS AGO").
- Thumbnails rendered as halftone (CSS filter + dot pattern), never glossy.
- Pull quotes for one strong line per long piece.
- "Continued on Desk" jump lines instead of "see more" buttons.

## Anti-AI checklist (before any UI merge)
- [ ] No card grid, no rounded corners, no drop shadows
- [ ] No gradient or purple anywhere
- [ ] No emoji in the UI
- [ ] Typography does the hierarchy, not colour or boxes
- [ ] Every section is one tap away from the section bar
- [ ] No label smaller than 14px, no letter-spaced caps outside the dateline and stamps
- [ ] Spot red used in fewer than 5 places per screen
- [ ] A screenshot could pass for a printed page at a glance
