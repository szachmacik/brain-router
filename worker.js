/**
 * HOLON BRAIN ROUTER v2 — Zero-Exposure Architecture
 * ====================================================
 *
 * ZASADA: prawdziwe klucze żyją TYLKO w CF Secrets (env.*).
 * Aplikacje dostają 1h JWT od /auth/token.
 * Nawet jeśli token wycieknie — wygasa zanim ktoś go użyje.
 *
 * Ścieżki jak zdrowy organizm (wzorzec z pliku):
 *  REFLEX     → Ollama lokalnie     — łuk odruchowy,     €0,       <200ms
 *  INTUITIVE  → Claude Haiku        — System 1, wzorce,  €0.00005, <1s
 *  DELIBERATE → Claude Sonnet       — System 2, głęboki, €0.001,   2-5s
 *  COLLECTIVE → Sonnet multi-step   — inteligencja zbior,€0.005,   5-15s
 *
 * Routing: koszt logarytmicznie → 0 bo cache + reflex rośnie z użyciem.
 */

// ── Routing intelligence ──────────────────────────────────────────────────────
function scoreComplexity(text, urgency = 'normal') {
  if (!text || text.length < 3) return 0;
  const words = text.trim().split(/\s+/).length;
  let score = Math.min(1.0, words / 250);

  // Wzorce = wyższy poziom
  if (/architektur|security.audit|deploy|migration|refactor|strategia|pełna analiza|optymalizacja systemu/i.test(text))
    score = Math.max(score, 0.65);
  if (/research|zbadaj wszystko|multi.agent|swarm|investigate entire/i.test(text))
    score = 1.0;

  if (urgency === 'realtime') score = Math.min(score, 0.45);  // zawsze max intuitive
  if (urgency === 'batch')    score = Math.max(score, 0.85);  // zawsze collective
  return score;
}

function choosePath(score) {
  if (score >= 0.85) return 'collective';
  if (score >= 0.55) return 'deliberate';
  if (score >= 0.20) return 'intuitive';
  return 'reflex';
}

// ── Semantic cache key (SHA-256 of normalized text) ───────────────────────────
async function cacheKey(text) {
  const norm = text.toLowerCase().replace(/\s+/g,' ').trim().slice(0,300);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,32);
}

// ── Auth: validate app token via Supabase RPC ────────────────────────────────
async function validateAppToken(token, appName, env) {
  if (!token) return null;
  // Master secret: bypass token check for internal calls
  if (token === env.ROUTER_SECRET) return { valid: true, app: 'admin', scope: ['read','write','admin'] };

  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/validate_live_token`, {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({ p_token: token, p_app_name: appName || 'unknown' }),
      signal: AbortSignal.timeout(3000)
    });
    return await r.json();
  } catch { return null; }
}

// ── Issue new live token ──────────────────────────────────────────────────────
async function issueToken(appName, scope, env) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/issue_live_token`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
    },
    body: JSON.stringify({ p_app_name: appName, p_scope: scope || ['read','write'] }),
    signal: AbortSignal.timeout(5000)
  });
  return r.json();
}

// ── Call LLM model ────────────────────────────────────────────────────────────
const MODEL_IDS = {
  'claude-haiku-4-5':  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5': 'claude-sonnet-4-5-20251001',
};
const PRICE = {
  intuitive:  { in: 0.00000025, out: 0.00000125 },
  deliberate: { in: 0.000003,   out: 0.000015   },
  collective: { in: 0.000003,   out: 0.000015   },
};

