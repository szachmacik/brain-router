import Fastify from 'fastify';
import cors from '@fastify/cors';

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

// ── Env ──────────────────────────────────────────────
const SB_URL  = process.env.SUPABASE_URL;
const SB_ANON = process.env.SUPABASE_ANON_KEY;
const SB_SVC  = process.env.SUPABASE_SERVICE_KEY;
const SECRET  = process.env.ROUTER_SECRET || 'holon-brain-router-2026';
const OLLAMA  = process.env.OLLAMA_URL    || 'http://ollama:11434';
const ANT_KEY = process.env.ANTHROPIC_API_KEY;
const GEM_KEY = process.env.GEMINI_API_KEY;
const OAI_KEY = process.env.OPENAI_API_KEY;
const OR_KEY  = process.env.OPENROUTER_API_KEY;
const GRQ_KEY = process.env.GROQ_API_KEY;       // FREE: llama-3.3-70b, 100 req/h
const DSK_KEY = process.env.DEEPSEEK_API_KEY;   // CHEAP: $0.001/1k, best for code
const UPS_URL = process.env.UPSTASH_URL;        // Redis cache
const UPS_TOK = process.env.UPSTASH_TOKEN;      // Redis token

// ── Provider chain per path (cost-optimised) ────────
// reflex:     Ollama → Groq-fast (€0)
// intuitive:  Groq-70b → Haiku → Gemini-flash  (<1s, €0)
// deliberate: DeepSeek → Sonnet → GPT-4o        (cheap)
// collective: Sonnet → GPT-4o → Gemini-pro      (best)
const PATH_PROVIDERS = {
  reflex:     ['ollama',   'groq-8b'],
  intuitive:  ['groq-70b', 'claude-haiku',  'gemini-flash'],
  deliberate: ['deepseek', 'claude-sonnet', 'gpt-4o'],
  collective: ['claude-sonnet', 'gpt-4o', 'gemini-pro'],
};

const MODEL_IDS = {
  'claude-haiku':   'claude-haiku-4-5-20251001',
  'claude-sonnet':  'claude-sonnet-4-6',
  'gemini-flash':   'gemini-2.0-flash',
  'gemini-pro':     'gemini-1.5-pro',
  'gpt-4o-mini':    'gpt-4o-mini',
  'gpt-4o':         'gpt-4o',
  'groq-70b':       'llama-3.3-70b-versatile',
  'groq-8b':        'llama3-8b-8192',
  'deepseek':       'deepseek-chat',
};

const PRICE = {
  'claude-haiku':  { in: 0.00000025, out: 0.00000125 },
  'claude-sonnet': { in: 0.000003,   out: 0.000015   },
  'gemini-flash':  { in: 0.0000001,  out: 0.0000004  },
  'gemini-pro':    { in: 0.0000035,  out: 0.0000105  },
  'gpt-4o-mini':   { in: 0.00000015, out: 0.0000006  },
  'gpt-4o':        { in: 0.000005,   out: 0.000015   },
  'groq-70b':      { in: 0,          out: 0           }, // free tier
  'groq-8b':       { in: 0,          out: 0           }, // free tier
  'deepseek':      { in: 0.0000005,  out: 0.0000015  }, // ultra-cheap
};

const HOLON  = 'Jesteś agentem Holonu (ofshore.dev). Odpowiadaj precyzyjnie i zwięźle.';
const COLSYS = 'Jesteś inteligencją zbiorową Holonu. Analizuj wielowymiarowo. Subsidiarity: zacznij od najprostszego.';

