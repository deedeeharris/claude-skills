---
name: firebase-html-deploy
description: |
  Deploy a self-contained HTML file to Firebase Hosting with HMAC token-gated access.
  Pages are stored in Firebase Storage (GCS) and served by a Cloud Function.
  Access URLs include a derived token so pages aren't publicly indexable.
  Use this skill when asked to: deploy HTML to Firebase, share a page as a live link,
  host an interactive dashboard/page, or set up Firebase HTML hosting.
  Two phases: SETUP (one-time per project) and DEPLOY (per page).
---

# Firebase HTML Deploy Skill

## What this builds

- HTML files deployed to Firebase Storage (GCS)
- Served by a Cloud Function at `/pages/<namespaceToken>/<deployId>/`
- Each URL includes a short HMAC token (`?t=...`) — not secret, just obscures guessability
- Open CSP so pages can call external APIs (Gemini, etc.)
- Free tier (Firebase Spark): ~1000 pages before storage concerns

## Phases

- **SETUP** — Run once per Firebase project. Creates the Cloud Function, Storage rules, Hosting config.
- **DEPLOY** — Run per page. Uploads HTML and returns two URLs (unique + latest).

---

## PHASE 1: SETUP (one-time)

### Prerequisites

```bash
# Check you have these installed:
node --version      # need 20+
firebase --version  # need 13+; install: npm install -g firebase-tools
python --version    # need 3.10+
pip install -r ~/.claude/skills/firebase-html-deploy/files/requirements.txt
# or: uv pip install -r ~/.claude/skills/firebase-html-deploy/files/requirements.txt
```

### Step 1.1 — Create Firebase project

1. Go to https://console.firebase.google.com → "Add project"
2. Name it (e.g. `my-html-pages`). Disable Google Analytics (not needed).
3. After creation, note the **Project ID** (shown in project settings, e.g. `my-html-pages-abc12`)

### Step 1.2 — Enable Firebase services

In Firebase Console for your project:
1. **Storage** → "Get started" → choose region (us-central1 recommended) → Done
2. **Hosting** → "Get started" → follow prompts → Done
3. **Functions** → (auto-enabled when you deploy)

### Step 1.3 — Create service account

In Google Cloud Console → IAM & Admin → Service Accounts:
1. Create service account named `firebase-deploy-sa`
2. Grant role: **Storage Object Admin** (`roles/storage.objectAdmin`) — that is the only role `deploy.py` needs. The Firebase CLI deploy (Step 1.8) uses your own logged-in credentials, not this SA.
3. Create key → JSON → download as `sa-key.json`

Keep `sa-key.json` secret. Never commit it to git.

### Step 1.4 — Generate TOKEN_SALT

```bash
openssl rand -hex 32
# Example output: a3f8c2d9e1b74056f2a8c3e7d9b1f4a80c2e7d3b9a5f8c1e4d7b2a6f9c3e8d1
```

Save this value. It's the master secret — tokens are derived from it. If you change it, all existing URLs break.

### Step 1.5 — Create project directory

```bash
mkdir my-firebase-pages && cd my-firebase-pages
firebase login
firebase init
# Select: Hosting, Storage, Functions
# Use existing project → select your project ID
# Functions: JavaScript, no ESLint, don't install deps yet
```

### Step 1.6 — Replace generated files with skill templates

Replace `functions/index.js` with:

