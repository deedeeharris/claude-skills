---
name: frontend-visual-qa
description: Use when a frontend development phase is complete and needs visual verification. Triggers on any browser-based project (React, Vue, Next.js, Angular, plain HTML) after building screens, completing a spec section, or when visual regressions need catching. Runs fully autonomous by default.
---

# Frontend Visual QA

## Overview

Autonomous visual QA loop for any browser-based frontend. Captures screenshots at 3 viewports (mobile/tablet/desktop), reads console + network, runs vision subagent analysis against spec, fixes issues, and iterates until all screens are clean.

**Autonomous by default** — runs start to finish without asking. Stops only if it cannot start a dev server. Add `interactive=true` to pause for review between sections.

## Invocation

```
/frontend-visual-qa                        # full autonomous run
/frontend-visual-qa section=auth           # one section only
/frontend-visual-qa phase=capture          # screenshots only, no fixes
/frontend-visual-qa interactive=true       # pause after each section
/frontend-visual-qa routes=/login,/home    # override route list
```

---

## Pre-flight (always runs first)

### Step 1 — Playwright check + install

```bash
npx playwright --version 2>/dev/null
```

If exit ≠ 0:
```bash
# If package.json exists:
npm install --save-dev @playwright/test@latest
# If no package.json:
npm install -g @playwright/test@latest
npx playwright install chromium
```

If chromium not installed:
```bash
npx playwright install chromium
```

### Step 2 — Dev server detection

**ALWAYS detect the live port. Never assume or reuse a port from memory or config without verifying it is currently responding.**

> The machine may be running several React/Vite projects at once, each on a different port. The skill must identify the port that belongs to *this* project's directory specifically.

#### 2a — Find ports owned by this project (primary method)

Get the current project root, then find the node process whose working directory matches it:

```bash
PROJECT_ROOT=$(pwd)

# On Linux: check /proc/<pid>/cwd for each node process
for pid in $(pgrep -x node 2>/dev/null); do
  cwd=$(readlink -f /proc/$pid/cwd 2>/dev/null)
  if [[ "$cwd" == "$PROJECT_ROOT"* ]]; then
    # Find which port this pid is listening on
    ss -tlnp 2>/dev/null | grep "pid=$pid" | grep -oE ':[0-9]+' | grep -oE '[0-9]+$'
  fi
done
```

If a port is found this way, **use it directly** — it is the correct port for this project.

#### 2b — Fallback: match by project name in process args

If `/proc` is unavailable or returned nothing:

```bash
PROJECT_NAME=$(basename "$PROJECT_ROOT")
# Look for a node process whose command line contains the project path or name
lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null \
  | awk '{print $2, $9}' \
  | while read pid port; do
      args=$(ps -p "$pid" -o args= 2>/dev/null)
      if echo "$args" | grep -q "$PROJECT_ROOT"; then
        echo "$port" | grep -oE '[0-9]+$'
      fi
    done
```

#### 2c — Probe to verify (always required)

Take the candidate port from 2a/2b and verify it actually responds:

```bash
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:$PORT/ 2>/dev/null)
# Accept 200 or 304
```

If the candidate doesn't respond, fall back to probing the standard list `5173, 3000, 5000, 8080, 8000, 4200, 4000` — but only use a port from this list if *no other project's process* owns it (check via /proc or lsof before accepting).

> **If `qa-config.json` has a `baseUrl` field, verify it is currently responding AND that the port belongs to this project before trusting it.** A stale or wrong-project port must be ignored.

#### 2d — Start server if none found

If no matching server found → read `package.json` for `dev`/`start`/`serve` script → run it in background → poll until ready (max 30s).

If no `package.json` → `python3 -m http.server 8080 &` from project root.

**If still no server after 30s → STOP. Report to user: cannot start server.**

All other failures → log in report, continue.

### Step 3 — Route discovery

Try in order, first that works wins:

1. `qa-config.json` in project root → use `routes` array
2. Scan `App.jsx`/`App.tsx` for `path ===` / `path.startsWith(` patterns (hash router)
3. Scan for `<Route path=` (React Router v6)
4. Walk `app/` or `pages/` directory (Next.js)
5. Spider `<a href>` links from homepage (plain HTML / multi-page)
6. Fallback: `["/"]`

### Step 4 — Spec discovery

```bash
find . -name "*.md" -not -path "*/node_modules/*" | xargs grep -l -i "section\|screen\|wireframe\|prd\|design spec" 2>/dev/null | head -5
```

