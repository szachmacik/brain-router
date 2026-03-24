import Fastify from 'fastify';
import cors from '@fastify/cors';

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

// ── Env ──────────────────────────────────────────────────────
const SB_URL    = process.env.SUPABASE_URL;
const SB_ANON   = process.env.SUPABASE_ANON_KEY;
const SB_SVC    = process.env.SUPABASE_SERVICE_KEY;
const SECRET    = process.env.ROUTER_SECRET || 'holon-brain-router-2026';
const OLLAMA    = process.env.OLLAMA_URL    || 'http://ollama:11434';
const ANT_KEY   = process.env.ANTHROPIC_API_KEY;
const GEM_KEY   = process.env.GEMINI_API_KEY;
const OAI_KEY   = process.env.OPENAI_API_KEY;
const OR_KEY    = process.env.OPENROUTER_API_KEY;

// ── Multi-provider model map ──────────────────────────────────
const PATH_PROVIDERS = {
  reflex:     ['ollama', 'gemini-flash'],
  intuitive:  ['claude-haiku', 'gemini-flash', 'gpt-4o-mini'],
  deliberate: ['claude-sonnet', 'gpt-4o', 'gemini-pro'],
  collective: ['claude-sonnet', 'gpt-4o', 'gemini-pro'],
};

const MODEL_IDS = {
  'claude-haiku':  'claude-haiku-4-5-20251001',
  'claude-sonnet': 'claude-sonnet-4-6',
  'gemini-flash':  'gemini-2.0-flash',
  'gemini-pro':    'gemini-1.5-pro',
  'gpt-4o-mini':   'gpt-4o-mini',
  'gpt-4o':        'gpt-4o',
};

const PRICE = {
  'claude-haiku':  { in: 0.00000025, out: 0.00000125 },
  'claude-sonnet': { in: 0.000003,   out: 0.000015   },
  'gemini-flash':  { in: 0.0000001,  out: 0.0000004  },
  'gemini-pro':    { in: 0.0000035,  out: 0.0000105  },
  'gpt-4o-mini':   { in: 0.00000015, out: 0.0000006  },
  'gpt-4o':        { in: 0.000005,   out: 0.000015   },
};

const HOLON_SYS    = 'Jesteś agentem Holonu (ofshore.dev). Odpowiadaj precyzyjnie i zwięźle.';
const COLLECT_SYS  = 'Jesteś inteligencją zbiorową Holonu. Analizuj wielowymiarowo. Subsidiarity: zacznij od najprostszego.';

// ── Routing ───────────────────────────────────────────────────
function score(txt, urg='normal') {
  if (!txt || txt.length < 3) return 0;
  let s = Math.min(1.0, txt.trim().split(/\s+/).length / 250);
  if (/architektur|security|deploy|migration|refactor|strategia/i.test(txt)) s = Math.max(s, 0.65);
  if (/research|multi.agent|swarm|investigate/i.test(txt)) s = 1.0;
  if (urg === 'realtime') s = Math.min(s, 0.45);
  if (urg === 'batch')    s = Math.max(s, 0.85);
  return s;
}
function choosePath(s) {
  if (s >= 0.85) return 'collective';
  if (s >= 0.55) return 'deliberate';
  if (s >= 0.20) return 'intuitive';
  return 'reflex';
}

// ── Per-provider callers ──────────────────────────────────────
async function callOllama(messages, t0) {
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ model:'qwen2.5:0.5b', messages, stream:false }),
    signal: AbortSignal.timeout(4000),
  });
  const d = await r.json();
  return { text: d.message?.content||'', latency: Date.now()-t0, cost: 0, model: 'qwen2.5:0.5b' };
}

