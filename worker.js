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

// ── Multi-Provider LLM Engine v4 ─────────────────────────────────────────────
// Provider priority (cost-optimised with auto-failover):
//   reflex:     Ollama(€0) → Groq-8b(€0 free) → Gemini-flash
//   intuitive:  Groq-70b(€0 FREE) → Haiku → Gemini-flash
//   deliberate: DeepSeek($0.001) → Sonnet → GPT-4o
//   collective: Sonnet → GPT-4o → Gemini-pro
// CF Worker executes at edge — bypasses Bot Fight Mode automatically

const MODEL_IDS = {
  'claude-haiku':   'claude-haiku-4-5-20251001',
  'claude-sonnet':  'claude-sonnet-4-6',
  'gemini-flash':   'gemini-2.0-flash',
  'gemini-pro':     'gemini-1.5-pro',
  'gpt-4o-mini':    'gpt-4o-mini',
  'gpt-4o':         'gpt-4o',
  'groq-70b':       'llama-3.3-70b-versatile',
  'groq-8b':        'llama-3.1-8b-instant',
  'deepseek':       'deepseek-chat',
};

const PRICE = {
  'claude-haiku':  { in: 0.00000025, out: 0.00000125 },
  'claude-sonnet': { in: 0.000003,   out: 0.000015   },
  'gemini-flash':  { in: 0.0000001,  out: 0.0000004  },
  'gemini-pro':    { in: 0.0000035,  out: 0.0000105  },
  'gpt-4o-mini':   { in: 0.00000015, out: 0.0000006  },
  'gpt-4o':        { in: 0.000005,   out: 0.000015   },
  'groq-70b':      { in: 0,          out: 0           },
  'groq-8b':       { in: 0,          out: 0           },
  'deepseek':      { in: 0.0000005,  out: 0.0000015  },
};

const PATH_PROVIDERS = {
  reflex:     ['ollama', 'groq-8b',  'gemini-flash'],
  intuitive:  ['groq-70b', 'claude-haiku', 'gemini-flash'],
  deliberate: ['deepseek', 'claude-sonnet', 'gpt-4o'],
  collective: ['claude-sonnet', 'gpt-4o', 'gemini-pro'],
};

const HOLON  = 'Jesteś agentem Holonu (ofshore.dev). Odpowiadaj precyzyjnie i zwięźle.';
const COLSYS = 'Jesteś inteligencją zbiorową Holonu. Analizuj wielowymiarowo. Subsidiarity: zacznij od najprostszego. Pleroma: zostaw odpowiedź lepszą niż oczekiwano.';

// ── Upstash Redis cache (fast distributed) ────────────────────────────────────
async function upstashGet(key, env) {
  if (!env.UPSTASH_URL || !env.UPSTASH_TOKEN) return null;
  try {
    const r = await fetch(`${env.UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_TOKEN}` },
      signal: AbortSignal.timeout(800),
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}
async function upstashSet(key, data, ttlSec, env) {
  if (!env.UPSTASH_URL || !env.UPSTASH_TOKEN) return;
  try {
    await fetch(`${env.UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(data), ex: ttlSec }),
      signal: AbortSignal.timeout(800),
    });
  } catch {}
}

// ── Per-provider callers ──────────────────────────────────────────────────────
async function callOllama(messages, env, t0) {
  const r = await fetch(`${env.OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ model:'qwen2.5:0.5b', messages, stream:false }),
    signal: AbortSignal.timeout(4000),
  });
  const d = await r.json();
  return { text: d.message?.content||'', latency: Date.now()-t0, cost: 0, model: 'qwen2.5:0.5b' };
}

async function callClaude(model, messages, path, env, t0) {
  const isCollective = path === 'collective';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
    body: JSON.stringify({
      model: MODEL_IDS[model],
      max_tokens: isCollective ? 4096 : path === 'deliberate' ? 2048 : 1024,
      system: isCollective ? COLSYS : HOLON, messages,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const d = await r.json();
  if (d.error) throw new Error(`Claude ${d.error.type}: ${d.error.message}`);
  const iT=d.usage?.input_tokens||0, oT=d.usage?.output_tokens||0, p=PRICE[model];
  return { text:d.content?.[0]?.text||'', latency:Date.now()-t0, cost:iT*p.in+oT*p.out, model:MODEL_IDS[model], tokens:{input:iT,output:oT} };
}

async function callGroq(model, messages, path, env, t0) {
  if (!env.GROQ_API_KEY) throw new Error('No GROQ_API_KEY');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${env.GROQ_API_KEY}`},
    body: JSON.stringify({
      model: MODEL_IDS[model],
      messages: [{role:'system',content:HOLON}, ...messages],
      max_tokens: path==='deliberate' ? 2048 : 1024,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(8000),
  });
  const d = await r.json();
  if (d.error) throw new Error(`Groq: ${d.error.message}`);
  return { text:d.choices?.[0]?.message?.content||'', latency:Date.now()-t0, cost:0, model:MODEL_IDS[model] };
}

async function callDeepSeek(messages, path, env, t0) {
  if (!env.DEEPSEEK_API_KEY) throw new Error('No DEEPSEEK_API_KEY');
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${env.DEEPSEEK_API_KEY}`},
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{role:'system',content:HOLON}, ...messages],
      max_tokens: path==='deliberate' ? 2048 : 1024,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const d = await r.json();
  if (d.error) throw new Error(`DeepSeek: ${d.error.message}`);
  const iT=d.usage?.prompt_tokens||0, oT=d.usage?.completion_tokens||0, p=PRICE['deepseek'];
  return { text:d.choices?.[0]?.message?.content||'', latency:Date.now()-t0, cost:iT*p.in+oT*p.out, model:'deepseek-chat' };
}

