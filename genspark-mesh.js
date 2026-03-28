
// ═══════════════════════════════════════════════════════════════
// GENSPARK MESH — L4 Membrane
// Pełna integracja: L1+L2+L3 + brain-router + sentinel + fnn
// Zegar atomowy synchronizujący wszystkie membrany
// Adaptive routing: wybiera optymalną membranę per request
// ofshore.dev mesh · mesh.ofshore.dev
// ═══════════════════════════════════════════════════════════════

const CORS = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type"};
const UPS  = "https://fresh-walleye-84119.upstash.io";
const UT   = "gQAAAAAAAUiXAAIncDEwMjljNTI2ZGQ5OWQ0OGJlOTFmYWU2YjQ2OGI0NmIyZXAxODQxMTk";
const TG   = "8394457153:AAFZQ4eMHaiAnmwejmTfWZHI_5KSqhXgCXg";
const CHAT = "8149345223";

// Atomic clock — synchronized across membranes
let _seq = 0;
const atomicNs = () => BigInt(Date.now()) * 1000000n + BigInt((_seq++) % 1000);
const atomicStr = () => String(atomicNs());

const J = (d,s=200) => new Response(JSON.stringify(d),{status:s,headers:Object.assign({"Content-Type":"application/json","X-Atomic-NS":atomicStr(),"X-Membrane":"L4"},CORS)});
const tg = (msg) => fetch(`https://api.telegram.org/bot${TG}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:CHAT,text:msg})}).catch(()=>{});

// Membrane registry
const MEMBRANES = {
  L1: { url:"https://genspark.ofshore.dev",    name:"Genspark 1:1",       weight:0.3, caps:["chat","slides","sheets","clone"] },
  L2: { url:"https://genspark-enhanced.maciej-koziej01.workers.dev", name:"Enhanced MoA", weight:0.4, caps:["chat_moa","research","slides_hd"] },
  L3: { url:"https://genspark-multiclone.maciej-koziej01.workers.dev", name:"MultiClone", weight:0.2, caps:["clone_factory","batch","provider_compare"] },
};

// Mesh workers
const MESH = {
  brain:     "https://brain-router.ofshore.dev",
  sentinel:  "https://sentinel.maciej-koziej01.workers.dev",
  fnn:       "https://fnn-orchestrator.maciej-koziej01.workers.dev",
  mcp:       "https://mcp-gateway.maciej-koziej01.workers.dev",
  adaptive:  "https://adaptive-router.maciej-koziej01.workers.dev",
  agent:     "https://agent-router.maciej-koziej01.workers.dev",
  benchmark: "https://genspark-benchmark.maciej-koziej01.workers.dev",
};

const uSet = (k,v,ttl=3600) => fetch(`${UPS}/set/${encodeURIComponent(k)}/${encodeURIComponent(JSON.stringify(v))}?ex=${ttl}`,{method:"POST",headers:{"Authorization":"Bearer "+UT}});
const uGet = (k) => fetch(`${UPS}/get/${encodeURIComponent(k)}`,{headers:{"Authorization":"Bearer "+UT}}).then(r=>r.json()).then(d=>d.result?JSON.parse(d.result):null).catch(()=>null);
const uIncr = (k) => fetch(`${UPS}/incr/${encodeURIComponent(k)}`,{method:"POST",headers:{"Authorization":"Bearer "+UT}}).then(r=>r.json()).then(d=>d.result||0).catch(()=>0);

// ── Adaptive membrane router ──────────────────────────────────
function selectMembrane(query="", mode="auto") {
  if(mode==="moa" || mode==="research" || query.length > 200) return "L2";
  if(mode==="clone" || mode==="factory") return "L3";
  if(mode==="l1" || mode==="1to1") return "L1";
  // Auto: route by complexity
  const complex = /research|analyze|compare|deep|multi|batch|factory/i.test(query);
  return complex ? "L2" : "L1";
}

// ── Full mesh health check ────────────────────────────────────
async function meshHealthCheck() {
  const ns = atomicStr();
  const all = {...Object.fromEntries(Object.entries(MEMBRANES).map(([k,v])=>[`membrane_${k}`,v.url+"/health"])),
               ...Object.fromEntries(Object.entries(MESH).map(([k,v])=>[`mesh_${k}`,v+"/health"]))};
  
  const results = await Promise.allSettled(
    Object.entries(all).map(([name,url]) => {
      const start = Date.now();
      return fetch(url,{signal:AbortSignal.timeout(6000)})
        .then(r=>({name,url,ok:r.ok,status:r.status,latency:Date.now()-start}))
        .catch(e=>({name,url,ok:false,status:0,latency:Date.now()-start,error:e.message?.slice(0,50)}));
    })
  );
  
  const health = results.map(r=>r.status==="fulfilled"?r.value:r.reason);
  const alive = health.filter(h=>h.ok).length;
  const total = health.length;
  
  // Save health snapshot to Upstash
  await uSet("mesh:health:latest", {health,alive,total,ns,ts:new Date().toISOString()}, 300);
  
  return {health, alive, total, pct:Math.round(alive/total*100), ns};
}

// ── Atomic clock sync ─────────────────────────────────────────
async function syncAtomicClock() {
  const ns = atomicStr();
  const epoch = Date.now();
  const checksum = btoa(ns.slice(-8)+epoch.toString(36));
  
  await uSet("atomic:clock:sync", {
    ns, epoch, checksum,
    ts: new Date().toISOString(),
    membranes: Object.keys(MEMBRANES),
    mesh: Object.keys(MESH)
  }, 60);
  
  return {ns, epoch, checksum};
}

// ── MoA via L2 ────────────────────────────────────────────────
async function callMoA(message, mode="auto") {
  const r = await fetch(`${MEMBRANES.L2.url}/v1/chat`,{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({message,mode}),
    signal:AbortSignal.timeout(30000)
  });
  return r.json();
}

// ── MAIN HANDLER ─────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const ns = atomicStr();
    
    if(request.method==="OPTIONS") return new Response(null,{headers:CORS});
    
    // ── Membrane status ────────────────────────────────────────
    if(p==="/health") return J({
      service:"genspark-mesh",
      layer:"L4",
      version:"1.0",
      atomic_ns:ns,
      membrane:{
        permeability:1.0,
        capabilities:[
          "adaptive_routing","mesh_health","atomic_sync",
          "moa_proxy","clone_factory_proxy","full_mesh_status",
          "membrane_benchmark","cross_layer_analysis"
        ],
        membranes:Object.keys(MEMBRANES),
        mesh_workers:Object.keys(MESH)
      }
    });
    
    // ── Full mesh status ──────────────────────────────────────
    if(p==="/v1/mesh/status") {
      const [health, clock] = await Promise.all([meshHealthCheck(), syncAtomicClock()]);
      return J({...health, clock, layer:"L4"});
    }
    
    // ── Atomic clock ──────────────────────────────────────────
    if(p==="/v1/atomic") {
      const clock = await syncAtomicClock();
      return J({...clock, layer:"L4", membranes:["L1","L2","L3","L4"]});
    }
    
    // ── Adaptive chat (auto-routes to best membrane) ──────────
    if(p==="/v1/chat" && request.method==="POST") {
      const body = await request.json().catch(()=>({}));
      const {message="", mode="auto"} = body;
      if(!message) return J({error:"message required"},400);
      
      const selectedLayer = selectMembrane(message, mode);
      const membrane = MEMBRANES[selectedLayer];
      const start = Date.now();
      
      // Track request
      await uIncr(`mesh:requests:${selectedLayer}`);
      
      try {
        const r = await fetch(`${membrane.url}/v1/chat`,{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify(body),
          signal:AbortSignal.timeout(30000)
        });
        const d = await r.json();
        return J({
          ...d,
          routed_to: selectedLayer,
          membrane_name: membrane.name,
          routing_reason: `complexity=${message.length>200?"high":"low"} mode=${mode}`,
          latency_ms: Date.now()-start,
          atomic_ns: ns,
          layer:"L4"
        });
      } catch(e) {
        // Fallback to L1
        const fb = await fetch(`${MEMBRANES.L1.url}/v1/chat`,{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify(body),signal:AbortSignal.timeout(20000)
        }).then(r=>r.json()).catch(()=>({error:"all membranes failed"}));
        return J({...fb,routed_to:"L1",fallback:true,original_target:selectedLayer,layer:"L4"});
      }
    }
    
    // ── Cross-membrane benchmark ──────────────────────────────
    if(p==="/v1/benchmark/membrane" && request.method==="POST") {
      const {task="Explain AI in 2 sentences"} = await request.json().catch(()=>({}));
      const start = Date.now();
      
      const tests = await Promise.allSettled(
        Object.entries(MEMBRANES).map(([layer,m]) => {
          const t = Date.now();
          return fetch(`${m.url}/v1/chat`,{
            method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({message:task}),
            signal:AbortSignal.timeout(20000)
          }).then(r=>r.json())
            .then(d=>({layer,name:m.name,content:d.content?.slice(0,200),latency:Date.now()-t,ok:true}))
            .catch(e=>({layer,name:m.name,ok:false,error:e.message,latency:Date.now()-t}));
        })
      );
      
      const results = tests.map(t=>t.status==="fulfilled"?t.value:t.reason);
      const fastest = results.filter(r=>r.ok).sort((a,b)=>a.latency-b.latency)[0];
      
      return J({
        task, results,
        fastest_layer: fastest?.layer,
        total_ms: Date.now()-start,
        atomic_ns: ns,
        layer:"L4"
      });
    }
    
    // ── Clone via optimal membrane ────────────────────────────
    if(p==="/v1/clone/optimal" && request.method==="POST") {
      const body = await request.json().catch(()=>({}));
      if(!body.url) return J({error:"url required"},400);
      
      // L3 for factory, L1 for simple clone
      const target = body.factory ? MEMBRANES.L3 : MEMBRANES.L1;
      const endpoint = body.factory ? "/v1/clone/factory" : "/clone";
      
      const r = await fetch(`${target.url}${endpoint}`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify(body),signal:AbortSignal.timeout(60000)
      });
      const d = await r.json();
      return J({...d,routed_to:body.factory?"L3":"L1",layer:"L4",atomic_ns:ns});
    }
    
    // ── Sentinel proxy ────────────────────────────────────────
    if(p.startsWith("/v1/sentinel")) {
      const sentinelPath = p.replace("/v1/sentinel","") || "/status";
      const r = await fetch(`${MESH.sentinel}${sentinelPath}`,{
        method:request.method,
        headers:{"Content-Type":"application/json"},
        body:request.method==="POST"?await request.text():undefined,
        signal:AbortSignal.timeout(15000)
      });
      const d = await r.json();
      return J({...d,proxied_via:"L4",atomic_ns:ns});
    }
    
    // ── UI: mesh dashboard ────────────────────────────────────
    if(p==="/" || p==="/index.html") {
      // Serve L1 UI with L4 badge + inject mesh JS
      const l1 = await fetch(`${MEMBRANES.L1.url}/`,{signal:AbortSignal.timeout(10000)}).then(r=>r.text()).catch(()=>"");
      const html = l1
        .replace('<title>Genspark','<title>Genspark Mesh')
        .replace('by ofshore.dev','by ofshore.dev · L4 Mesh')
        .replace('</head>',`
<style>
.l4-badge{position:fixed;top:8px;right:10px;z-index:9999;padding:3px 10px;background:linear-gradient(135deg,#0f7fff,#7c5cff,#10b981);color:white;border-radius:20px;font-size:10px;font-weight:700;font-family:monospace;animation:glow 2s infinite alternate}
@keyframes glow{from{box-shadow:0 0 5px rgba(15,127,255,0.5)}to{box-shadow:0 0 15px rgba(124,92,255,0.8)}}
.mesh-status{position:fixed;bottom:20px;right:10px;z-index:9999;padding:6px 12px;background:rgba(10,10,20,0.9);border:1px solid rgba(15,127,255,0.3);color:#4a9eff;border-radius:8px;font-size:10px;font-family:monospace}
</style></head>`)
        .replace('<body>',`<body>
<div class="l4-badge">🌐 L4 Mesh AI</div>
<div class="mesh-status" id="mesh-st">⟳ checking mesh...</div>
<script>
setTimeout(async()=>{
  try{
    const r=await fetch('/v1/mesh/status');
    const d=await r.json();
    document.getElementById('mesh-st').textContent='🟢 '+d.alive+'/'+d.total+' alive · '+d.clock?.ns?.slice(-6)+'ns';
  }catch(e){document.getElementById('mesh-st').textContent='⚠️ mesh check failed';}
},2000);
// Patch send() to show routing info
const origFetch=window.fetch;
window.fetch=function(url,...args){
  if(url==='/v1/chat'){
    return origFetch('/v1/chat',...args).then(async r=>{
      const clone=r.clone();
      const d=await clone.json();
      if(d.routed_to){console.log('[L4 mesh] routed to',d.routed_to,'(',d.membrane_name,')',d.latency_ms+'ms');}
      return r;
    });
  }
  return origFetch(url,...args);
};
</script>`);
      return new Response(html||"<h1>L4 Mesh</h1>",{headers:{"Content-Type":"text/html;charset=utf-8","X-Membrane":"L4","X-Atomic-NS":ns}});
    }
    
    // Universal proxy to L1 for anything else
    try {
      const r = await fetch(`${MEMBRANES.L1.url}${p}`,{
        method:request.method,
        headers:request.headers,
        body:["POST","PUT"].includes(request.method)?await request.text():undefined,
        signal:AbortSignal.timeout(25000)
      });
      const body = await r.text();
      return new Response(body,{status:r.status,headers:Object.assign({"X-Membrane":"L4","X-Proxied-To":"L1","X-Atomic-NS":ns},CORS)});
    } catch(e) {
      return J({error:"proxy failed",layer:"L4",target:p},502);
    }
  },
  
  // Cron: co 10 min — atomic sync + mesh health
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([
      syncAtomicClock(),
      meshHealthCheck(),
    ]));
  }
};
