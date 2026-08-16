import { Readable } from "node:stream";

// Vercel serverless function — the production equivalent of server.js.
// Forwards the browser's request body to the Anthropic Messages API, injecting
// the API key (which lives only in a Vercel Environment Variable, never in the
// browser), then returns the response unchanged. Mounted at /api/generate.
// Best-effort per-IP throttle. In-memory, so it resets on a cold start and a
// true cap needs a shared store — but it stops a script hammering this on
// Blake's key, which is the shape of spend that got the org's API access cut
// off on 8/15.
const HITS = new Map();
const RATE_LIMIT = 8;
const RATE_WINDOW_MS = 60_000;

function rateLimited(ip) {
  const now = Date.now();
  const recent = (HITS.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  HITS.set(ip, recent);
  if (HITS.size > 5000) HITS.clear();
  return recent.length > RATE_LIMIT;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. Use POST." });
    return;
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    res.status(429).json({ error: "Too many requests. Wait a minute." });
    return;
  }

  // No key is a DELIBERATE state, not a misconfiguration: pulling the env var
  // in Vercel is how this demo is switched off so public traffic cannot spend
  // Blake's key. It used to answer a 500 telling the visitor to go add an
  // environment variable, which reads as broken and is addressed to the wrong
  // person entirely — a recruiter opened this, not a developer.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "This demo is turned off.", paused: true });
    return;
  }

  // The key is Blake's, so the caller does not get to pick the model or the
  // token count. Everything expensive is pinned here; only the conversation
  // itself comes from the browser, and it has a size ceiling.
  const MODEL = "claude-sonnet-4-6";
  const MAX_TOKENS = 8000;
  const MAX_BODY_CHARS = 60000;

  const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!messages) {
    res.status(400).json({ error: "Expected a messages array." });
    return;
  }
  if (JSON.stringify(messages).length > MAX_BODY_CHARS) {
    res.status(413).json({ error: "Request too large." });
    return;
  }

  const payload = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages,
    ...(typeof req.body?.system === "string"
      ? { system: req.body.system.slice(0, 20000) }
      : {}),
    ...(req.body?.stream ? { stream: true } : {}),
  };

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // Streaming request: pipe the Server-Sent Events stream straight through to
    // the browser so it can render tokens as they arrive. On an upstream error
    // the body is JSON, not SSE, so forward it as JSON with the right status.
    if (req.body?.stream) {
      if (!upstream.ok) {
        const errBody = await upstream.text();
        res.status(upstream.status).setHeader("Content-Type", "application/json");
        res.send(errBody);
        return;
      }
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      Readable.fromWeb(upstream.body).pipe(res);
      return;
    }

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(502).json({ error: "Failed to reach the Anthropic API." });
  }
}
