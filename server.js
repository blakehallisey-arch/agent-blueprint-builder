import express from "express";
import dotenv from "dotenv";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

dotenv.config();

const app = express();
const PORT = 8787;

app.use(express.json({ limit: "1mb" }));

// METERING (Gus doctrine, 7/23): this local dev twin rides the Claude Code
// subscription via the `claude` CLI — zero marginal cost, no key needed. The
// metered pass-through survives only as a fallback when the CLI is missing
// (mirroring api/generate.js, the deployed Vercel function, which has no CLI).

function claudeBin() {
  const local = path.join(os.homedir(), ".local", "bin", "claude");
  if (fs.existsSync(local)) return local;
  return "claude";
}

function cliAvailable() {
  if (fs.existsSync(path.join(os.homedir(), ".local", "bin", "claude"))) return true;
  return (process.env.PATH || "").split(":").some((p) => fs.existsSync(path.join(p, "claude")));
}

function cliEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

// Fold an Anthropic Messages payload into {system, prompt} for claude -p.
function foldPayload(body) {
  let system = body.system || "";
  if (Array.isArray(system)) system = system.map((b) => b.text || "").join("\n\n");
  const turns = [];
  for (const m of body.messages || []) {
    let c = m.content;
    if (Array.isArray(c)) c = c.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (c) turns.push(`${m.role === "user" ? "User" : "Assistant"}: ${c}`);
  }
  let prompt = turns.join("\n\n") || "User: (empty)";
  prompt += "\n\nContinue as the Assistant. Reply with the assistant turn only.";
  return { system, prompt };
}

function callClaude(body) {
  return new Promise((resolve, reject) => {
    const { system, prompt } = foldPayload(body);
    const args = ["-p", "--output-format", "json", "--tools", "",
      "--model", body.model || "claude-sonnet-5"];
    if (system) args.push("--system-prompt", system);
    const child = spawn(claudeBin(), args, { env: cliEnv() });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("claude CLI timed out")); }, 180000);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude CLI exit ${code}: ${err.slice(0, 300)}`));
      try {
        const wrapper = JSON.parse(out);
        if (wrapper.is_error) return reject(new Error(JSON.stringify(wrapper).slice(0, 300)));
        resolve((wrapper.result || "").trim());
      } catch (e) { reject(new Error(`bad CLI output: ${e.message}`)); }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Emit a completed reply as one valid Anthropic-shaped SSE sequence so the
// browser's streaming parser works unchanged (it just gets one big delta).
function sendAsSSE(res, model, text) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  ev("message_start", { type: "message_start", message: { id: "cli", type: "message", role: "assistant", model, content: [], stop_reason: null } });
  ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  ev("content_block_stop", { type: "content_block_stop", index: 0 });
  ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } });
  ev("message_stop", { type: "message_stop" });
  res.end();
}

app.post("/api/generate", async (req, res) => {
  // Subscription CLI path (default).
  if (cliAvailable()) {
    try {
      const model = req.body?.model || "claude-sonnet-5";
      const text = await callClaude(req.body || {});
      if (req.body?.stream) return sendAsSSE(res, model, text);
      return res.status(200).json({
        id: "cli", type: "message", role: "assistant", model,
        content: [{ type: "text", text }], stop_reason: "end_turn",
      });
    } catch (err) {
      console.error("CLI error:", err.message);
      return res.status(502).json({ error: `claude CLI: ${err.message}` });
    }
  }

  // Metered fallback — the old straight pass-through (needs ANTHROPIC_API_KEY).
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "Neither the `claude` CLI nor ANTHROPIC_API_KEY is available. Log in to Claude Code (preferred) or add a key to .env.",
    });
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
  console.log(cliAvailable()
    ? "Generation rides the claude CLI (subscription, free)."
    : "!  claude CLI not found — falling back to metered ANTHROPIC_API_KEY.");
});
