import Fastify from 'fastify';
import cors from '@fastify/cors';
import Anthropic from '@anthropic-ai/sdk';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SB_URL    = process.env.SUPABASE_URL;
const SB_ANON   = process.env.SUPABASE_ANON_KEY;
const SB_SVC    = process.env.SUPABASE_SERVICE_KEY;
const SECRET    = process.env.ROUTER_SECRET || 'holon-brain-router-2026';
const OLLAMA    = process.env.OLLAMA_URL    || 'http://ollama:11434';

// ── Complexity: Subsidiarity engine ──────────────────────────────────────────
function score(text, urgency='normal') {
  const w = text.trim().split(/\s+/).length;
  let s = Math.min(1.0, w/250);
  if (/architektur|security|migration|strategia|pelna analiza|optymalizacja systemu/i.test(text)) s=Math.max(s,0.65);
  if (/research|zbadaj wszystko|multi.agent|swarm/i.test(text)) s=1.0;
  if (urgency==='realtime') s=Math.min(s,0.45);
  if (urgency==='batch')    s=Math.max(s,0.85);
  return s;
}
function path(s) {
  if (s>=0.85) return 'collective';
  if (s>=0.55) return 'deliberate';
  if (s>=0.20) return 'intuitive';
  return 'reflex';
}

