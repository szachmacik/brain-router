/**
 * BRAIN ROUTER v5 — Autonomiczny, nie pada gdy Supabase ma timeout
 * 
 * Walidacja tokenów: D1 → ROUTER_SECRET (żaden krok nie wymaga Supabase)
 * Supabase używany TYLKO do: zapisu logów (fire-and-forget, błąd ignorowany)
 * 
 * Routing: reflex→Ollama/Groq | intuitive→Groq/Haiku | deliberate→DeepSeek/Sonnet | collective→Sonnet
 */

function scoreComplexity(text, urgency = "normal") {
  if (!text || text.length < 3) return 0;
  const words = text.trim().split(/\s+/).length;
  let score = Math.min(1, words / 250);
  if (/architektur|security.audit|deploy|migration|refactor|strategia|pełna analiza/i.test(text)) score = Math.max(score, 0.65);
  if (/research|zbadaj wszystko|multi.agent|swarm|investigate entire/i.test(text)) score = 1;
  if (urgency === "realtime") score = Math.min(score, 0.45);
  if (urgency === "batch") score = Math.max(score, 0.85);
  return score;
}

function choosePath(score) {
  if (score >= 0.85) return "collective";
  if (score >= 0.55) return "deliberate";
  if (score >= 0.2) return "intuitive";
  return "reflex";
}

