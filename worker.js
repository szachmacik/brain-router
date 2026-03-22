/**
 * HOLON BRAIN ROUTER — Cloudflare Worker
 * =======================================
 * Adaptacyjny routing jak zdrowy organizm:
 *
 *  REFLEX       → Ollama qwen2.5:0.5b (lokalnie) — łuk odruchowy, <200ms, €0
 *  INTUITIVE    → Claude Haiku         — System 1, wzorce, <1s, ~€0.00005
 *  DELIBERATE   → Claude Sonnet        — System 2, głębokie, 2-5s, ~€0.001
 *  COLLECTIVE   → Sonnet + multi-step  — inteligencja zbiorowa, 5-15s
 *
 * Zasada Kairos: właściwa ścieżka, nie najszybsza.
 * Zasada Subsidiarity: najniższy poziom który poradzi sobie z zadaniem.
 * Zasada Pleroma: każdy request zostaw z lepszą odpowiedzią niż oczekiwano.
 */

const PATHS = {
  reflex:     { model: 'qwen2.5:0.5b',     maxCost: 0,       maxLatency: 500  },
  intuitive:  { model: 'claude-haiku-4-5',  maxCost: 0.001,   maxLatency: 2000 },
  deliberate: { model: 'claude-sonnet-4-5', maxCost: 0.01,    maxLatency: 8000 },
  collective: { model: 'claude-sonnet-4-5', maxCost: 0.05,    maxLatency: 30000 },
};

// ── Complexity scorer ─────────────────────────────────────────────────────────
function scoreComplexity(text, urgency = 'normal') {
  const words = text.trim().split(/\s+/).length;
  let score = Math.min(1.0, words / 250);

  const deliberateRx = /architektur|security audit|deploy|migration|refactor|strategia|optymalizacja systemu|full analysis|explain.*deep|dlaczego.*kompletnie/i;
  const collectiveRx = /research|zbadaj wszystko|multi.agent|swarm|pełna analiza ekosystemu|investigate entire/i;

  if (collectiveRx.test(text)) score = 1.0;
  else if (deliberateRx.test(text)) score = Math.max(score, 0.65);

  // Pilność może obniżyć ścieżkę (subsidiarity: nie przeciążaj wyżej)
  if (urgency === 'realtime') score = Math.min(score, 0.5);
  if (urgency === 'batch')    score = Math.max(score, 0.85);

  return score;
}

function choosePath(complexity, urgency) {
  if (complexity >= 0.85) return 'collective';
  if (complexity >= 0.55) return 'deliberate';
  if (complexity >= 0.20) return 'intuitive';
  return 'reflex';
}

// ── Semantic cache key ─────────────────────────────────────────────────────────
async function makeCacheKey(text) {
  const normalized = text.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 200);
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0,32);
}