// ── Routing ─────────────────────────────────────────
function score(txt, urg='normal') {
  if (!txt || txt.length < 3) return 0;
  let s = Math.min(1.0, txt.trim().split(/\s+/).length / 250);
  if (/architektur|security|deploy|migration|refactor|strategia/i.test(txt)) s = Math.max(s, 0.65);
  if (/research|multi.agent|swarm|investigate|zbadaj/i.test(txt)) s = 1.0;
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

// ── Upstash Redis cache ──────────────────────────────
async function cacheGet(key) {
  if (!UPS_URL || !UPS_TOK) return null;
  try {
    const r = await fetch(`${UPS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPS_TOK}` },
      signal: AbortSignal.timeout(1000),
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}
async function cacheSet(key, data, ttlSeconds=3600) {
  if (!UPS_URL || !UPS_TOK) return;
  try {
    await fetch(`${UPS_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPS_TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(data), ex: ttlSeconds }),
      signal: AbortSignal.timeout(1000),
    });
  } catch {}
}
function cacheKey(txt) {
  return 'br:' + txt.toLowerCase().replace(/\s+/g,' ').trim().slice(0,200);
}

// ── LLM callers ─────────────────────────────────────
async function callOllama(msgs, t0) {
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ model:'qwen2.5:0.5b', messages:msgs, stream:false }),
    signal: AbortSignal.timeout(4000),
  });
  const d = await r.json();
  return { text:d.message?.content||'', latency:Date.now()-t0, cost:0, model:'qwen2.5:0.5b' };
}

async function callClaude(model, msgs, path, t0) {
  if (!ANT_KEY) throw new Error('No ANTHROPIC_API_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':ANT_KEY,'anthropic-version':'2023-06-01'},
    body: JSON.stringify({
      model:MODEL_IDS[model],
      max_tokens:path==='collective'?4096:path==='deliberate'?2048:1024,
      system:path==='collective'?COLSYS:HOLON, messages:msgs,
    }),
    signal:AbortSignal.timeout(30000),
  });
  const d = await r.json();
  if (d.error) throw new Error(`Claude: ${d.error.message}`);
  const iT=d.usage?.input_tokens||0, oT=d.usage?.output_tokens||0, p=PRICE[model];
  return { text:d.content?.[0]?.text||'', latency:Date.now()-t0, cost:iT*p.in+oT*p.out, model:MODEL_IDS[model] };
}

async function callGroq(model, msgs, path, t0) {
  if (!GRQ_KEY) throw new Error('No GROQ_API_KEY');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${GRQ_KEY}`},
    body: JSON.stringify({
      model:MODEL_IDS[model],
      messages:[{role:'system',content:HOLON},...msgs],
      max_tokens:path==='deliberate'?2048:1024,
      temperature:0.3,
    }),
    signal:AbortSignal.timeout(8000),
  });
  const d = await r.json();
  if (d.error) throw new Error(`Groq: ${d.error.message}`);
  return { text:d.choices?.[0]?.message?.content||'', latency:Date.now()-t0, cost:0, model:MODEL_IDS[model] };
}

async function callDeepSeek(msgs, path, t0) {
  if (!DSK_KEY) throw new Error('No DEEPSEEK_API_KEY');
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${DSK_KEY}`},
    body: JSON.stringify({
      model:'deepseek-chat',
      messages:[{role:'system',content:HOLON},...msgs],
      max_tokens:path==='deliberate'?2048:1024,
    }),
    signal:AbortSignal.timeout(20000),
  });
  const d = await r.json();
  if (d.error) throw new Error(`DeepSeek: ${d.error.message}`);
  const iT=d.usage?.prompt_tokens||0, oT=d.usage?.completion_tokens||0, p=PRICE['deepseek'];
  return { text:d.choices?.[0]?.message?.content||'', latency:Date.now()-t0, cost:iT*p.in+oT*p.out, model:'deepseek-chat' };
}

async function callGemini(model, msgs, path, t0) {
  if (!GEM_KEY) throw new Error('No GEMINI_API_KEY');
  const contents = msgs.filter(m=>m.role!=='system')
    .map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}));
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_IDS[model]}:generateContent?key=${GEM_KEY}`,
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

async function callOpenAI(model, msgs, path, t0) {
  const auth = OAI_KEY || OR_KEY;
  const url  = !OAI_KEY && OR_KEY ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
  if (!auth) throw new Error('No OpenAI/OpenRouter key');
  const r = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${auth}`},
    body:JSON.stringify({
      model:MODEL_IDS[model],
      messages:[{role:'system',content:path==='collective'?COLSYS:HOLON},...msgs],
      max_tokens:path==='collective'?4096:path==='deliberate'?2048:1024,
    }),
    signal:AbortSignal.timeout(30000),
  });
  const d = await r.json();
  if (d.error) throw new Error(`OpenAI: ${d.error.message}`);
  const iT=d.usage?.prompt_tokens||0, oT=d.usage?.completion_tokens||0, p=PRICE[model]||PRICE['gpt-4o'];
  return { text:d.choices?.[0]?.message?.content||'', latency:Date.now()-t0, cost:iT*p.in+oT*p.out, model:MODEL_IDS[model] };
}

// ── Main router with auto-failover ──────────────────
async function callLLM(path, msgs, prefer=null) {
  const t0 = Date.now();
  const chain = prefer
    ? [prefer,...PATH_PROVIDERS[path].filter(p=>p!==prefer)]
    : PATH_PROVIDERS[path];
  let lastErr;
  for (const p of chain) {
    try {
      if (p==='ollama')        return await callOllama(msgs, t0);
      if (p==='groq-70b')      return await callGroq('groq-70b', msgs, path, t0);
      if (p==='groq-8b')       return await callGroq('groq-8b',  msgs, path, t0);
      if (p==='deepseek')      return await callDeepSeek(msgs, path, t0);
      if (p==='claude-haiku')  return await callClaude('claude-haiku',  msgs, path, t0);
      if (p==='claude-sonnet') return await callClaude('claude-sonnet', msgs, path, t0);
      if (p==='gemini-flash')  return await callGemini('gemini-flash',  msgs, path, t0);
      if (p==='gemini-pro')    return await callGemini('gemini-pro',    msgs, path, t0);
      if (p==='gpt-4o-mini')   return await callOpenAI('gpt-4o-mini',  msgs, path, t0);
      if (p==='gpt-4o')        return await callOpenAI('gpt-4o',        msgs, path, t0);
    } catch(e) {
      lastErr = e;
      const isRate = /rate|529|quota|429|overload/i.test(e.message||'');
      console.error(`[br] ${p} fail: ${e.message?.slice(0,60)}`);
      if (!isRate) break;
    }
  }
  throw lastErr || new Error('All providers exhausted');
}

// ── Auth ─────────────────────────────────────────────
async function validateToken(tok, app) {
  if (!tok) return null;
  if (tok === SECRET) return { valid:true, app:'admin' };
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/validate_live_token`, {
      method:'POST',
      headers:{'apikey':SB_ANON,'Content-Type':'application/json','Authorization':`Bearer ${SB_ANON}`},
      body:JSON.stringify({p_token:tok,p_app_name:app}),
      signal:AbortSignal.timeout(3000),
    });
    return await r.json();
  } catch { return null; }
}