Also check: `uploads/`, `docs/`, `plans/` directories.

Use most recently modified match. If none → `SPEC_FOUND=false` (pure visual audit, no checklist).

### Step 5 — Write playwright.config.js (non-destructive — skip if exists)

```js
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 20_000,
  fullyParallel: true,
  retries: 1,
  reporter: [['list'], ['json', { outputFile: 'tests/qa/results.json' }]],
  use: {
    baseURL: '__BASE_URL__',
    headless: true,
    screenshot: 'on',
  },
  projects: [
    { name: 'mobile',  use: { viewport: { width: 390,  height: 844  } } },
    { name: 'tablet',  use: { viewport: { width: 768,  height: 1024 } } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 800  } } },
  ],
});
```

Replace `__BASE_URL__` with detected server URL.

Write capture script to `tests/qa-capture.spec.js` from `capture-template.js` in this skill directory, substituting discovered routes.

---

## Phase 1 — Spec Decomposition (skip if SPEC_FOUND=false)

Read the spec file in full. Extract per-route visual requirements into `tests/qa/checklists/<section>.json`:

```json
{
  "section": "home",
  "routes": ["/"],
  "checks": [
    { "id": "h1", "what": "quota pill visible in TopBar for public role" },
    { "id": "h2", "what": "creator grid is 2-col on mobile, 4-col on desktop ≥1024px" },
    { "id": "h3", "what": "sticky CTA bar always visible at top, uses accent color" }
  ]
}
```

One JSON file per section. This runs in the main session (not a subagent).

---

## Phase 2 — Parallel Capture

Dispatch **3 subagents in parallel** — one per viewport:

```
Subagent A: npx playwright test tests/qa-capture.spec.js --project=mobile  --reporter=json
Subagent B: npx playwright test tests/qa-capture.spec.js --project=tablet  --reporter=json
Subagent C: npx playwright test tests/qa-capture.spec.js --project=desktop --reporter=json
```

Each subagent navigates every route, waits for `networkidle`, captures full-page screenshot, collects console errors + network failures, writes:
- `tests/qa/screenshots/<label>/<viewport>.png`
- `tests/qa/reports/<label>-<viewport>.json`

---

## Phase 3 — Visual Analysis

Dispatch **1 vision subagent per route** — all in parallel.

Each subagent receives:
- `tests/qa/screenshots/<label>/mobile.png`
- `tests/qa/screenshots/<label>/desktop.png`  
- `tests/qa/screenshots/<label>/tablet.png`
- Checklist for this route (from Phase 1, or generic check if no spec)
- Token/variable file contents if found (`tokens.css`, `theme.js`, `variables.scss`, Tailwind config)

**Prompt:**
```
You are a UI QA reviewer for a [RTL Hebrew / LTR English] web app.

[If spec]: Evaluate each checklist item: PASS or FAIL with specific description.
Also flag any visual bugs not in the checklist.

[If no spec]: Check for broken layout, overflow, invisible text, overlapping elements,
missing images, wrong alignment, inconsistent spacing, [RTL issues if applicable].

Check BOTH mobile and desktop screenshots. Note viewport-specific issues.

Respond as JSON:
{
  "route": "/login",
  "issues": [
    { "id": "h2", "viewport": "mobile", "status": "FAIL",
      "description": "Grid shows 1 column, spec requires 2 columns at 390px" }
  ],
  "console_errors": ["..."],
  "network_failures": ["..."],
  "clean": false
}
```

Collect all responses → write `tests/qa/analysis/summary.json`.

---

## Phase 4 — RTL Audit (skip if `<html dir="rtl">` not in index.html)

```bash
grep -rn \
  "margin-left:\|margin-right:\|padding-left:\|padding-right:\|text-align: left\|text-align: right\|float: left\|float: right\|position.*left:\|position.*right:" \
  src/ --include="*.jsx" --include="*.tsx" --include="*.css" --include="*.scss" \
  2>/dev/null > tests/qa/rtl-raw.txt
```

Dispatch 1 subagent: reads `rtl-raw.txt`, removes false positives (shadows, borders that are intentionally directional), writes `tests/qa/rtl-issues.json`.

---

## Phase 5 — Token Compliance (skip if no token file found)

```bash
grep -rn \
  "#[0-9a-fA-F]\{3,8\}\b\|rgb(\|rgba(\|hsl(\|hsla(" \
  src/ --include="*.jsx" --include="*.tsx" --include="*.css" \
  2>/dev/null > tests/qa/hardcoded-colors.txt
```