async function callClaude(model, messages, path, t0) {
  if (!ANT_KEY) throw new Error('No ANTHROPIC_API_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':ANT_KEY,'anthropic-version':'2023-06-01'},
    body: JSON.stringify({
      model: MODEL_IDS[model],
      max_tokens: path==='collective'?4096:path==='deliberate'?2048:1024,
      system: path==='collective' ? COLLECT_SYS : HOLON_SYS,
      messages,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const d = await r.json();
  if (d.error) throw new Error(`Claude ${d.error.type}: ${d.error.message}`);
  const iT=d.usage?.input_tokens||0, oT=d.usage?.output_tokens||0, p=PRICE[model];
  return { text:d.content?.[0]?.text||'', latency:Date.now()-t0, cost:iT*p.in+oT*p.out, model:MODEL_IDS[model], tokens:{input:iT,output:oT} };
}

async function callGemini(model, messages, path, t0) {
  if (!GEM_KEY) throw new Error('No GEMINI_API_KEY');
  const contents = messages.filter(m=>m.role!=='system')
    .map(m=>({ role: m.role==='assistant'?'model':'user', parts:[{text:m.content}] }));
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_IDS[model]}:generateContent?key=${GEM_KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ contents, generationConfig:{ maxOutputTokens: path==='collective'?4096:1024 } }),
      signal: AbortSignal.timeout(25000) }
  );
  const d = await r.json();
  if (d.error) throw new Error(`Gemini: ${d.error.message}`);
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text||'';
  const iT=d.usageMetadata?.promptTokenCount||0, oT=d.usageMetadata?.candidatesTokenCount||0, p=PRICE[model];
  return { text, latency:Date.now()-t0, cost:iT*p.in+oT*p.out, model:MODEL_IDS[model], tokens:{input:iT,output:oT} };
}

async function callOpenAI(model, messages, path, t0) {
  const key = OAI_KEY || (OR_KEY ? null : null);
  const url  = OR_KEY && !OAI_KEY ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
  const auth = OR_KEY && !OAI_KEY ? OR_KEY : OAI_KEY;
  if (!auth) throw new Error('No OPENAI_API_KEY or OPENROUTER_API_KEY');
  const r = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${auth}`},
    body: JSON.stringify({
      model: MODEL_IDS[model],
      messages: [{role:'system',content: path==='collective'?COLLECT_SYS:HOLON_SYS}, ...messages],
      max_tokens: path==='collective'?4096:path==='deliberate'?2048:1024,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const d = await r.json();
  if (d.error) throw new Error(`OpenAI: ${d.error.message}`);
  const iT=d.usage?.prompt_tokens||0, oT=d.usage?.completion_tokens||0, p=PRICE[model]||PRICE['gpt-4o'];
  return { text:d.choices?.[0]?.message?.content||'', latency:Date.now()-t0, cost:iT*p.in+oT*p.out, model:MODEL_IDS[model], tokens:{input:iT,output:oT} };
}

async function callLLM(path, messages, preferProvider=null) {
  const t0 = Date.now();
  const chain = preferProvider
    ? [preferProvider, ...PATH_PROVIDERS[path].filter(p=>p!==preferProvider)]
    : PATH_PROVIDERS[path];
  let lastErr;
  for (const provider of chain) {
    try {
      if (provider==='ollama')        return await callOllama(messages, t0);
      if (provider==='claude-haiku')  return await callClaude('claude-haiku',  messages, path, t0);
      if (provider==='claude-sonnet') return await callClaude('claude-sonnet', messages, path, t0);
      if (provider==='gemini-flash')  return await callGemini('gemini-flash',  messages, path, t0);
      if (provider==='gemini-pro')    return await callGemini('gemini-pro',    messages, path, t0);
      if (provider==='gpt-4o-mini')   return await callOpenAI('gpt-4o-mini',   messages, path, t0);
      if (provider==='gpt-4o')        return await callOpenAI('gpt-4o',        messages, path, t0);
    } catch(e) {
      lastErr = e;
      const isRate = /rate|529|quota|429/i.test(e.message||'');
      console.error(`[brain-router] ${provider} failed: ${e.message?.slice(0,80)}`);
      if (!isRate) break;
    }
  }
  throw lastErr || new Error('All providers exhausted');
}

// ── Simple cache ──────────────────────────────────────────────
const _cache = new Map();
function ck(txt) { return txt.toLowerCase().replace(/\s+/g,' ').trim().slice(0,200); }
function getC(k) { const e=_cache.get(k); return e&&e.exp>Date.now()?e.data:null; }
function setC(k, data, ttlHours=1) { _cache.set(k,{data,exp:Date.now()+ttlHours*3600000}); }

// ── Token auth ────────────────────────────────────────────────
async function validateToken(token, appName) {
  if (!token) return null;
  if (token === SECRET) return { valid:true, app:'admin', scope:['read','write','admin'] };
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/validate_live_token`, {
      method:'POST',
      headers:{'apikey':SB_ANON,'Content-Type':'application/json','Authorization':`Bearer ${SB_ANON}`},
      body: JSON.stringify({p_token:token, p_app_name:appName}),
      signal: AbortSignal.timeout(3000),
    });
    return await r.json();
  } catch { return null; }
}