// ── Routes ───────────────────────────────────────────
app.get('/health', async () => ({
  status:'ok', service:'brain-router-v4', ts:new Date().toISOString(),
  providers:{
    ollama:true, groq:!!GRQ_KEY, deepseek:!!DSK_KEY,
    claude:!!ANT_KEY, gemini:!!GEM_KEY,
    openai:!!(OAI_KEY||OR_KEY), cache:!!(UPS_URL&&UPS_TOK),
  },
  paths:['reflex','intuitive','deliberate','collective'],
  path_chains: PATH_PROVIDERS,
  version:'v4-groq-deepseek-upstash',
}));

app.post('/auth/token', async (req,reply) => {
  if (req.headers['x-router-key']!==SECRET) return reply.status(401).send({error:'unauthorized'});
  const b=req.body||{};
  try {
    const r=await fetch(`${SB_URL}/rest/v1/rpc/issue_live_token`,{
      method:'POST',
      headers:{'apikey':SB_SVC,'Content-Type':'application/json','Authorization':`Bearer ${SB_SVC}`},
      body:JSON.stringify({p_app_name:b.app_name||'unknown',p_scope:b.scope||['read','write']}),
    });
    return await r.json();
  } catch(e){return reply.status(500).send({error:e.message});}
});

app.post('/chat', async (req,reply) => {
  const tok=req.headers['x-app-token'], appName=req.headers['x-app-name']||'unknown';
  const urg=req.headers['x-urgency']||'normal';
  const auth=await validateToken(tok,appName);
  if (!auth?.valid) return reply.status(401).send({error:'invalid_or_expired_token',hint:'POST /auth/token'});

  const b=req.body||{};
  const txt=b.prompt||b.messages?.find(m=>m.role==='user')?.content||'';
  if (!txt) return reply.status(400).send({error:'no_message'});

  const userId=b.user_id||appName, prefer=b.prefer_provider||null;
  const ck=cacheKey(txt);

  // Upstash cache check
  if (urg!=='realtime') {
    const hit=await cacheGet(ck);
    if (hit) return {...hit, cached:true, cache_backend:'upstash', user_id:userId};
  }

  const complexity=score(txt,urg);
  const path=b.force_path||choosePath(complexity);
  const msgs=b.messages||[{role:'user',content:txt}];

  let res;
  try { res=await callLLM(path,msgs,prefer); }
  catch(e) {
    try { res=await callLLM('deliberate',msgs,null); res.fallback_from=path; }
    catch(e2) { return reply.status(503).send({error:'All providers failed',detail:e2.message}); }
  }

  const ttl={reflex:86400,intuitive:21600,deliberate:3600,collective:0}[path]||3600;
  const cacheData={text:res.text,path,model:res.model,complexity};
  if (ttl>0 && urg!=='realtime') await cacheSet(ck,cacheData,ttl);

  // Log to Supabase async
  if (SB_URL&&SB_SVC) fetch(`${SB_URL}/rest/v1/routing_decisions`,{
    method:'POST',
    headers:{'apikey':SB_SVC,'Authorization':`Bearer ${SB_SVC}`,'Content-Type':'application/json','Prefer':'return=minimal'},
    body:JSON.stringify({chosen_path:path,chosen_model:res.model,complexity_score:complexity,
      source_app:appName,user_id:userId,latency_ms:res.latency,cost_usd:res.cost||0}),
  }).catch(()=>{});

  const labels={
    reflex:'Odruch — Ollama/Groq €0 <200ms',
    intuitive:'System 1 — Groq-70b/Haiku <1s',
    deliberate:'System 2 — DeepSeek/Sonnet 2-5s',
    collective:'Kolektyw — Sonnet multi-step 5-15s',
  };
  return {
    text:res.text, path, model:res.model,
    complexity:Math.round(complexity*1000)/1000,
    latency_ms:res.latency, cost_usd:res.cost||0,
    cached:false, cache_backend: UPS_URL ? 'upstash' : 'memory',
    app:appName, user_id:userId,
    reasoning:labels[path]||path,
    fallback_from:res.fallback_from||null,
    providers_available:{groq:!!GRQ_KEY,deepseek:!!DSK_KEY,claude:!!ANT_KEY,gemini:!!GEM_KEY,openai:!!(OAI_KEY||OR_KEY)},
  };
});

app.get('/stats', async () => {
  const upstash = UPS_URL ? 'upstash-redis' : 'none';
  return {
    cache:upstash, ts:new Date().toISOString(),
    providers:{groq:!!GRQ_KEY,deepseek:!!DSK_KEY,claude:!!ANT_KEY,gemini:!!GEM_KEY,openai:!!(OAI_KEY||OR_KEY)},
    path_chains:PATH_PROVIDERS,
  };
});

await app.listen({ port:parseInt(process.env.PORT||'3000'), host:'0.0.0.0' });
console.log(`[brain-router-v4] :${process.env.PORT||3000} | Groq:${!!GRQ_KEY} DeepSeek:${!!DSK_KEY} Upstash:${!!(UPS_URL&&UPS_TOK)}`);