Dispatch 1 subagent: cross-references against token file, filters legitimate uses (box-shadow rgba, SVG fills), writes `tests/qa/token-violations.json`.

---

## Phase 6 — Interactive States

Identify interactive flows: scan spec for "generate", "submit", "flow", "step", multi-screen sequences. Also scan for `onSubmit`/`handleGenerate` in source. Pick top 6–12 flows.

Dispatch **1 Playwright subagent per flow** — all in parallel.

Each subagent:
1. Navigates to screen
2. Fills inputs with test data → clicks primary CTA
3. Waits for result/output state (up to 8s for mocked APIs)
4. Captures screenshot of result
5. Runs vision analysis: "does the result state look correct per spec?"

Writes `tests/qa/interactive/<flow>.json` with screenshot path + verdict.

---

## Phase 7 — Cross-Viewport Consistency

Dispatch **1 subagent per route** — all in parallel.

Each receives all 3 viewport screenshots for its route. Checks:
- Correct responsive breakpoints (layout changes at right widths)
- No overflow at any viewport
- Mobile-only elements appear/disappear correctly
- Text readable at all sizes
- No elements hidden that should be visible

---

## Phase 8 — Fix Dispatch

Aggregate all issues from Phases 3–7 → group by source component file.

Dispatch **1 fix subagent per affected file** — all in parallel.

Each fix subagent:
1. Reads the component file
2. Reads all issues assigned to it
3. Reads relevant spec section + tokens file
4. Applies targeted fixes (CSS tokens, layout, RTL logical properties)
5. Returns: `{ "file": "...", "fixed": [...], "status": "fixed|needs-review" }`

---

## Phase 9 — Re-verify Loop

After fixes:
1. Re-run Phase 2 for affected routes only
2. Re-run Phase 3 for those routes
3. Any issues remaining?
   - **Clean** → Final Report
   - **Issues remain, iteration < maxIterations (default 3)** → repeat Phase 8
   - **Issues remain, iteration = maxIterations** → flag "needs manual review" in report → Final Report

---

## Autonomous Decision Table

The skill never asks the user except when dev server cannot be started.

| Situation | Decision |
|---|---|
| Multiple spec files found | Use most recently modified |
| Route returns 404 | Skip, note in report |
| Fix subagent returns needs-review | Log in report, move on |
| Console warning (not error) | Log only, don't fix |
| Vision says UNSURE | Log as warning, not failure |
| Playwright test times out | Retry once, skip + log |
| No spec found | Pure visual audit, no checklist |
| No token file found | Skip Phase 5 |
| `<html>` not RTL | Skip Phase 4 |
| maxIterations reached | Flag for manual review, finish |

---

## Final Report

Write `tests/qa/FINAL-REPORT.md`:

```markdown
# Visual QA Report — <project> — <date>

## Summary
✅ N checks passed | ⚠ N warnings | ❌ N open (manual review needed) | 🔁 N iterations ran

Viewports: mobile 390px · tablet 768px · desktop 1280px
Spec: <spec file used or "none — pure visual audit">

## By screen
| Screen       | Mobile | Tablet | Desktop | Console | Network |
|-------------|--------|--------|---------|---------|---------|
| /           | ✅     | ✅     | ✅      | ✅      | ✅      |
| /login      | ✅     | ⚠      | ✅      | ✅      | ✅      |

## Fixed this run
- Home.jsx: hardcoded #1a1a1a → var(--color-text)
- BottomTabs.jsx: margin-right → margin-inline-end

## Needs manual review
- /login tablet: RTL alignment on error message — vision unsure after 3 iterations
  Screenshot: tests/qa/screenshots/auth-login/tablet.png

## Screenshots
tests/qa/screenshots/
```

If in a git repo with uncommitted changes → commit:
```bash
git add src/ tests/qa/FINAL-REPORT.md
git commit -m "fix(visual-qa): <date> — N issues fixed across N screens"
```

---

## qa-config.json (optional — place in project root)

```json
{
  "baseUrl": "http://localhost:5173",
  "routes": [
    { "path": "/",      "label": "home" },
    { "path": "/login", "label": "auth-login" }
  ],
  "spec": "docs/design-spec.md",
  "tokens": "src/styles/tokens.css",
  "maxIterations": 3,
  "interactive": false,
  "skipPhases": []
}
```

All fields optional. Any missing field is auto-detected.

> **`baseUrl` is never trusted blindly.** Even when set, Step 2 verifies it responds live before using it. If the port is stale or the server has restarted on a different port, the live-detected URL wins.
