import React, { useState } from "react";
import { SYSTEM_PROMPT, buildUserMessage } from "./agentPrompt.js";

/* ============================================================================
   AgentBlueprintBuilder
   A pre-integration "agent literacy" tool for Squid AI.
   Maps one workflow into the structural blueprint of a real enterprise agent,
   without faking agent output.

   The generation prompt — the actual product — lives in ./agentPrompt.js.

   PORTING NOTES (Claude Code):
   - The API layer below streams from /api/generate, a tiny server proxy that
     injects your ANTHROPIC_API_KEY. Point that route at your own proxy to port.
   - Everything else (state, components, styles) ports as-is.
============================================================================ */

/* ----------------------------------------------------------------------------
   2. THE API LAYER  (streams tokens, validates the shape, retries once)
---------------------------------------------------------------------------- */

// Strip markdown fences and parse. Throws on malformed JSON.
function parseBlueprint(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// Returns null if the object matches the expected schema, otherwise a short
// string naming the first problem. We only trust a response the UI can render.
function validateBlueprint(bp) {
  if (!bp || typeof bp !== "object") return "response was not an object";
  const w = bp.workflow;
  if (!w || typeof w !== "object") return "missing 'workflow'";
  for (const k of ["name", "pain", "trigger", "user_role"])
    if (typeof w[k] !== "string") return `workflow.${k}`;
  const hg = bp.homegrown_version;
  if (!hg || typeof hg.what_people_build !== "string" || typeof hg.looks_like !== "string" || !Array.isArray(hg.why_it_falls_short))
    return "homegrown_version";
  const b = bp.blueprint;
  if (!b || typeof b !== "object") return "missing 'blueprint'";
  for (const k of ["reach", "understand", "respect", "act"])
    if (!Array.isArray(b[k])) return `blueprint.${k}`;
  const v = bp.views;
  if (!v || typeof v.customer_summary !== "string" || !Array.isArray(v.partner_qualification) || typeof v.complexity_signal !== "string")
    return "views";
  return null;
}

// Lenient parser for the IN-PROGRESS stream only. Auto-closes open strings and
// brackets so we can show partial structure as it arrives. Never used for the
// final result (that goes through strict parseBlueprint + validateBlueprint).
function partialParse(raw) {
  let s = raw.replace(/```json|```/g, "");
  const start = s.indexOf("{");
  if (start === -1) return null;
  s = s.slice(start);
  let out = "";
  const stack = [];
  let inStr = false, esc = false;
  for (const c of s) {
    out += c;
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }
  if (inStr) out += '"';
  out = out.replace(/[:,]\s*$/, "").replace(/,\s*"[^"]*"\s*$/, "");
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === "{" ? "}" : "]";
  try { return JSON.parse(out); } catch { return null; }
}

// One streamed attempt. Reads the SSE stream from the proxy, accumulates the
// text deltas, and calls onProgress with the running text so the UI can render
// a live preview. Returns the full accumulated text.
async function streamOnce(inputs, onProgress) {
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      stream: true,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessage(inputs) }],
    }),
  });
  if (!res.ok) {
    let msg = `API ${res.status}`;
    try { const j = await res.json(); if (j?.error?.message) msg = j.error.message; } catch { /* keep status */ }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
        text += evt.delta.text;
        onProgress?.(text);
      } else if (evt.type === "error") {
        throw new Error(evt.error?.message || "The model stream errored.");
      }
    }
  }
  return text;
}

// Public entry point. Streams, then strictly parses and validates. If the
// response is truncated or off-schema, it retries once before giving up — the
// difference between a graceful recovery and a blank screen in front of a buyer.
async function generateBlueprint(inputs, onProgress) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    onProgress?.("");
    let text;
    try {
      text = await streamOnce(inputs, onProgress);
    } catch (e) {
      lastError = e;
      continue; // network/stream error — try once more
    }
    let bp;
    try {
      bp = parseBlueprint(text);
    } catch {
      lastError = new Error("The model returned malformed JSON (likely truncated).");
      continue;
    }
    const problem = validateBlueprint(bp);
    if (problem) {
      lastError = new Error(`The response was missing or malformed (${problem}).`);
      continue;
    }
    return bp; // valid — done
  }
  throw lastError || new Error("Generation failed.");
}