// ── Token broker (Supabase RPC) ───────────────────────────────────────────────
async function issueToken(app, scope) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/issue_live_token`, {
    method:'POST', signal:AbortSignal.timeout(5000),
    headers:{'apikey':SB_SVC,'Authorization':`Bearer ${SB_SVC}`,'Content-Type':'application/json'},
    body:JSON.stringify({p_app_name:app, p_scope:scope||['read','write']})
  });
  return r.json();
}
async function validateToken(token, appName) {
  if (token===SECRET) return {valid:true,app:'admin'};
  const r = await fetch(`${SB_URL}/rest/v1/rpc/validate_live_token`, {
    method:'POST', signal:AbortSignal.timeout(3000),
    headers:{'apikey':SB_ANON,'Authorization':`Bearer ${SB_ANON}`,'Content-Type':'application/json'},
    body:JSON.stringify({p_token:token, p_app_name:appName||'unknown'})
  });
  return r.json().catch(()=>({valid:false}));
}

// ── In-memory semantic cache ──────────────────────────────────────────────────
const cache = new Map();
function ck(t) { return t.toLowerCase().replace(/\s+/,' ').trim().slice(0,200); }
function getC(k) {
  const e=cache.get(k); if(!e) return null;
  if(Date.now()>e.exp){cache.delete(k);return null;} return e;
}
function setC(k,d,ttlH=6) {
  cache.set(k,{...d,exp:Date.now()+ttlH*3600000});
  if(cache.size>500){const old=[...cache.entries()].sort((a,b)=>a[1].exp-b[1].exp)[0];cache.delete(old[0]);}
}

// ── Model callers ─────────────────────────────────────────────────────────────
async function callOllama(msgs) {
  const t0=Date.now();
  const r=await fetch(`${OLLAMA}/api/chat`,{method:'POST',signal:AbortSignal.timeout(4000),
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:'qwen2.5:0.5b',messages:msgs,stream:false})});
  const d=await r.json();
  return {text:d.message?.content||'',latency:Date.now()-t0,cost:0,model:'qwen2.5:0.5b'};
}

const MODELS={intuitive:'claude-haiku-4-5-20251001',deliberate:'claude-sonnet-4-5-20251001',collective:'claude-sonnet-4-5-20251001'};
const PRICE={intuitive:{in:2.5e-7,out:1.25e-6},deliberate:{in:3e-6,out:1.5e-5},collective:{in:3e-6,out:1.5e-5}};

async function callClaude(p, msgs) {
  const t0=Date.now(), m=MODELS[p], mx=p==='collective'?4096:p==='deliberate'?2048:1024;
  const sys=p==='collective'
    ?'Inteligencja zbiorowa Holonu. Subsidiarity: zacznij od najprostszego. Pleroma: zostaw system lepszym.'
    :'Agent Holonu (ofshore.dev). Odpowiadaj precyzyjnie.';
  const resp=await anthropic.messages.create({model:m,max_tokens:mx,system:sys,messages:msgs});
  const iT=resp.usage?.input_tokens||0,oT=resp.usage?.output_tokens||0,pr=PRICE[p];
  return {text:resp.content[0]?.text||'',latency:Date.now()-t0,cost:iT*pr.in+oT*pr.out,model:m};
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', async ()=>({
  status:'ok',service:'brain-router-v2',ts:new Date().toISOString(),
  architecture:'zero-exposure',cache_entries:cache.size,
  paths:['reflex','intuitive','deliberate','collective']
}));

app.post('/auth/token', async (req,reply)=>{
  if(req.headers['x-router-key']!==SECRET) return reply.status(401).send({error:'unauthorized'});
  return issueToken(req.body?.app_name||'unknown', req.body?.scope);
});

app.post('/auth/rotate', async (req,reply)=>{
  if(req.headers['x-router-key']!==SECRET) return reply.status(401).send({error:'unauthorized'});
  const r=await fetch(`${SB_URL}/rest/v1/rpc/rotate_coolify_token`,{method:'POST',
    headers:{'apikey':SB_SVC,'Authorization':`Bearer ${SB_SVC}`,'Content-Type':'application/json'},body:'{}'});
  return {rotated:true,result:await r.json()};
});

app.post('/security/exposure', async (req)=>{
  const b=req.body||{};
  fetch(`${SB_URL}/rest/v1/rpc/report_token_exposure`,{method:'POST',
    headers:{'apikey':SB_ANON,'Authorization':`Bearer ${SB_ANON}`,'Content-Type':'application/json'},
    body:JSON.stringify({p_token_name:b.token||'unknown',p_source:'brain-router',p_details:b.details||''})
  }).catch(()=>{});
  return {reported:true,action:'rotation_queued'};
});

app.post('/chat', async (req,reply)=>{
  const tok=req.headers['x-app-token'], app=req.headers['x-app-name']||'unknown', urg=req.headers['x-urgency']||'normal';
  const auth=await validateToken(tok,app);
  if(!auth?.valid) return reply.status(401).send({error:'invalid_or_expired_token',
    hint:'POST /auth/token with x-router-key to get a 1h token'});

  const b=req.body||{};
  const txt=b.prompt||b.messages?.find(m=>m.role==='user')?.content||'';
  if(!txt) return reply.status(400).send({error:'no_message'});

  const k=ck(txt), hit=urg!=='realtime'&&getC(k);
  if(hit) return {...hit,cached:true};

  const complexity=score(txt,urg), chosen=b.force_path||path(complexity);
  const msgs=b.messages||[{role:'user',content:txt}];

  let res;
  try {
    res=chosen==='reflex' ? await callOllama(msgs) : await callClaude(chosen,msgs);
  } catch(e) {
    const fb=chosen==='reflex'?'intuitive':'deliberate';
    res=await callClaude(fb,msgs);
    res.fallback_from=chosen;
  }

  if(chosen!=='collective'&&urg!=='realtime')
    setC(k,{text:res.text,path:chosen,model:res.model,complexity},chosen==='reflex'?24:chosen==='intuitive'?6:1);

  // Log async (fire & forget)
  fetch(`${SB_URL}/rest/v1/routing_decisions`,{method:'POST',
    headers:{'apikey':SB_SVC,'Authorization':`Bearer ${SB_SVC}`,'Content-Type':'application/json','Prefer':'return=minimal'},
    body:JSON.stringify({chosen_path:chosen,chosen_model:res.model,complexity_score:complexity,source_app:app,task_type:'chat'})
  }).catch(()=>{});

  const labels={reflex:'Odruch Ollama €0',intuitive:'System 1 Haiku <1s',deliberate:'System 2 Sonnet 2-5s',collective:'Kolektyw 5-15s'};
  return {text:res.text,path:chosen,model:res.model,complexity:Math.round(complexity*1000)/1000,
    latency_ms:res.latency,cost_usd:res.cost||0,cached:false,app,
    reasoning:labels[chosen],security:'zero-exposure'};
});

await app.listen({port:parseInt(process.env.PORT||'3000'),host:'0.0.0.0'});
