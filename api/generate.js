import { Readable } from "node:stream";

// Vercel serverless function — the production equivalent of server.js.
// Forwards the browser's request body to the Anthropic Messages API, injecting
// the API key (which lives only in a Vercel Environment Variable, never in the
// browser), then returns the response unchanged. Mounted at /api/generate.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. Use POST." });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res
      .status(500)
      .json({ error: "ANTHROPIC_API_KEY is not set. Add it in your Vercel project's Environment Variables." });
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