async function callGemini(model, messages, path, env, t0) {
  if (!env.GEMINI_API_KEY) throw new Error('No GEMINI_API_KEY');
  const contents = messages.filter(m=>m.role!=='system')
    .map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}));
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_IDS[model]}:generateContent?key=${env.GEMINI_API_KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({contents,generationConfig:{maxOutputTokens:path==='collective'?4096:1024}}),
      signal:AbortSignal.timeout(25000) }
  );
  const d = await r.json();
  if (d.error) throw new Error(`Gemini: ${d.error.message}`);
  const text=d.candidates?.[0]?.content?.parts?.[0]?.text||'';
  const iT=d.usageMetadata?.promptTokenCount||0, oT=d.usageMetadata?.candidatesTokenCount||0, p=PRICE[model];
  return { text, latency:Date.now()-t0, cost:iT*p.in+oT*p.out, model:MODEL_IDS[model] };
}

async function callOpenAI(model, messages, path, env, t0) {
  const auth = env.OPENAI_API_KEY || env.OPENROUTER_API_KEY;
  const url  = env.OPENAI_API_KEY ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
  if (!auth) throw new Error('No OpenAI/OpenRouter key');
  const r = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${auth}`,'HTTP-Referer':'https://ofshore.dev'},
    body:JSON.stringify({
      model:MODEL_IDS[model],
      messages:[{role:'system',content:path==='collective'?COLSYS:HOLON},...messages],
      max_tokens:path==='collective'?4096:path==='deliberate'?2048:1024,
    }),
    signal:AbortSignal.timeout(30000),
  });
  const d = await r.json();
  if (d.error) throw new Error(`OpenAI: ${d.error.message}`);
  const iT=d.usage?.prompt_tokens||0, oT=d.usage?.completion_tokens||0, p=PRICE[model]||PRICE['gpt-4o'];
  return { text:d.choices?.[0]?.message?.content||'', latency:Date.now()-t0, cost:iT*p.in+oT*p.out, model:MODEL_IDS[model] };
}

// ── Main callLLM with auto-failover ──────────────────────────────────────────
async function callLLM(path, messages, env, preferProvider = null) {
  const t0 = Date.now();
  const providers = preferProvider
    ? [preferProvider, ...PATH_PROVIDERS[path].filter(p => p !== preferProvider)]
    : PATH_PROVIDERS[path];

  let lastError;
  for (const provider of providers) {
    try {
      if (provider==='ollama')        return await callOllama(messages, env, t0);
      if (provider==='groq-70b')      return await callGroq('groq-70b', messages, path, env, t0);
      if (provider==='groq-8b')       return await callGroq('groq-8b',  messages, path, env, t0);
      if (provider==='deepseek')      return await callDeepSeek(messages, path, env, t0);
      if (provider==='claude-haiku')  return await callClaude('claude-haiku',  messages, path, env, t0);
      if (provider==='claude-sonnet') return await callClaude('claude-sonnet', messages, path, env, t0);
      if (provider==='gemini-flash')  return await callGemini('gemini-flash',  messages, path, env, t0);
      if (provider==='gemini-pro')    return await callGemini('gemini-pro',    messages, path, env, t0);
      if (provider==='gpt-4o-mini')   return await callOpenAI('gpt-4o-mini',  messages, path, env, t0);
      if (provider==='gpt-4o')        return await callOpenAI('gpt-4o',        messages, path, env, t0);
    } catch(e) {
      lastError = e;
      const isRate = /rate|529|quota|429|overload|insufficient/i.test(e.message||'');
      console.log(`[brain-router] ${provider} failed: ${e.message?.slice(0,80)}`);
      if (!isRate) break;
    }
  }
  throw lastError || new Error('All providers exhausted');
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
      return json({
        status:'ok', service:'brain-router-v4', ts:new Date().toISOString(),
        architecture:'zero-exposure-multi-provider',
        providers:{ groq:!!env.GROQ_API_KEY, deepseek:!!env.DEEPSEEK_API_KEY,
          claude:!!env.ANTHROPIC_API_KEY, gemini:!!env.GEMINI_API_KEY,
          openai:!!(env.OPENAI_API_KEY||env.OPENROUTER_API_KEY), ollama:true,
          cache:!!(env.UPSTASH_URL&&env.UPSTASH_TOKEN) },
        path_chains:PATH_PROVIDERS,
        paths:['reflex','intuitive','deliberate','collective'],
        version:'v4-groq-deepseek-upstash' });

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
      const userId   = body.user_id || appName;
      const preferProvider = body.prefer_provider || null;
      const userId   = body.user_id || appName;           // track per user
      const preferProvider = body.prefer_provider || null; // e.g. 'gemini-flash' for Kamila speed
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
        result = await callLLM(path, messages, env, preferProvider);
        result.user_id = userId;
      } catch(e) {
        // Fallback path
        const fallback = path==='reflex'?'intuitive' : path==='intuitive'?'deliberate':'deliberate';
        result = await callLLM(fallback, messages, env, null);
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

      // Upstash cache write
      const ttl = {reflex:86400,intuitive:21600,deliberate:3600,collective:0}[path]||3600;
      if (ttl > 0 && urgency !== 'realtime') {
        await upstashSet(ck, {text:result.text,path,model:result.model,complexity}, ttl, env);
      }

      // Update stats (D1)
      try { await env.KB_META.prepare(
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
