# Agent Blueprint Builder

Maps one business workflow into the structural blueprint of a real enterprise AI agent — what it would need to reach, understand, respect, and do — without faking any of your data.

A React + Vite UI. The Anthropic API key is held server-side and proxied, so it never touches the browser — by a small Express server locally, and by a serverless function in production.

---

## Try it live

> **Live URL:** _add your deployed link here once it's up_

No setup needed — just open the link, pick a workflow, and generate a blueprint.

---

## Run it locally

### 1. Install

```bash
npm install
```

### 2. Add your API key

```bash
cp .env.example .env
```

Open `.env` and set your key (get it from https://console.anthropic.com):

```
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Run

```bash
npm run dev
```

This starts the Express proxy and the Vite dev server together. Open: http://localhost:5173

---

## Deploy (Vercel)

The repo is deploy-ready for [Vercel](https://vercel.com) with zero config:

1. Push this repo to GitHub.
2. In Vercel, **Add New → Project** and import the GitHub repo. Vercel auto-detects Vite (build: `vite build`, output: `dist`).
3. Under **Settings → Environment Variables**, add `ANTHROPIC_API_KEY` with your key. **Do not** commit the key — `.env` is gitignored.
4. Deploy. The frontend is served statically and `/api/generate` runs as a serverless function.

> Note: every blueprint generation calls the Anthropic API using **whatever key is set on the deployment** — so that account is billed for all visitors' usage.

---

## How it works

- `src/AgentBlueprintBuilder.jsx` — the UI. Its `generateBlueprint` function POSTs to `/api/generate`.
- `src/agentPrompt.js` — the system prompt and user-message builder (the actual product).
- `vite.config.js` — proxies `/api` to the Express server during local development.
- `server.js` — local proxy: reads `ANTHROPIC_API_KEY` from `.env` and forwards to `https://api.anthropic.com/v1/messages`.
- `api/generate.js` — the production equivalent of `server.js`, run as a Vercel serverless function. Same logic, key read from a Vercel Environment Variable.
