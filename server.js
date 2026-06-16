import express from "express";
import dotenv from "dotenv";
import { Readable } from "node:stream";

dotenv.config();

const app = express();
const PORT = 8787;

app.use(express.json({ limit: "1mb" }));

// Single route. It forwards the browser's request body straight to the
// Anthropic Messages API, injecting the API key (which lives only on the
// server, never in the browser), then returns the response unchanged.
app.post("/api/generate", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "ANTHROPIC_API_KEY is not set. Add it to your .env file." });
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    // Streaming request: pipe the Server-Sent Events stream straight through to
    // the browser so it can render tokens as they arrive. On an upstream error
    // the body is JSON, not SSE, so forward it as JSON with the right status.
    if (req.body?.stream) {
      if (!upstream.ok) {
        const errBody = await upstream.text();
        res.status(upstream.status).type("application/json").send(errBody);
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
});

app.listen(PORT, () => {
  console.log(`Proxy server listening on http://localhost:${PORT}`);
});