/* ----------------------------------------------------------------------------
   3. DESIGN TOKENS  (four layers = four quiet accents; continuity with prep)
---------------------------------------------------------------------------- */
// Palette borrowed from getsquid.ai's light theme: cool grey-blue canvas,
// white surfaces, deep navy, electric-blue brand, with teal / blue / purple /
// amber as the four layer accents.
const C = {
  ink: "#1d2228",       // grey-1000  (text1)
  sub: "#464e56",       // grey-800   (text2)
  faint: "#828a93",     // grey-500   (text3)
  line: "#e0e4e9",      // grey-300   (hairlines)
  lineSoft: "#f0f3f5",  // grey-200
  paper: "#ffffff",     // bg1 / cards
  surface: "#f5f8fa",   // grey-100   (canvas)
  navy: "#15212f",      // blue-800   (deep accent)
  reach: "#04c3c5",     // green-base (teal)
  understand: "#0f69ff",// blue-base  (brand)
  respect: "#9e62ff",   // purple-base
  act: "#b26a12",       // readable amber (Squid amber #ffb706, darkened for text)
  danger: "#eb0f29",    // fail1
  info: "#0f69ff",      // brand blue
};
const LAYER = {
  reach: { label: "Reach", sub: "what it connects to", color: C.reach },
  understand: { label: "Understand", sub: "relationships it models", color: C.understand },
  respect: { label: "Respect", sub: "boundaries it enforces", color: C.respect },
  act: { label: "Act", sub: "actions, with guardrails", color: C.act },
};

const SYSTEMS = ["Salesforce", "Zendesk", "Gainsight", "DocuSign", "Slack", "Snowflake", "ServiceNow", "Jira", "HubSpot", "Workday"];

const EXAMPLES = {
  renewal: {
    name: "Account renewal prep",
    pain: "Reps spend 30+ minutes prepping for each renewal call, pulling context from scattered tools and guessing at churn risk.",
    systems: ["Salesforce", "Zendesk", "Gainsight", "DocuSign"],
    userRole: "Account Executive",
    action: "Draft a renewal brief with account health, support risk, usage trend, and contract context",
    restrictions: "Never send external email, never change pricing, never expose legal terms to unauthorized users",
  },
  support: {
    name: "Support ticket triage",
    pain: "Support team spends 2 hours daily manually sorting and assigning tickets, missing urgent issues in noise.",
    systems: ["Zendesk", "Salesforce", "Slack"],
    userRole: "Support Manager",
    action: "Auto-route tickets to the right specialist based on urgency and expertise",
    restrictions: "Never close tickets automatically, never respond to customers directly",
  },
  sales: {
    name: "Sales lead qualification",
    pain: "Sales reps waste time chasing unqualified leads, burning cycles on accounts that can't buy.",
    systems: ["HubSpot", "Slack", "Workday"],
    userRole: "Sales Development Rep",
    action: "Qualify leads and flag accounts worth prospecting, with reasoning",
    restrictions: "Never delete leads, never change lead status without human review, never contact without approval",
  },
  compliance: {
    name: "Compliance audit",
    pain: "Quarterly compliance review involves manual spreadsheets and scattered doc audits across multiple systems.",
    systems: ["ServiceNow", "Snowflake", "Jira", "DocuSign"],
    userRole: "Compliance Officer",
    action: "Generate audit trail and flag gaps in SOC 2 controls",
    restrictions: "Never modify audit records, never delete findings, never expose confidential customer data",
  },
};

function loadExample(key) {
  const example = EXAMPLES[key];
  return {
    pain: example.pain,
    systems: example.systems,
    userRole: example.userRole,
    action: example.action,
    restrictions: example.restrictions,
  };
}