// ── Routes ────────────────────────────────────────────────────
app.get('/health', async () => ({
  status:'ok', service:'brain-router-v3', ts:new Date().toISOString(),
  providers: {
    claude:      !!ANT_KEY,
    gemini:      !!GEM_KEY,
    openai:      !!OAI_KEY,
    openrouter:  !!OR_KEY,
    ollama:      true,
  },
  paths:['reflex','intuitive','deliberate','collective'],
  architecture:'multi-provider-failover',
}));

app.post('/auth/token', async (req, reply) => {
  if (req.headers['x-router-key'] !== SECRET) return reply.status(401).send({error:'unauthorized'});
  const b = req.body||{};
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/issue_live_token`,{
      method:'POST',
      headers:{'apikey':SB_SVC,'Content-Type':'application/json','Authorization':`Bearer ${SB_SVC}`},
      body: JSON.stringify({p_app_name:b.app_name||'unknown', p_scope:b.scope||['read','write']}),
    });
    return await r.json();
  } catch(e) { return reply.status(500).send({error:e.message}); }
});

app.post('/chat', async (req, reply) => {
  const tok=req.headers['x-app-token'], appName=req.headers['x-app-name']||'unknown';
  const urg=req.headers['x-urgency']||'normal';
  const auth = await validateToken(tok, appName);
  if (!auth?.valid) return reply.status(401).send({error:'invalid_or_expired_token',
    hint:'POST /auth/token with x-router-key header'});

  const b = req.body||{};
  const txt = b.prompt || b.messages?.find(m=>m.role==='user')?.content || '';
  if (!txt) return reply.status(400).send({error:'no_message'});

  const userId   = b.user_id || appName;
  const prefer   = b.prefer_provider || null;
  const cacheKey = ck(txt);
  const hit      = urg!=='realtime' && getC(cacheKey);
  if (hit) return {...hit, cached:true, user_id:userId};

  const complexity = score(txt, urg);
  const chosen     = b.force_path || choosePath(complexity);
  const messages   = b.messages   || [{role:'user', content:txt}];

  let res;
  try {
    res = await callLLM(chosen, messages, prefer);
  } catch(e) {
    try {
      res = await callLLM('deliberate', messages, null);
      res.fallback_from = chosen;
    } catch(e2) {
      return reply.status(503).send({error:'All providers failed', detail:e2.message});
    }
  }

  // Cache
  if (chosen!=='collective' && urg!=='realtime')
    setC(cacheKey, {text:res.text,path:chosen,model:res.model,complexity}, chosen==='reflex'?24:chosen==='intuitive'?6:1);

  // Async log to Supabase (fire & forget)
  if (SB_URL && SB_SVC) {
    fetch(`${SB_URL}/rest/v1/routing_decisions`,{
      method:'POST',
      headers:{'apikey':SB_SVC,'Authorization':`Bearer ${SB_SVC}`,'Content-Type':'application/json','Prefer':'return=minimal'},
      body:JSON.stringify({chosen_path:chosen,chosen_model:res.model,complexity_score:complexity,source_app:appName,user_id:userId}),
    }).catch(()=>{});
  }

  const labels={reflex:'Odruch Ollama €0',intuitive:'System 1 Haiku <1s',deliberate:'System 2 Sonnet 2-5s',collective:'Kolektyw 5-15s'};
  return { text:res.text, path:chosen, model:res.model,
    complexity:Math.round(complexity*1000)/1000,
    latency_ms:res.latency, cost_usd:res.cost||0,
    cached:false, app:appName, user_id:userId,
    reasoning:labels[chosen]||chosen,
    fallback_from:res.fallback_from||null,
    security:'zero-exposure' };
});

app.get('/stats', async () => {
  const cacheSize = _cache.size;
  return { cache_entries:cacheSize, ts:new Date().toISOString(),
    providers_available:{ claude:!!ANT_KEY, gemini:!!GEM_KEY, openai:!!(OAI_KEY||OR_KEY), ollama:true } };
});

await app.listen({ port: parseInt(process.env.PORT||'3000'), host:'0.0.0.0' });
console.log(`[brain-router-v3] Listening on :${process.env.PORT||3000}`);
