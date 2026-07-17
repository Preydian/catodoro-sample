# catodoro - code sample

[![CI](https://github.com/Preydian/catodoro-sample/actions/workflows/ci.yml/badge.svg)](https://github.com/Preydian/catodoro-sample/actions/workflows/ci.yml)

Three modules pulled out of **catodoro**, my pomodoro timer that pays you in cats: finish a focus session, earn a collectible cat that lives on your desk as a physics toy you can drag, throw, and pile up while you work. The full app is React + TypeScript + Supabase, plus a Chrome extension that shares the timer logic. I built it solo, using AI heavily and reviewing everything that ships. It's live at [catodoro.vercel.app](https://catodoro.vercel.app) - no account needed.

The main repo is private, so this repo holds the pieces that stand on their own. Pure logic was a deliberate choice over, say, an endpoint or a data-fetching component: code like that needs the database and services around it to make sense, while these modules and their tests read and run anywhere. **Start with [`src/components/useCanvas.ts`](src/components/useCanvas.ts)** - the touch gesture handling is the interesting part.

## What's here

- [`src/components/useCanvas.ts`](src/components/useCanvas.ts) - the desktop canvas camera. Space+drag pan, cursor-anchored wheel zoom that snaps to Chrome's zoom levels, pinch zoom that re-baselines as fingers join and lift, and a fly-to animation that hands control back the moment you grab the canvas. The camera math is pure functions, exported next to the hook.
- [`src/components/offscreenIndicators.ts`](src/components/offscreenIndicators.ts) - the edge arrows that point at notes scrolled out of view. A ray from the viewport center places each arrow on the edge; nearby arrows merge via greedy clustering, with headings averaged as unit vectors to dodge the -π/π seam. Pure geometry, no DOM.
- [`src/lib/timerCore.ts`](src/lib/timerCore.ts) - the pomodoro state machine shared by the web app and the extension's service worker. It stores a wall-clock target instead of ticking, so the countdown survives reloads and machine sleep without drifting, and every transition is a pure function, which is what keeps the two runtimes in lockstep.

Tests sit next to each module (`*.test.ts`); the camera math and timer logic are tested as plain pure functions.

## Provenance

The three modules, their tests, and `src/lib/durations.ts` / `src/lib/breakpoints.ts` are byte-for-byte copies from the main repo. The other four files are small stubs standing in for app modules these ones import, each marked with a `Sample-repo stub` comment: [`physics/colliders.ts`](src/components/physics/colliders.ts), [`StickyNote.ts`](src/components/StickyNote.ts), [`notesUtils.ts`](src/components/notesUtils.ts), [`storage.ts`](src/lib/storage.ts).