/* ----------------------------------------------------------------------------
   4. COMPONENTS
---------------------------------------------------------------------------- */
const font = `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
const display = `"Space Grotesk", Inter, -apple-system, BlinkMacSystemFont, sans-serif`;

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: C.ink, marginBottom: 2 }}>{label}</label>
      {hint && <div style={{ fontSize: 12, color: C.faint, marginBottom: 8 }}>{hint}</div>}
      {children}
    </div>
  );
}

const inputStyle = {
  width: "100%", boxSizing: "border-box", fontFamily: font, fontSize: 14, color: C.ink,
  background: C.paper, border: `1px solid ${C.line}`, borderRadius: 12, padding: "11px 14px", outline: "none",
};

function DiscoveryForm({ inputs, setInputs, onGenerate, loading }) {
  const toggleSystem = (s) =>
    setInputs((p) => ({ ...p, systems: p.systems.includes(s) ? p.systems.filter((x) => x !== s) : [...p.systems, s] }));

  return (
    <div>
      <Field label="What's one workflow that wastes your team's time?" hint="One painful, specific thing. Start here.">
        <textarea style={{ ...inputStyle, minHeight: 70, resize: "vertical", lineHeight: 1.5 }}
          value={inputs.pain} onChange={(e) => setInputs((p) => ({ ...p, pain: e.target.value }))} />
      </Field>

      <Field label="Which systems does this workflow touch?" hint="Pick what's involved. The agent has to reach all of them.">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
          {SYSTEMS.map((s) => {
            const on = inputs.systems.includes(s);
            return (
              <button key={s} onClick={() => toggleSystem(s)} style={{
                fontFamily: font, fontSize: 13, fontWeight: 500, padding: "6px 14px", borderRadius: 999, cursor: "pointer",
                border: `1px solid ${on ? C.info : C.line}`, color: on ? C.info : C.sub,
                background: on ? "#e7f0ff" : C.paper, transition: "all .12s",
              }}>{s}</button>
            );
          })}
        </div>
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Field label="Who does this work today?" hint="Drives the permission boundary.">
          <input style={inputStyle} value={inputs.userRole}
            onChange={(e) => setInputs((p) => ({ ...p, userRole: e.target.value }))} placeholder="e.g. Account Executive" />
        </Field>
        <Field label="What would be most useful for it to do?" hint="Drives the action layer.">
          <input style={inputStyle} value={inputs.action}
            onChange={(e) => setInputs((p) => ({ ...p, action: e.target.value }))} placeholder="e.g. draft a renewal brief" />
        </Field>
      </div>

      <Field label="What should it never do, or never expose?" hint="Drives the guardrails. Be strict here.">
        <textarea style={{ ...inputStyle, minHeight: 54, resize: "vertical", lineHeight: 1.5 }}
          value={inputs.restrictions} onChange={(e) => setInputs((p) => ({ ...p, restrictions: e.target.value }))} />
      </Field>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
        <select onChange={(e) => setInputs(loadExample(e.target.value))} style={{
          fontFamily: font, fontSize: 13, padding: "10px 12px", borderRadius: 12, border: `1px solid ${C.line}`, background: C.paper, color: C.ink, cursor: "pointer",
        }}>
          <option value="">Try an example scenario…</option>
          {Object.entries(EXAMPLES).map(([key, ex]) => (
            <option key={key} value={key}>{ex.name}</option>
          ))}
        </select>
        <button onClick={onGenerate} disabled={loading || !inputs.pain} style={{
          fontFamily: font, fontSize: 14, fontWeight: 600, padding: "12px 28px", borderRadius: 999, cursor: loading || !inputs.pain ? "default" : "pointer",
          border: "none", color: "#fff", background: loading || !inputs.pain ? "#c4ccd9" : C.info, transition: "background .12s",
        }}>{loading ? "Mapping the blueprint…" : "Generate blueprint"}</button>
      </div>
    </div>
  );
}

function ComparisonCards({ hg }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 18 }}>
      <div style={{ border: `1px solid ${C.line}`, borderRadius: 18, padding: "16px 18px", background: C.paper }}>
        <div style={{ fontFamily: display, fontSize: 12, fontWeight: 600, color: C.faint, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 }}>The homegrown version</div>
        <div style={{ fontSize: 13, color: C.ink, marginBottom: 4 }}>{hg.what_people_build}</div>
        <div style={{ fontSize: 13, color: C.sub, fontStyle: "italic", marginBottom: 14, lineHeight: 1.5 }}>{hg.looks_like}</div>
        {hg.why_it_falls_short.map((w, i) => (
          <div key={i} style={{ display: "flex", gap: 8, fontSize: 13, color: C.sub, marginBottom: 6, lineHeight: 1.45 }}>
            <span style={{ color: C.danger, flexShrink: 0 }}>✕</span>{w}
          </div>
        ))}
      </div>
      <div style={{ border: `1.5px solid ${C.info}`, borderRadius: 18, padding: "16px 18px", background: "#f5f9ff" }}>
        <div style={{ fontFamily: display, fontSize: 12, fontWeight: 600, color: C.info, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 }}>A real agent</div>
        <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.5 }}>
          Reaches your actual systems, understands how the pieces relate, enforces who can see what, and takes a scoped action with a human in the loop. See the Implementation tab for exactly what that requires.
        </div>
      </div>
    </div>
  );
}

function CustomerView({ bp }) {
  return (
    <div>
      <p style={{ fontSize: 15, color: C.ink, lineHeight: 1.6, margin: "4px 0 0" }}>{bp.views.customer_summary}</p>
      <ComparisonCards hg={bp.homegrown_version} />
    </div>
  );
}

function PartnerView({ bp }) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 500, color: C.ink, marginBottom: 10 }}>Questions to scope the opportunity</div>
      {bp.views.partner_qualification.map((q, i) => (
        <div key={i} style={{ display: "flex", gap: 11, marginBottom: 9 }}>
          <span style={{ fontSize: 13, color: C.faint, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{String(i + 1).padStart(2, "0")}</span>
          <span style={{ fontSize: 14, color: C.ink, lineHeight: 1.45 }}>{q}</span>
        </div>
      ))}
      <div style={{ marginTop: 18, padding: "12px 15px", background: C.surface, borderRadius: 9, fontSize: 13, color: C.sub }}>
        <span style={{ fontWeight: 500, color: C.ink }}>Complexity as a first agent — </span>{bp.views.complexity_signal}
      </div>
    </div>
  );
}

function LayerBlock({ which, items }) {
  const meta = LAYER[which];
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginBottom: 10 }}>
        <span style={{ width: 9, height: 9, borderRadius: 3, background: meta.color, flexShrink: 0, transform: "translateY(1px)" }} />
        <span style={{ fontFamily: display, fontSize: 15, fontWeight: 600, color: C.ink }}>{meta.label}</span>
        <span style={{ fontSize: 12, color: C.faint }}>{meta.sub}</span>
      </div>
      <div style={{ borderLeft: `2px solid ${meta.color}22`, paddingLeft: 16, marginLeft: 4 }}>
        {items.map((it, i) => (
          <div key={i} style={{ marginBottom: i === items.length - 1 ? 0 : 13 }}>
            {which === "reach" && (
              <>
                <div style={{ fontSize: 14, color: C.ink }}>
                  {it.system}{it.suggested && <span style={{ fontSize: 11, fontWeight: 600, color: C.act, marginLeft: 7, border: `1px solid ${C.act}55`, background: `${C.act}12`, borderRadius: 5, padding: "1px 7px", textTransform: "uppercase", letterSpacing: ".03em" }}>inferred · you didn't name this</span>}
                  <span style={{ color: C.sub }}> — {it.purpose}</span>
                </div>
                <div style={{ fontSize: 13, color: C.faint, marginTop: 2 }}>{it.data_category}</div>
                {it.suggested && <div style={{ fontSize: 12, color: C.act, marginTop: 2 }}>A guess at an adjacent system — confirm before relying on it.</div>}
              </>
            )}
            {which === "understand" && (
              <>
                <div style={{ fontSize: 14, color: C.ink }}>{it.relationship}</div>
                <div style={{ fontSize: 13, color: C.sub, marginTop: 2, lineHeight: 1.4 }}>{it.why_it_matters}</div>
              </>
            )}
            {which === "respect" && (
              <>
                <div style={{ fontSize: 14, color: C.ink }}>{it.boundary}<span style={{ color: C.sub }}> — {it.rule}</span></div>
                <div style={{ fontSize: 13, color: C.danger, marginTop: 2, lineHeight: 1.4 }}>Risk if violated: {it.risk_if_violated}</div>
              </>
            )}
            {which === "act" && (
              <>
                <div style={{ fontSize: 14, color: C.ink }}>{it.action}<span style={{ color: C.sub }}> — {it.scope}</span></div>
                <div style={{ fontSize: 13, color: C.act, marginTop: 2, lineHeight: 1.4 }}>Guardrail: {it.guardrail}</div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ImplementationView({ bp }) {
  return (
    <div>
      <LayerBlock which="reach" items={bp.blueprint.reach} />
      <LayerBlock which="understand" items={bp.blueprint.understand} />
      <LayerBlock which="respect" items={bp.blueprint.respect} />
      <LayerBlock which="act" items={bp.blueprint.act} />
      <div style={{ marginTop: 6, padding: "13px 16px", background: C.surface, borderRadius: 9, fontSize: 13, color: C.sub, lineHeight: 1.55 }}>
        Everything above is what stands between a chatbot and a working agent. The model was never the hard part. This scaffolding is.
      </div>
    </div>
  );
}

const TABS = [
  { id: "customer", label: "For the customer" },
  { id: "partner", label: "For the partner" },
  { id: "impl", label: "Implementation" },
];

function BlueprintResult({ bp, onReset }) {
  const [tab, setTab] = useState("customer");
  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontFamily: display, fontSize: 20, fontWeight: 600, color: C.ink, letterSpacing: "-.01em" }}>{bp.workflow.name}</div>
        <div style={{ fontSize: 14, color: C.sub, marginTop: 3, lineHeight: 1.5 }}>{bp.workflow.pain}</div>
        <div style={{ fontSize: 12, color: C.faint, marginTop: 6 }}>For: {bp.workflow.user_role} · Trigger: {bp.workflow.trigger}</div>
      </div>

      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.line}`, marginBottom: 22 }}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            fontFamily: display, fontSize: 13.5, fontWeight: 600, padding: "9px 14px", cursor: "pointer", background: "none", border: "none",
            color: tab === t.id ? C.ink : C.faint, borderBottom: tab === t.id ? `2px solid ${C.info}` : "2px solid transparent", marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === "customer" && <CustomerView bp={bp} />}
      {tab === "partner" && <PartnerView bp={bp} />}
      {tab === "impl" && <ImplementationView bp={bp} />}

      <div style={{ marginTop: 28, paddingTop: 18, borderTop: `1px solid ${C.lineSoft}` }}>
        <button onClick={onReset} style={{
          fontFamily: font, fontSize: 13.5, fontWeight: 600, color: C.sub, background: "none", border: `1px solid ${C.line}`, borderRadius: 999, padding: "10px 20px", cursor: "pointer",
        }}>Map another workflow</button>
      </div>
    </div>
  );
}

