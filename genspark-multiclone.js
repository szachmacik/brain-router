// v1774664640
// ═══════════════════════════════════════════════════════════════
// GENSPARK MULTICLONE — L3 Membrane
// Clone Factory: klonuje dowolną aplikację z auto-wyborem
// dostawców (Groq/Cloudflare AI/OpenAI), generuje warianty,
// porównuje benchmark, deployuje optymalny.
// ofshore.dev mesh · multiclone.ofshore.dev
// ═══════════════════════════════════════════════════════════════

const CORS = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type"};
const UPS  = "https://fresh-walleye-84119.upstash.io";
const UT   = "gQAAAAAAAUiXAAIncDEwMjljNTI2ZGQ5OWQ0OGJlOTFmYWU2YjQ2OGI0NmIyZXAxODQxMTk";
const TG   = "8394457153:AAFZQ4eMHaiAnmwejmTfWZHI_5KSqhXgCXg";
const CHAT = "8149345223";

// Atomic ns
let _s = 0;
const ns = () => BigInt(Date.now()) * 1000000n + BigInt((_s++) % 1000);

const J = (d,s=200) => new Response(JSON.stringify(d),{status:s,headers:Object.assign({"Content-Type":"application/json"},CORS)});
const tg = (msg) => fetch(`https://api.telegram.org/bot${TG}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:CHAT,text:msg})}).catch(()=>{});

// ── Provider registry ─────────────────────────────────────────
const PROVIDERS = {
  groq_70b:  { name:"Groq Llama 3.3 70B", cost:0.000, speed:"fast",   quality:0.82 },
  groq_8b:   { name:"Groq Llama 3.1 8B",  cost:0.000, speed:"instant",quality:0.70 },
  cf_ai:     { name:"Cloudflare AI",       cost:0.000, speed:"fast",   quality:0.75 },
  groq_mix:  { name:"Groq Mixtral 8x7B",  cost:0.000, speed:"fast",   quality:0.78 },
};

// ── Groq call ────────────────────────────────────────────────
const groq = async (prompt, gk, model="llama-3.3-70b-versatile", maxTok=1500) => {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions",{
    method:"POST",
    headers:{"Authorization":"Bearer "+gk,"Content-Type":"application/json"},
    body:JSON.stringify({model,max_tokens:maxTok,messages:[{role:"user",content:prompt.slice(0,3000)}]}),
    signal:AbortSignal.timeout(25000)
  });
  const d = await r.json();
  return d.choices?.[0]?.message?.content||"";
};

// ── Cloudflare AI call ────────────────────────────────────────
const cfai = async (prompt, env) => {
  if(!env?.AI) return "";
  try {
    const r = await env.AI.run("@cf/meta/llama-3-8b-instruct",{messages:[{role:"user",content:prompt.slice(0,2000)}]});
    return r?.response || "";
  } catch(e) { return ""; }
};

// ── Upstash ──────────────────────────────────────────────────
const uSet = (k,v,ttl=86400) => fetch(`${UPS}/set/${encodeURIComponent(k)}/${encodeURIComponent(JSON.stringify(v))}?ex=${ttl}`,{method:"POST",headers:{"Authorization":"Bearer "+UT}});
const uGet = (k) => fetch(`${UPS}/get/${encodeURIComponent(k)}`,{headers:{"Authorization":"Bearer "+UT}}).then(r=>r.json()).then(d=>d.result?JSON.parse(d.result):null).catch(()=>null);

// ── Clone Factory ─────────────────────────────────────────────
async function cloneFactory(targetUrl, options={}, env) {
  const { variant="all", usage="medium", budget=50 } = options;
  const jobId = "mcl-"+Date.now().toString(36);
  const atomic = String(ns());
  const gk = env?.GROQ_KEY || "";
  
  await tg(`🏭 CloneFactory START\nURL: ${targetUrl}\nJob: ${jobId}\nVariant: ${variant}`);
  
  // Step 1: Scrape
  let html = "", appName = "App";
  try {
    const r = await fetch(targetUrl,{headers:{"User-Agent":"Mozilla/5.0"},signal:AbortSignal.timeout(15000)});
    html = await r.text();
    appName = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.slice(0,60) || targetUrl.split("/")[2];
  } catch(e) {}
  
  // Step 2: Analyze with multiple providers
  const prompts = {
    analysis: `Analyze web app: ${targetUrl}. HTML: ${html.slice(0,1500)}. Return JSON: {app_name,category,core_features:[],tech_stack:[],value_prop,api_endpoints:[],complexity:"simple|medium|complex"}`,
    providers: `What API providers does ${targetUrl} likely use? HTML: ${html.slice(0,1000)}. Return JSON array: [{name,category,confidence}]`,
  };
  
  // Run analysis in parallel across providers
  const [groqAnalysis, groqProviders, cfAnalysis] = await Promise.allSettled([
    groq(prompts.analysis, gk, "llama-3.3-70b-versatile", 600),
    groq(prompts.providers, gk, "llama-3.1-8b-instant", 300),
    cfai(prompts.analysis, env),
  ]);
  
  let analysis = {app_name:appName, category:"web_app", core_features:[], tech_stack:[], value_prop:"", complexity:"medium"};
  try { Object.assign(analysis, JSON.parse((groqAnalysis.value||"{}").replace(/```json|```/g,"").trim())); } catch(e) {}
  
  let detectedProviders = [];
  try { detectedProviders = JSON.parse((groqProviders.value||"[]").replace(/```json|```/g,"").trim()); } catch(e) {}
  
  // Step 3: Generate code variants in parallel
  const codePrompt = (prov) => `Generate FastAPI clone of ${analysis.app_name} (${targetUrl}). Features: ${analysis.core_features.slice(0,5).join(",")}. Use ${prov} as LLM. Return ONLY Python code from 'from fastapi'.`;
  
  const variants_to_run = variant==="all" ? ["groq_70b","groq_8b","groq_mix"] : [variant];
  const model_map = {groq_70b:"llama-3.3-70b-versatile", groq_8b:"llama-3.1-8b-instant", groq_mix:"mixtral-8x7b-32768"};
  
  const codeResults = await Promise.allSettled(
    variants_to_run.map(v => 
      groq(codePrompt(PROVIDERS[v]?.name||"Groq"), gk, model_map[v]||"llama-3.3-70b-versatile", 1800)
        .then(code => ({variant:v, code, size:code.length, provider:PROVIDERS[v]}))
    )
  );
  
  const generatedVariants = codeResults
    .filter(r=>r.status==="fulfilled" && r.value.code.length > 100)
    .map(r=>r.value);
  
  // Step 4: Auto-benchmark costs
  const tiers = {light:{chat:50,img:2,calls:0},medium:{chat:200,img:10,calls:5},heavy:{chat:1000,img:50,calls:20}};
  const t = tiers[usage]||tiers.medium;
  const costs = {
    A: {total: t.chat*0.001*1.75 + t.img*0.04 + t.calls*3*0.073 + 20, label:"GPT-5.2 stack"},
    B: {total: t.chat*0.001*0.59 + t.img*0 + t.calls*3*0.013 + 5, label:"Groq+FLUX free"},
    C: {total: t.calls*3*0.013 + 12, label:"ofshore mesh"},
  };
  
  // Step 5: Advisor recommendation
  const savings_B = Math.round((costs.A.total-costs.B.total)/Math.max(costs.A.total,0.01)*100);
  const rec = budget <= costs.B.total ? "C" : budget <= costs.A.total ? "B" : "A";
  
  // Save to Upstash
  const result = {
    job_id: jobId, atomic_ns: atomic, source_url: targetUrl,
    analysis, detected_providers: detectedProviders,
    variants: generatedVariants.map(v=>({variant:v.variant,size:v.size,provider:v.provider?.name})),
    best_variant: generatedVariants.sort((a,b)=>b.size-a.size)[0]?.variant || "groq_70b",
    best_code: generatedVariants[0]?.code?.slice(0,1000) || "",
    benchmark: {costs, savings_B_pct:savings_B, recommended:rec},
    layer: "L3"
  };
  await uSet(`multiclone:${jobId}`, result);
  
  await tg(`🏭 CloneFactory DONE\nJob: ${jobId}\nApp: ${appName}\nVariants: ${generatedVariants.length}\nBench A=$${costs.A.total.toFixed(2)} B=$${costs.B.total.toFixed(2)} C=$${costs.C.total.toFixed(2)}\nRec: ${rec}`);
  
  return result;
}

// ── MAIN HANDLER ─────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const atomic = String(ns());
    
    if(request.method==="OPTIONS") return new Response(null,{headers:CORS});
    
    if(p==="/health") return J({
      service:"genspark-multiclone",
      layer:"L3",
      version:"1.0",
      membrane:{
        permeability:1.0,
        capabilities:["clone_factory","multi_variant","auto_benchmark","provider_swap","atomic_clock"],
        atomic_ns:atomic,
        providers:Object.keys(PROVIDERS)
      },
      l1:"https://genspark.ofshore.dev",
      l2:"https://enhanced.ofshore.dev"
    });
    
    // ── Clone Factory ─────────────────────────────────────────
    if(p==="/v1/clone/factory" && request.method==="POST") {
      const body = await request.json().catch(()=>({}));
      const {url:targetUrl, variant, usage, budget, deploy=false} = body;
      if(!targetUrl) return J({error:"url required"},400);
      const result = await cloneFactory(targetUrl, {variant, usage, budget}, env);
      return J(result);
    }
    
    // ── Multi-URL clone (batch) ────────────────────────────────
    if(p==="/v1/clone/batch" && request.method==="POST") {
      const {urls=[], usage="medium"} = await request.json().catch(()=>({}));
      if(!urls.length) return J({error:"urls array required"},400);
      
      const jobs = await Promise.allSettled(
        urls.slice(0,5).map(u => cloneFactory(u, {variant:"groq_70b", usage}, env))
      );
      
      const results = jobs.map((j,i)=>({
        url:urls[i],
        ok: j.status==="fulfilled",
        job_id: j.status==="fulfilled" ? j.value.job_id : null,
        app: j.status==="fulfilled" ? j.value.analysis?.app_name : null,
        error: j.status==="rejected" ? j.reason?.message : null,
      }));
      
      return J({batch_size:urls.length, results, atomic_ns:atomic, layer:"L3"});
    }
    
    // ── Get job result ────────────────────────────────────────
    if(p==="/v1/clone/status") {
      const jobId = url.searchParams.get("id")||"";
      const data = await uGet(`multiclone:${jobId}`);
      if(!data) return J({error:"job not found",job_id:jobId},404);
      return J(data);
    }
    
    // ── List known cloneable apps ─────────────────────────────
    if(p==="/v1/apps") return J({
      curated_apps:[
        {name:"Genspark",url:"https://genspark.ai",category:"ai_workspace",status:"cloned_l1"},
        {name:"Notion",url:"https://notion.so",category:"productivity",status:"available"},
        {name:"Linear",url:"https://linear.app",category:"project_management",status:"available"},
        {name:"Perplexity",url:"https://perplexity.ai",category:"ai_search",status:"available"},
        {name:"Cursor",url:"https://cursor.sh",category:"ai_ide",status:"available"},
        {name:"Vercel v0",url:"https://v0.dev",category:"ai_generator",status:"available"},
      ],
      layer:"L3",atomic_ns:atomic
    });
    
    // ── Provider comparison ────────────────────────────────────
    if(p==="/v1/providers/compare" && request.method==="POST") {
      const {prompt, gk_override} = await request.json().catch(()=>({}));
      if(!prompt) return J({error:"prompt required"},400);
      const gk = gk_override || env?.GROQ_KEY || "";
      
      const models = [
        {id:"llama-3.3-70b-versatile",name:"Groq 70B"},
        {id:"llama-3.1-8b-instant",name:"Groq 8B"},
        {id:"mixtral-8x7b-32768",name:"Groq Mixtral"},
      ];
      
      const start = Date.now();
      const results = await Promise.allSettled(
        models.map(m => {
          const t = Date.now();
          return groq(prompt, gk, m.id, 300)
            .then(text => ({...m, text, latency:Date.now()-t, cost:0}));
        })
      );
      
      return J({
        prompt,
        results: results.filter(r=>r.status==="fulfilled").map(r=>r.value),
        total_ms: Date.now()-start,
        atomic_ns: atomic,
        layer: "L3"
      });
    }
    
    // Proxy to L1
    if(p==="/" || p==="/index.html") {
      const l1 = await fetch("https://genspark.ofshore.dev/",{signal:AbortSignal.timeout(10000)}).then(r=>r.text()).catch(()=>"");
      const html = l1
        .replace('<title>Genspark','<title>Genspark MultiClone')
        .replace('by ofshore.dev','by ofshore.dev · L3 MultiClone')
        .replace('</head>',`<style>.l3-badge{position:fixed;top:8px;right:10px;z-index:9999;padding:3px 10px;background:linear-gradient(135deg,#f59e0b,#ef4444);color:white;border-radius:20px;font-size:10px;font-weight:700;font-family:monospace}</style></head>`)
        .replace('<body>','<body><div class="l3-badge">🏭 L3 CloneFactory</div>');
      return new Response(html||"<h1>L3 MultiClone</h1>",{headers:{"Content-Type":"text/html;charset=utf-8","X-Membrane":"L3","X-Atomic-NS":atomic}});
    }
    
    return J({error:"not found",layer:"L3"},404);
  }
};
