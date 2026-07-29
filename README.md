# agentic-browser

Headful, agentic browser controller. Real Chrome (not bundled Chromium) via a
persistent profile, so Chrome/Google Sync payment autofill works exactly like
it does for a normal signed-in user. Claude drives the page via a constrained
action schema over labeled elements — no raw selector guessing.

## Setup

```bash
npm install
npx playwright install chromium   # pulls the Chrome-for-Testing binary
export ANTHROPIC_API_KEY=your_key_here
```

## First run — sign into Google once

```bash
node agent.js "go to google.com"
```

A real Chrome window opens using the profile at `./chrome-profile`. Manually
sign into your Google account in that window (once). Chrome Sync will pull in
any saved payment methods. Close it — the session persists in `chrome-profile/`
for every future run. You never touch or store card data yourself; Chrome does.

## Run a task

```bash
node agent.js "search for wireless headphones under $100 on amazon.com and open the top result"
```

## How it works

- `labelElements.js` — injected into the page each step. Finds visible
  interactive elements, draws numbered overlays, returns a compact list like
  `[3] button "Add to cart"`. This is what the model reasons over — not a
  screenshot, not raw HTML.
- `agent.js` — the loop: get labeled elements → ask Claude for one action
  (tool-call, constrained to a fixed action enum) → execute it via Playwright
  → feed the result back → repeat, capped at `MAX_STEPS`.
- Action set is intentionally small: `click`, `type`, `navigate`, `scroll`,
  `accept_autofill`, `wait`, `done`. No freeform selector generation — that's
  the single biggest source of failure in agent browsers, so it's constrained
  out entirely.
- `accept_autofill` clicks the field then does Down+Enter to accept Chrome's
  first autofill suggestion, same as a human. The agent never sees or types
  card digits.

## Known limitations to test against your actual target sites

- Chrome's autofill heuristics don't recognize every checkout form's markup —
  it silently fails on some sites. Test early against sites you actually care
  about.
- Bot detection (Cloudflare, PerimeterX, Amazon) is why this runs headful —
  headless gets blocked far more often.
- `MAX_STEPS` is a hard stop at 25 to control cost; raise it for longer tasks.
- Every step is one Claude call. Long tasks get expensive — consider routing
  simple deterministic steps to a cheaper/faster model later.

## Next steps worth doing before this is production-grade

- Swap `tool_choice: { type: 'tool', name: 'browser_action' }` model call for
  a cheaper model on simple steps, Sonnet only for judgment calls.
- Add a screenshot fallback for elements the labeler misses (canvas-based UI,
  shadow DOM in some sites).
- Persist `messages` history to disk per task if you want resumability.