// ── Call model ────────────────────────────────────────────────────────────────
async function callModel(path, messages, env) {
  const t0 = Date.now();

  if (path === 'reflex') {
    // Local Ollama
    const r = await fetch(`${env.OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5:0.5b', messages, stream: false }),
      signal: AbortSignal.timeout(3000)
    });
    const d = await r.json();
    return {
      text: d.message?.content || '',
      latency: Date.now() - t0,
      cost: 0,
      model: 'qwen2.5:0.5b'
    };
  }

  // Anthropic (haiku or sonnet)
  const model = PATHS[path].model === 'claude-haiku-4-5'
    ? 'claude-haiku-4-5-20251001'
    : 'claude-sonnet-4-5-20251001';

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, max_tokens: 1024, messages }),
    signal: AbortSignal.timeout(PATHS[path].maxLatency + 5000)
  });

  const d = await r.json();
  const inputT  = d.usage?.input_tokens  || 0;
  const outputT = d.usage?.output_tokens || 0;
  const priceIn  = path === 'intuitive' ? 0.00000025 : 0.000003;
  const priceOut = path === 'intuitive' ? 0.00000125 : 0.000015;

  return {
    text: d.content?.[0]?.text || d.error?.message || 'Error',
    latency: Date.now() - t0,
    cost: inputT * priceIn + outputT * priceOut,
    model,
    tokens: { input: inputT, output: outputT }
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,x-router-key,x-urgency,x-source-app',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // Health
    if (url.pathname === '/health') {
      return Response.json({ status:'ok', service:'brain-router', ts: new Date().toISOString() }, { headers: cors });
    }

    // Stats
    if (url.pathname === '/stats' && request.method === 'GET') {
      const rows = await env.KB_META.prepare('SELECT * FROM routing_stats').all();
      return Response.json({ paths: rows.results }, { headers: cors });
    }

    // Security report endpoint
    if (url.pathname === '/security/report' && request.method === 'POST') {
      const apiKey = request.headers.get('x-router-key');
      if (apiKey !== env.ROUTER_SECRET) return new Response('Unauthorized', { status:401, headers: cors });
      const body = await request.json();
      // Log to D1
      await env.KB_META.prepare(
        'INSERT INTO security_log (id, event_type, token_name, severity, details) VALUES (?,?,?,?,?)'
      ).bind(crypto.randomUUID(), body.event_type || 'exposure', body.token, body.severity || 'high', JSON.stringify(body)).run();
      // Forward to Supabase RPC (fire-and-forget)
      fetch(`${env.SUPABASE_URL}/rest/v1/rpc/report_token_exposure`, {
        method: 'POST',
        headers: { 'apikey': env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_token_name: body.token, p_source: 'brain-router', p_details: body.details })
      }).catch(() => {});
      return Response.json({ reported: true }, { headers: cors });
    }

    // Main: POST /chat or /route
    if ((url.pathname === '/chat' || url.pathname === '/route') && request.method === 'POST') {
      const apiKey = request.headers.get('x-router-key');
      if (apiKey !== env.ROUTER_SECRET && !env.ROUTER_PUBLIC) {
        return new Response('Unauthorized', { status: 401, headers: cors });
      }

      let body;
      try { body = await request.json(); }
      catch { return new Response('Invalid JSON', { status: 400, headers: cors }); }

      const { messages, prompt, urgency = 'normal', source_app = 'unknown', force_path } = body;
      const userMsg = prompt || (messages?.find(m => m.role === 'user')?.content) || '';

      if (!userMsg) return Response.json({ error: 'No message provided' }, { status: 400, headers: cors });

      // Semantic cache check
      const cacheKey = await makeCacheKey(userMsg);
      if (urgency !== 'realtime') {
        const cached = await env.KB_META.prepare(
          'SELECT * FROM routing_cache WHERE key=? AND (expires_at IS NULL OR expires_at > datetime("now"))'
        ).bind(cacheKey).first();
        if (cached) {
          await env.KB_META.prepare('UPDATE routing_cache SET hit_count=hit_count+1 WHERE key=?').bind(cacheKey).run();
          return Response.json({
            text: cached.response, path: cached.path, model: cached.model,
            cached: true, complexity: cached.complexity
          }, { headers: cors });
        }
      }

      // Choose path
      const complexity = scoreComplexity(userMsg, urgency);
      const path = force_path || choosePath(complexity, urgency);
      const msgs = messages || [{ role: 'user', content: userMsg }];

      // Call model
      let result;
      try {
        result = await callModel(path, msgs, env);
      } catch (e) {
        // Fallback: escalate to next path
        const fallbackPath = path === 'reflex' ? 'intuitive' : 'deliberate';
        try {
          result = await callModel(fallbackPath, msgs, env);
          result.fallback_from = path;
        } catch (e2) {
          return Response.json({ error: e2.message, path }, { status: 500, headers: cors });
        }
      }

      // Cache for non-realtime, non-collective
      if (urgency !== 'realtime' && path !== 'collective') {
        const ttlHours = path === 'reflex' ? 24 : path === 'intuitive' ? 6 : 1;
        await env.KB_META.prepare(
          'INSERT OR REPLACE INTO routing_cache (key,path,model,complexity,response,expires_at) VALUES (?,?,?,?,?,datetime("now","+"||?||" hours"))'
        ).bind(cacheKey, path, result.model, complexity, result.text, ttlHours).run();
      }

      // Update stats
      await env.KB_META.prepare(
        'UPDATE routing_stats SET total_requests=total_requests+1, avg_latency_ms=(avg_latency_ms*0.85+?*0.15), total_cost_usd=total_cost_usd+?, last_used=datetime("now") WHERE path=?'
      ).bind(result.latency, result.cost || 0, path).run();

      return Response.json({
        text: result.text,
        path,
        model: result.model,
        complexity: Math.round(complexity * 1000) / 1000,
        latency_ms: result.latency,
        cost_usd: result.cost,
        cached: false,
        reasoning: {
          reflex:     'Łuk odruchowy — lokalnie, zero kosztu',
          intuitive:  'System 1 — szybkie wzorce',
          deliberate: 'System 2 — głębokie rozumowanie',
          collective: 'Inteligencja zbiorowa — multi-step'
        }[path]
      }, { headers: cors });
    }

    return new Response('Not Found', { status: 404, headers: cors });
  }
};