async function callLLM(path, messages, env) {
  const t0 = Date.now();

  // REFLEX: lokalne Ollama — zero kosztu
  if (path === 'reflex') {
    try {
      const r = await fetch(`${env.OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'qwen2.5:0.5b', messages, stream: false }),
        signal: AbortSignal.timeout(4000)
      });
      const d = await r.json();
      return { text: d.message?.content || '', latency: Date.now()-t0, cost: 0, model: 'qwen2.5:0.5b' };
    } catch {
      // Reflex fallback → intuitive
      path = 'intuitive';
    }
  }

  // COLLECTIVE: dodatkowy system prompt + wyższe max_tokens
  const isCollective = path === 'collective';
  const modelId = isCollective || path === 'deliberate'
    ? MODEL_IDS['claude-sonnet-4-5']
    : MODEL_IDS['claude-haiku-4-5'];

  const sysMsg = isCollective
    ? 'Jesteś inteligencją zbiorową ekosystemu Holon (ofshore.dev). Analizuj wielowymiarowo. Subsidiarity: zacznij od najprostszego. Pleroma: zostaw odpowiedź lepszą niż oczekiwano.'
    : 'Jesteś agentem Holonu. Odpowiadaj precyzyjnie i zwięźle.';

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,  // CF Secret — nigdy widoczny w kodzie/git
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: isCollective ? 4096 : path === 'deliberate' ? 2048 : 1024,
      system: sysMsg,
      messages
    }),
    signal: AbortSignal.timeout(30000)
  });

  const d = await r.json();
  if (d.error) throw new Error(d.error.message);

  const iT = d.usage?.input_tokens || 0, oT = d.usage?.output_tokens || 0;
  const p = PRICE[path] || PRICE.intuitive;
  return {
    text: d.content?.[0]?.text || '',
    latency: Date.now()-t0,
    cost: iT*p.in + oT*p.out,
    model: modelId,
    tokens: { input: iT, output: oT }
  };
}

// ── CORS headers ──────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,x-app-token,x-app-name,x-router-key,x-urgency',
};
const json = (data, status=200) => Response.json(data, { status, headers: CORS });

// ── Main fetch handler ────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // ── /health ──────────────────────────────────────────────────────────────
    if (url.pathname === '/health')
      return json({ status:'ok', service:'brain-router-v2', ts: new Date().toISOString(),
        architecture: 'zero-exposure', paths: ['reflex','intuitive','deliberate','collective'] });

    // ── /auth/token — aplikacja dostaje 1h JWT ────────────────────────────────
    if (url.pathname === '/auth/token' && req.method === 'POST') {
      const masterKey = req.headers.get('x-router-key');
      if (masterKey !== env.ROUTER_SECRET) return json({ error:'unauthorized' }, 401);
      const body = await req.json().catch(() => ({}));
      const tokenData = await issueToken(body.app_name || 'unknown', body.scope, env);
      return json(tokenData);
    }

    // ── /auth/rotate — wymuś natychmiastową rotację tokena ────────────────────
    if (url.pathname === '/auth/rotate' && req.method === 'POST') {
      const masterKey = req.headers.get('x-router-key');
      if (masterKey !== env.ROUTER_SECRET) return json({ error:'unauthorized' }, 401);
      const body = await req.json().catch(() => ({}));

      // Wywołaj rotację przez Supabase RPC
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/rotate_coolify_token`, {
        method: 'POST',
        headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` },
        body: '{}'
      });
      const result = await r.json();
      return json({ rotated: true, result });
    }

    // ── /security/exposure — raport o wycieku (auto-trigger rotacji) ──────────
    if (url.pathname === '/security/exposure' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      // Log to D1
      await env.KB_META.prepare(
        'INSERT INTO security_log(id,event_type,token_name,severity,details) VALUES(?,?,?,?,?)'
      ).bind(crypto.randomUUID(),'exposure',body.token||'unknown','critical',JSON.stringify(body)).run();
      // Forward to Supabase (fire & forget)
      fetch(`${env.SUPABASE_URL}/rest/v1/rpc/report_token_exposure`, {
        method:'POST',
        headers:{'apikey':env.SUPABASE_ANON_KEY,'Content-Type':'application/json',
          'Authorization':`Bearer ${env.SUPABASE_ANON_KEY}`},
        body:JSON.stringify({p_token_name:body.token,p_source:'brain-router',p_details:body.details})
      }).catch(()=>{});
      return json({ reported: true, action: 'rotation_queued' });
    }

    // ── /chat — główny endpoint routujący requesty ────────────────────────────
    if (url.pathname === '/chat' && req.method === 'POST') {
      const appToken = req.headers.get('x-app-token');
      const appName  = req.headers.get('x-app-name') || 'unknown';
      const urgency  = req.headers.get('x-urgency') || 'normal';

      // Waliduj token
      const auth = await validateAppToken(appToken, appName, env);
      if (!auth?.valid) return json({ error:'invalid_or_expired_token',
        hint:'Call POST /auth/token with x-router-key to get a fresh 1h token' }, 401);

      const body = await req.json().catch(() => null);
      if (!body) return json({ error:'invalid_json' }, 400);

      const userText = body.prompt || body.messages?.find(m=>m.role==='user')?.content || '';
      if (!userText) return json({ error:'no_message' }, 400);

      // Semantic cache (skip for realtime)
      const ck = await cacheKey(userText);
      if (urgency !== 'realtime') {
        const hit = await env.KB_META.prepare(
          'SELECT * FROM routing_cache WHERE key=? AND (expires_at IS NULL OR expires_at>datetime("now")) LIMIT 1'
        ).bind(ck).first();
        if (hit) {
          await env.KB_META.prepare('UPDATE routing_cache SET hit_count=hit_count+1 WHERE key=?').bind(ck).run();
          return json({ text:hit.response, path:hit.path, model:hit.model,
            cached:true, complexity:hit.complexity });
        }
      }

      const complexity = scoreComplexity(userText, urgency);
      const path = body.force_path || choosePath(complexity);
      const messages = body.messages || [{ role:'user', content: userText }];

      let result;
      try {
        result = await callLLM(path, messages, env);
      } catch(e) {
        // Fallback path
        const fallback = path==='reflex'?'intuitive' : path==='intuitive'?'deliberate':'deliberate';
        result = await callLLM(fallback, messages, env);
        result.fallback_from = path;
      }

      // Cache (TTL: reflex=24h, intuitive=6h, deliberate=1h, collective=skip)
      if (path !== 'collective' && urgency !== 'realtime') {
        const ttl = path==='reflex'?24 : path==='intuitive'?6 : 1;
        await env.KB_META.prepare(
          'INSERT OR REPLACE INTO routing_cache(key,path,model,complexity,response,hit_count,created_at,expires_at)'
          +' VALUES(?,?,?,?,?,1,datetime("now"),datetime("now","+'+ ttl +' hours"))'
        ).bind(ck, path, result.model, complexity, result.text).run();
      }

      // Update stats
      await env.KB_META.prepare(
        'UPDATE routing_stats SET total_requests=total_requests+1,'
        +'avg_latency_ms=avg_latency_ms*0.85+?*0.15,'
        +'total_cost_usd=total_cost_usd+?,last_used=datetime("now") WHERE path=?'
      ).bind(result.latency, result.cost||0, path).run();

      return json({
        text: result.text, path, model: result.model,
        complexity: Math.round(complexity*1000)/1000,
        latency_ms: result.latency, cost_usd: result.cost,
        cached: false, app: appName,
        reasoning: {
          reflex:     'Łuk odruchowy — Ollama €0 <200ms',
          intuitive:  'System 1 — Haiku wzorce <1s',
          deliberate: 'System 2 — Sonnet głęboki 2-5s',
          collective: 'Inteligencja zbiorowa 5-15s',
        }[path],
        security: 'zero-exposure — token valid 1h, rotated automatically'
      });
    }

    // ── /stats ────────────────────────────────────────────────────────────────
    if (url.pathname === '/stats') {
      const stats = await env.KB_META.prepare('SELECT * FROM routing_stats').all();
      const cache = await env.KB_META.prepare('SELECT COUNT(*) as entries, SUM(hit_count) as hits FROM routing_cache').first();
      return json({ paths: stats.results, cache, ts: new Date().toISOString() });
    }

    return json({ error:'not_found', available:['/health','/auth/token','/chat','/stats'] }, 404);
  }
};