```javascript
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
setGlobalOptions({ region: "us-central1" });

const ACCESS_DENIED_HTML = `<!DOCTYPE html>
<html><head><title>Access Denied</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#f8f8f8}
.box{text-align:center;padding:2rem;background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
h1{color:#d32f2f;margin:0 0 .5rem}p{color:#666}</style></head>
<body><div class="box"><h1>Access Denied</h1><p>Invalid or missing access token.</p></div></body></html>`;

const PATH_RE = /^\/pages\/([a-f0-9]{12})\/([\w-]+)\/?(?:index\.html)?$/;

function validateToken(namespaceToken, accessToken, salt) {
  const expected = crypto
    .createHmac("sha256", salt)
    .update(namespaceToken)
    .digest("hex")
    .slice(0, 16);
  if (expected.length !== accessToken.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(accessToken, "utf8")
  );
}
module.exports.validateToken = validateToken;

exports.servePage = onRequest(
  { timeoutSeconds: 10, memory: "128MiB" },
  async (req, res) => {
    const match = req.path.match(PATH_RE);
    if (!match) { res.status(404).send("Not found"); return; }

    const [, namespaceToken, deployId] = match;
    const token = req.query.t || "";
    const salt = process.env.TOKEN_SALT;
    if (!salt) { res.status(500).send("Server configuration error"); return; }

    if (!validateToken(namespaceToken, token, salt)) {
      res.status(403).send(ACCESS_DENIED_HTML);
      return;
    }

    const bucketName = process.env.GCS_BUCKET;
    if (!bucketName) { res.status(500).send("Server configuration error"); return; }

    const filePath = `pages/${namespaceToken}/${deployId}/index.html`;
    try {
      const [content] = await admin.storage().bucket(bucketName).file(filePath).download();
      res.set("Content-Type", "text/html; charset=utf-8");
      res.set("X-Robots-Tag", "noindex, nofollow");
      res.set("Cache-Control", "private, no-cache");
      res.set("Referrer-Policy", "no-referrer");
      res.send(content);
    } catch (err) {
      res.status(err.code === 404 ? 404 : 500).send(err.code === 404 ? "Page not found" : "Failed to load page");
    }
  }
);
```

Replace `functions/package.json` with:

```json
{
  "name": "firebase-html-deploy-functions",
  "engines": { "node": "20" },
  "main": "index.js",
  "scripts": { "test": "jest" },
  "dependencies": {
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^6.0.0"
  },
  "devDependencies": { "jest": "^29.0.0" },
  "private": true
}
```

Replace `firebase.json` with:

```json
{
  "hosting": {
    "public": "public",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "headers": [
      {
        "source": "/pages/**",
        "headers": [
          {
            "key": "Content-Security-Policy",
            "value": "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src *; img-src * data: blob:; style-src * 'unsafe-inline'; font-src * data:; script-src * 'unsafe-inline' 'unsafe-eval'; frame-src *;"
          }
        ]
      }
    ],
    "rewrites": [
      {
        "source": "/pages/**",
        "function": "servePage",
        "region": "us-central1"
      }
    ]
  },
  "storage": { "rules": "storage.rules" },
  "functions": { "source": "functions" }
}
```

Replace `storage.rules` with:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

### Step 1.7 — Create `functions/.env`

Find your Storage bucket name in Firebase Console → Storage → it looks like `<project-id>.firebasestorage.app`.

Create `functions/.env` (gitignore this file):

```
TOKEN_SALT=<your 64-char hex from Step 1.4>
GCS_BUCKET=<your-project-id>.firebasestorage.app
```

### Step 1.8 — Install Cloud Function deps and deploy

```bash
cd functions && npm install && cd ..
firebase deploy
```

This deploys Hosting + Storage rules + the Cloud Function. Takes ~2 minutes on first run.

> **Important:** `functions/.env` must be present in your project directory at deploy time — Firebase bundles it into the function. Do **not** deploy from a fresh clone without restoring this file first, or the function will return 500 ("Server configuration error") because `TOKEN_SALT` will be missing.

Verify in Firebase Console → Functions: `servePage` should appear with status "Healthy".

### Step 1.9 — Create `config.json` in the skill directory

Create `~/.claude/skills/firebase-html-deploy/config.json` (it's gitignored there):

```json
{
  "project_id": "<your-firebase-project-id>",
  "storage_bucket": "<your-project-id>.firebasestorage.app",
  "token_salt": "<your 64-char hex from Step 1.4>",
  "service_account_json": <paste the full contents of sa-key.json here as an object>
}
```

Add `functions/.env` to your Firebase project's `.gitignore`:

```
functions/.env
```

**SETUP is complete.** From now on, deploying a page is a single command from any project.

---

## PHASE 2: DEPLOY (per page)

### Requirements for the HTML file

- Must be **self-contained**: all CSS and JS inline, no external file references that won't work without the original server
- Data embedded as JS constants: `<script>const DATA = {...}</script>`
- External API calls (OpenWeatherMap, any REST API, etc.) are fine — CSP allows `connect-src *`
- Google Fonts are fine — `font-src *`
- No size limit enforced by the script, but keep under 5MB for reasonable load times

### Deploy command

```bash
python ~/.claude/skills/firebase-html-deploy/files/deploy.py \
  --config ~/.claude/skills/firebase-html-deploy/config.json \
  --namespace myproject \
  --html page.html \
  --title "My Dashboard"
```

Output:
```json
{
  "unique_url": "https://my-project.web.app/pages/a1b2c3d4e5f6/20260428-143022-ff1a2b/?t=6df482d39a6ff92e",
  "latest_url": "https://my-project.web.app/pages/a1b2c3d4e5f6/latest/?t=6df482d39a6ff92e"
}
```

- **`unique_url`** — permanent link to this exact version. Share this if you want a stable snapshot.
- **`latest_url`** — always points to the most recent deploy for this namespace. Share this for "live" updates.

### Namespace

`--namespace` is any string you choose (e.g. `john`, `myproject`, `dashboards`). It determines the URL path component and access token. Everyone using the same namespace + config gets the same token — so it's a lightweight "channel", not per-user auth.

### When to use unique vs latest URL

| Scenario | URL to share |
|----------|-------------|
| Iterating on a page, want recipients to always see newest | `latest_url` |
| Archiving a specific version (weekly report, snapshot) | `unique_url` |
| Both | Share both |

### Troubleshooting

**"Access Denied" page shows:**
- The `?t=` token in the URL was stripped or modified
- Wrong `TOKEN_SALT` in `config.json` vs `functions/.env`
- Verify: `python -c "import sys; sys.path.insert(0,'~/.claude/skills/firebase-html-deploy/files'); import deploy, json; cfg=json.load(open('~/.claude/skills/firebase-html-deploy/config.json',encoding='utf-8')); ns=deploy._namespace_token('myproject', cfg['token_salt']); print(deploy._access_token(ns, cfg['token_salt']))"`

**"Page not found" (404):**
- File wasn't uploaded to GCS. Check `config.json` bucket name matches `functions/.env` `GCS_BUCKET`.
- Check Firebase Console → Storage: the file should be at `pages/<namespaceToken>/<deployId>/index.html`

**Upload fails with auth error:**
- Service account JSON in `config.json` may be expired or missing the Storage Admin role
- Re-download the key from Google Cloud Console → IAM → Service Accounts

**Cloud Function cold start (slow first load):**
- Normal. Firebase Functions v2 on Spark tier cold-starts in ~2-3 seconds. Subsequent requests are fast.

---

## Token security model

| Token | How derived | Purpose |
|-------|-------------|---------|
| `namespaceToken` | `sha256(namespace + TOKEN_SALT)[:12]` | Stable, hard-to-guess path component. 12 hex chars = 48 bits of obscurity. |
| `accessToken` | `HMAC-SHA256(TOKEN_SALT, namespaceToken)[:16]` | Required query param. Cloud Function validates with timing-safe compare. |

**This is obscurity, not strong auth.** The URL contains the token, so anyone with the URL can view the page. Don't use this for truly sensitive data. Use it for: educational pages, team dashboards, generated reports shared within a trusted group.

The Cloud Function sets `Referrer-Policy: no-referrer` on every response so browsers won't include the tokenized URL in `Referer` headers when the page loads external resources (images, fonts, APIs). Without this header, the token would leak to third-party servers via the `Referer` header.