function Cursor() {
  return <span style={{ display: "inline-block", width: 7, marginLeft: 1, color: C.info, animation: "abb-blink 1s step-end infinite" }}>▍</span>;
}

// Shown while the model streams. partialParse pulls whatever structure is
// complete so far so the user watches the blueprint assemble instead of staring
// at a frozen spinner. Robustness lives downstream; this is purely for feel.
function StreamingPreview({ text }) {
  const partial = partialParse(text);
  const bp = partial?.blueprint || {};
  const layers = [
    ["reach", bp.reach], ["understand", bp.understand], ["respect", bp.respect], ["act", bp.act],
  ];
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 16 }}>
        <span style={{ width: 9, height: 9, borderRadius: 3, background: C.info, animation: "abb-pulse 1.2s ease-in-out infinite" }} />
        <span style={{ fontFamily: display, fontSize: 13, fontWeight: 600, color: C.info, textTransform: "uppercase", letterSpacing: ".06em" }}>
          Drafting the blueprint
        </span>
      </div>

      {partial?.workflow?.name
        ? <div style={{ fontFamily: display, fontSize: 20, fontWeight: 600, color: C.ink, letterSpacing: "-.01em", marginBottom: 14 }}>{partial.workflow.name}<Cursor /></div>
        : <div style={{ fontSize: 14, color: C.faint, marginBottom: 14 }}>Reaching the model and mapping your workflow…<Cursor /></div>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
        {layers.map(([which, items]) => {
          const meta = LAYER[which];
          const n = Array.isArray(items) ? items.length : 0;
          const on = n > 0;
          return (
            <div key={which} style={{
              display: "flex", alignItems: "center", gap: 7, padding: "6px 12px", borderRadius: 999,
              border: `1px solid ${on ? meta.color + "55" : C.line}`, background: on ? meta.color + "12" : C.paper,
              transition: "all .2s",
            }}>
              <span style={{ width: 8, height: 8, borderRadius: 3, background: on ? meta.color : C.line }} />
              <span style={{ fontSize: 13, fontWeight: 500, color: on ? C.ink : C.faint }}>{meta.label}</span>
              <span style={{ fontSize: 12, color: C.faint, fontVariantNumeric: "tabular-nums" }}>{on ? n : "—"}</span>
            </div>
          );
        })}
      </div>

      {partial?.views?.customer_summary && (
        <p style={{ fontSize: 14, color: C.sub, lineHeight: 1.6, margin: 0 }}>{partial.views.customer_summary}<Cursor /></p>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   5. APP
---------------------------------------------------------------------------- */
export default function App() {
  const [inputs, setInputs] = useState({ pain: "", systems: [], userRole: "", action: "", restrictions: "" });
  const [blueprint, setBlueprint] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState(null);

  const run = async () => {
    setLoading(true); setError(null); setProgress("");
    try {
      const bp = await generateBlueprint(inputs, setProgress);
      setBlueprint(bp);
    } catch (e) {
      console.error("Blueprint generation error:", e);
      setError(`Generation failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const reset = () => { setBlueprint(null); setError(null); setProgress(""); };

  return (
    <div style={{ fontFamily: font, background: C.surface, minHeight: "100vh", padding: "40px 20px", color: C.ink }}>
      <div style={{ maxWidth: 720, margin: "0 auto", background: C.paper, border: `1px solid ${C.line}`, borderRadius: 24, padding: "34px 38px", boxShadow: "0px 0px 16px #1d22280d, 0px 20px 20px -16px #1d222814" }}>
        <div style={{ marginBottom: 26 }}>
          <div style={{ fontFamily: display, fontSize: 12, fontWeight: 600, color: C.info, textTransform: "uppercase", letterSpacing: ".08em" }}>Agent Blueprint Builder</div>
          <h1 style={{ fontFamily: display, fontSize: 26, fontWeight: 600, color: C.ink, margin: "8px 0 0", lineHeight: 1.2, letterSpacing: "-.015em" }}>
            {blueprint ? "What a real agent would take" : "Map one workflow into a real agent"}
          </h1>
          {!blueprint && (
            <p style={{ fontSize: 14, color: C.sub, margin: "8px 0 0", lineHeight: 1.55, maxWidth: 560 }}>
              Pick one annoying workflow. See what a real enterprise agent would need to reach, understand, respect, and do — without faking a single piece of your data.
            </p>
          )}
        </div>

        {error && (
          <div style={{ fontSize: 13, color: C.danger, background: "#fcecec", border: `1px solid #f3d2d2`, borderRadius: 8, padding: "10px 14px", marginBottom: 18 }}>{error}</div>
        )}

        {blueprint
          ? <BlueprintResult bp={blueprint} onReset={reset} />
          : loading
          ? <StreamingPreview text={progress} />
          : <DiscoveryForm inputs={inputs} setInputs={setInputs} onGenerate={run} loading={loading} />}
      </div>

      <div style={{ maxWidth: 720, margin: "16px auto 0", textAlign: "center", fontSize: 12, color: C.faint }}>
        Reveals required structure, never simulated output or invented data.
      </div>
    </div>
  );
}