async function hashKey(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.toLowerCase().trim().slice(0, 300)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// ── TOKEN VALIDATION (D1-first, no Supabase required) ──────────────────────
async function validateToken(token, appName, env) {
  if (!token) return null;
  // Master key — zawsze działa, bez DB
  if (token === env.ROUTER_SECRET) return { valid: true, app: "admin", scope: ["read", "write", "admin"] };
  
  // D1 lookup — szybki, lokalny
  try {
    const row = await env.KB_META.prepare(
      "SELECT app_name, scope, expires_at FROM live_tokens WHERE token=? AND expires_at > datetime('now') LIMIT 1"
    ).bind(token).first();
    if (row) return { valid: true, app: row.app_name, scope: JSON.parse(row.scope || '["read","write"]') };
  } catch (_) {}

  // Supabase fallback (może nie działać przy przeciążeniu — nie blokuje)
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/validate_live_token`, {
      method: "POST",
      headers: { "apikey": env.SUPABASE_ANON_KEY, "Content-Type": "application/json",
                 "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ p_token: token, p_app_name: appName || "unknown" }),
      signal: AbortSignal.timeout(2500)
    });
    const data = await r.json();
    if (data?.valid) {
      // Zapisz do D1 na przyszłość
      env.KB_META.prepare(
        "INSERT OR REPLACE INTO live_tokens(token,app_name,scope,expires_at) VALUES(?,?,?,datetime('now','+1 hour'))"
      ).bind(token, data.app || appName, JSON.stringify(data.scope || ["read","write"])).run().catch(()=>{});
      return data;
    }
  } catch (_) {}
  return null;
}

// ── ISSUE TOKEN (do D1 i opcjonalnie Supabase) ────────────────────────────
async function issueToken(appName, env) {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  // Zawsze zapisz do D1
  await env.KB_META.prepare(
    "INSERT INTO live_tokens(token,app_name,scope,expires_at) VALUES(?,?,?,datetime('now','+1 hour'))"
  ).bind(token, appName, '["read","write"]').run();
  
  // Supabase fire-and-forget
  fetch(`${env.SUPABASE_URL}/rest/v1/rpc/issue_live_token`, {
    method: "POST",
    headers: { "apikey": env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json",
               "Authorization": `Bearer ${env.SUPABASE_SERVICE_KEY}` },
    body: JSON.stringify({ p_app_name: appName, p_scope: ["read","write"] }),
    signal: AbortSignal.timeout(3000)
  }).catch(()=>{});

  return { token, expires_at: new Date(Date.now() + 3600000).toISOString() };
}

// ── LLM CALL z fallback chain ─────────────────────────────────────────────
const MODEL_IDS = {
  "claude-haiku":  "claude-haiku-4-5-20251001",
  "claude-sonnet": "claude-sonnet-4-6",
};
const PRICE = {
  intuitive:  { in: 25e-8, out: 125e-8 },
  deliberate: { in: 3e-6,  out: 15e-6 },
  collective: { in: 3e-6,  out: 15e-6 },
};

async function callLLM(path, messages, env) {
  const t0 = Date.now();

  // REFLEX: Ollama (koszt €0) → Groq fallback (koszt €0)
  if (path === "reflex") {
    if (env.OLLAMA_URL) {
      try {
        const r = await fetch(`${env.OLLAMA_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "qwen2.5:0.5b", messages, stream: false }),
          signal: AbortSignal.timeout(3500)
        });
        const d = await r.json();
        if (d.message?.content) return { text: d.message.content, latency: Date.now()-t0, cost: 0, model: "qwen2.5:0.5b" };
      } catch (_) {}
    }
    // Groq fallback (free tier, 100 req/h)
    if (env.GROQ_API_KEY) {
      try {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "llama-3.1-8b-instant", messages, max_tokens: 512 }),
          signal: AbortSignal.timeout(4000)
        });
        const d = await r.json();
        if (d.choices?.[0]?.message?.content)
          return { text: d.choices[0].message.content, latency: Date.now()-t0, cost: 0, model: "llama-3.1-8b-instant" };
      } catch (_) {}
    }
    path = "intuitive"; // escalate
  }

  // INTUITIVE: Groq-70b → Haiku
  if (path === "intuitive") {
    if (env.GROQ_API_KEY) {
      try {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, max_tokens: 1024 }),
          signal: AbortSignal.timeout(6000)
        });
        const d = await r.json();
        if (d.choices?.[0]?.message?.content)
          return { text: d.choices[0].message.content, latency: Date.now()-t0, cost: 0, model: "llama-3.3-70b-versatile" };
      } catch (_) {}
    }
  }

  // DELIBERATE / COLLECTIVE / FALLBACK: Claude
  const isCollective = path === "collective";
  const modelId = (isCollective || path === "deliberate") ? MODEL_IDS["claude-sonnet"] : MODEL_IDS["claude-haiku"];
  const sys = isCollective
    ? "Jesteś inteligencją zbiorową ekosystemu Holon. Subsidiarity. Pleroma."
    : "Jesteś agentem Holonu. Odpowiadaj precyzyjnie.";

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: modelId,
      max_tokens: isCollective ? 4096 : path === "deliberate" ? 2048 : 1024,
      system: sys,
      messages
    }),
    signal: AbortSignal.timeout(30000)
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  const p = PRICE[path] || PRICE.intuitive;
  const iT = d.usage?.input_tokens || 0, oT = d.usage?.output_tokens || 0;
  return { text: d.content?.[0]?.text || "", latency: Date.now()-t0,
           cost: iT*p.in + oT*p.out, model: modelId, tokens: {input:iT, output:oT} };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,x-app-token,x-app-name,x-router-key,x-urgency"
};
const json = (data, status=200) => Response.json(data, { status, headers: CORS });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    // HEALTH — zawsze odpowiada, 0 zależności
    if (url.pathname === "/health")
      return json({ status:"ok", service:"brain-router-v5", ts: new Date().toISOString(),
        architecture:"d1-first-no-supabase-required",
        paths:["reflex","intuitive","deliberate","collective"],
        providers: { ollama:!!env.OLLAMA_URL, groq:!!env.GROQ_API_KEY,
                     claude:!!env.ANTHROPIC_API_KEY, deepseek:!!env.DEEPSEEK_API_KEY } });

    // TOKEN ISSUE
    if (url.pathname === "/auth/token" && req.method === "POST") {
      if (req.headers.get("x-router-key") !== env.ROUTER_SECRET) return json({ error:"unauthorized" }, 401);
      const body = await req.json().catch(()=>({}));
      const tokenData = await issueToken(body.app_name || "unknown", env);
      return json(tokenData);
    }

    // STATS
    if (url.pathname === "/stats") {
      const cache = await env.KB_META.prepare("SELECT COUNT(*) as entries, SUM(hit_count) as hits FROM routing_cache").first().catch(()=>({entries:0,hits:0}));
      const tokens = await env.KB_META.prepare("SELECT COUNT(*) as active FROM live_tokens WHERE expires_at > datetime('now')").first().catch(()=>({active:0}));
      return json({ cache, tokens, ts: new Date().toISOString(),
        providers:{ groq:!!env.GROQ_API_KEY, ollama:!!env.OLLAMA_URL, claude:!!env.ANTHROPIC_API_KEY } });
    }

    // CHAT
    if (url.pathname === "/chat" && req.method === "POST") {
      const appToken = req.headers.get("x-app-token");
      const appName  = req.headers.get("x-app-name") || "unknown";
      const urgency  = req.headers.get("x-urgency") || "normal";

      const auth = await validateToken(appToken, appName, env);
      if (!auth?.valid) return json({ error:"invalid_or_expired_token",
        hint:"POST /auth/token with x-router-key header to get 1h token" }, 401);

      const body = await req.json().catch(()=>null);
      if (!body) return json({ error:"invalid_json" }, 400);
      const userText = body.prompt || body.messages?.find(m=>m.role==="user")?.content || "";
      if (!userText) return json({ error:"no_message" }, 400);

      const ck = await hashKey(userText);
      // Cache check (D1)
      if (urgency !== "realtime") {
        const hit = await env.KB_META.prepare(
          "SELECT response,path,model,complexity FROM routing_cache WHERE key=? AND (expires_at IS NULL OR expires_at>datetime('now')) LIMIT 1"
        ).bind(ck).first().catch(()=>null);
        if (hit) {
          env.KB_META.prepare("UPDATE routing_cache SET hit_count=hit_count+1 WHERE key=?").bind(ck).run().catch(()=>{});
          return json({ text:hit.response, path:hit.path, model:hit.model, cached:true, complexity:hit.complexity });
        }
      }

      const complexity = scoreComplexity(userText, urgency);
      const path = body.force_path && body.force_path !== "auto" ? body.force_path : choosePath(complexity);
      const messages = body.messages || [{ role:"user", content:userText }];

      let result;
      try {
        result = await callLLM(path, messages, env);
      } catch (e) {
        const fb = path==="reflex"?"intuitive":path==="intuitive"?"deliberate":"deliberate";
        try { result = await callLLM(fb, messages, env); result.fallback_from = path; }
        catch (e2) { return json({ error:"all_providers_failed", detail: String(e2) }, 503); }
      }

      // Cache write (fire-and-forget)
      if (path !== "collective" && urgency !== "realtime") {
        const ttl = path==="reflex"?24:path==="intuitive"?6:1;
        env.KB_META.prepare(
          `INSERT OR REPLACE INTO routing_cache(key,path,model,complexity,response,hit_count,created_at,expires_at) VALUES(?,?,?,?,?,1,datetime('now'),datetime('now','+${ttl} hours'))`
        ).bind(ck, path, result.model, complexity, result.text).run().catch(()=>{});
      }

      // Supabase log (fire-and-forget — nie blokuje odpowiedzi)
      fetch(`${env.SUPABASE_URL}/rest/v1/routing_decisions`, {
        method:"POST",
        headers:{ "apikey":env.SUPABASE_ANON_KEY, "Content-Type":"application/json",
                  "Authorization":`Bearer ${env.SUPABASE_ANON_KEY}`, "Prefer":"return=minimal" },
        body: JSON.stringify({ app_name:appName, path, model:result.model,
          complexity, latency_ms:result.latency, cost_usd:result.cost||0 }),
        signal: AbortSignal.timeout(2000)
      }).catch(()=>{});

      return json({
        text: result.text, path, model: result.model,
        complexity: Math.round(complexity*1000)/1000,
        latency_ms: result.latency, cost_usd: result.cost||0,
        cached: false, app: appName,
        fallback_from: result.fallback_from || null,
        reasoning: { reflex:"Odruch — Ollama/Groq €0",intuitive:"System 1 — Groq-70b/Haiku",
                     deliberate:"System 2 — Sonnet",collective:"Inteligencja zbiorowa" }[path]
      });
    }

    return json({ error:"not_found", available:["/health","/auth/token","/chat","/stats"] }, 404);
  }
};
