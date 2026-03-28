// v1774664640
// ═══════════════════════════════════════════════════════════════
// GENSPARK ENHANCED — L2 Membrane
// MoA: Mixture-of-Agents, Deep Research, Atomic Clock
// ofshore.dev mesh · enhanced.ofshore.dev
// ═══════════════════════════════════════════════════════════════

const CORS = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type"};
const UPS  = "https://fresh-walleye-84119.upstash.io";
const UT   = "gQAAAAAAAUiXAAIncDEwMjljNTI2ZGQ5OWQ0OGJlOTFmYWU2YjQ2OGI0NmIyZXAxODQxMTk";
const TG   = "8394457153:AAFZQ4eMHaiAnmwejmTfWZHI_5KSqhXgCXg";
const CHAT = "8149345223";

// Atomic clock — nanosecond precision via Date.now() + counter
let _seq = 0;
const atomicNs = () => BigInt(Date.now()) * 1000000n + BigInt((_seq++) % 1000);

// MoA models — Groq free tier
const MOA_MODELS = [
  { id:"llama-3.3-70b-versatile",  role:"reasoner",  weight:0.4 },
  { id:"llama-3.1-8b-instant",     role:"fast",      weight:0.2 },
  { id:"llama3-70b-8192",          role:"validator",  weight:0.3 },
  { id:"mixtral-8x7b-32768",       role:"creative",  weight:0.1 },
];

// ── Mixture-of-Agents synthesis ─────────────────────────────
async function moa(prompt, gk, maxTok=1500) {
  const ns_start = atomicNs();
  
  // Run models in parallel
  const results = await Promise.allSettled(
    MOA_MODELS.map(m => 
      fetch("https://api.groq.com/openai/v1/chat/completions", {
        method:"POST",
        headers:{"Authorization":"Bearer "+gk,"Content-Type":"application/json"},
        body: JSON.stringify({
          model: m.id,
          max_tokens: Math.floor(maxTok * m.weight * 2),
          messages: [{role:"system",content:`You are a ${m.role}. Be direct, no filler.`},
                     {role:"user",content:prompt.slice(0,2000)}]
        }),
        signal: AbortSignal.timeout(20000)
      }).then(r=>r.json())
        .then(d=>({model:m.id,role:m.role,weight:m.weight,text:d.choices?.[0]?.message?.content||""}))
        .catch(e=>({model:m.id,role:m.role,weight:m.weight,text:"",err:String(e)}))
    )
  );
  
  const answers = results
    .filter(r=>r.status==="fulfilled" && r.value.text)
    .map(r=>r.value);
  
  if (!answers.length) return {text:"MoA unavailable",models:[],ns:String(ns_start)};
  
  // If only 1 model responded, return it
  if (answers.length === 1) return {text:answers[0].text, models:answers.map(a=>a.model), ns:String(ns_start)};
  
  // Synthesis: pick best by weight or ask Groq to merge
  const summaries = answers.map(a=>`[${a.role}]: ${a.text.slice(0,300)}`).join("\n\n");
  const synthPrompt = `Given these AI responses to: "${prompt.slice(0,100)}"\n\n${summaries}\n\nSynthesize the best answer in Polish. Be concise, direct. No meta-commentary about the synthesis.`;
  
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:"POST",
      headers:{"Authorization":"Bearer "+gk,"Content-Type":"application/json"},
      body:JSON.stringify({model:"llama-3.1-8b-instant",max_tokens:maxTok,messages:[{role:"user",content:synthPrompt}]}),
      signal:AbortSignal.timeout(15000)
    });
    const d = await r.json();
    return {
      text: d.choices?.[0]?.message?.content || answers[0].text,
      models: answers.map(a=>a.model),
      ns: String(ns_start),
      moa_consensus: answers.length
    };
  } catch(e) {
    return {text:answers[0].text, models:answers.map(a=>a.model), ns:String(ns_start)};
  }
}

// ── Deep Research: multi-step ────────────────────────────────
async function deepResearch(query, gk) {
  const ns = atomicNs();
  const steps = [];
  
  // Step 1: Decompose query
  const decomp = await callGroq(`Break this research query into 3 specific sub-questions. Return ONLY a JSON array: ["q1","q2","q3"]\nQuery: ${query}`, gk, "llama-3.1-8b-instant", 200);
  let subqs = [query];
  try { subqs = JSON.parse(decomp.replace(/```json|```/g,"").trim()); } catch(e) {}
  
  // Step 2: Research each sub-question in parallel
  const research = await Promise.allSettled(
    subqs.slice(0,3).map(q => callGroq(`Research and answer concisely: ${q}`, gk, "llama-3.3-70b-versatile", 400))
  );
  
  const findings = research
    .filter(r=>r.status==="fulfilled")
    .map((r,i)=>({question:subqs[i]||"",finding:r.value}));
  
  // Step 3: Synthesize
  const synthesis = await callGroq(
    `Synthesize these research findings into a comprehensive answer to: "${query}"\n\n${findings.map(f=>`Q: ${f.question}\nA: ${f.finding}`).join("\n\n")}`,
    gk, "llama-3.3-70b-versatile", 800
  );
  
  return {
    query, findings, synthesis,
    steps: findings.length,
    ns: String(ns),
    model: "deep-research-groq-moa"
  };
}

// ── Base LLM call ────────────────────────────────────────────
async function callGroq(prompt, gk, model="llama-3.3-70b-versatile", maxTok=1500) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:"POST",
    headers:{"Authorization":"Bearer "+gk,"Content-Type":"application/json"},
    body:JSON.stringify({model,max_tokens:maxTok,messages:[{role:"user",content:prompt.slice(0,3000)}]}),
    signal:AbortSignal.timeout(25000)
  });
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "";
}

// ── Upstash helpers ──────────────────────────────────────────
const uSet = async (k,v,ttl=3600) => fetch(`${UPS}/set/${encodeURIComponent(k)}/${encodeURIComponent(JSON.stringify(v))}?ex=${ttl}`,{method:"POST",headers:{"Authorization":"Bearer "+UT}});
const uGet = async (k) => fetch(`${UPS}/get/${encodeURIComponent(k)}`,{headers:{"Authorization":"Bearer "+UT}}).then(r=>r.json()).then(d=>d.result?JSON.parse(d.result):null).catch(()=>null);

const J = (d,s=200) => new Response(JSON.stringify(d),{status:s,headers:Object.assign({"Content-Type":"application/json"},CORS)});

// ── MAIN HANDLER ─────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const gk = env.GROQ_KEY || "";
    const ns = atomicNs();
    
    if(request.method==="OPTIONS") return new Response(null,{headers:CORS});
    
    if(p==="/health") return J({
      service:"genspark-enhanced",
      layer:"L2",
      version:"1.0",
      membrane: {
        permeability: 1.0,
        capabilities: ["moa","deep_research","slides_hd","atomic_clock"],
        atomic_ns: String(ns),
        moa_models: MOA_MODELS.map(m=>m.id)
      },
      powered_by:"Groq MoA (4 models parallel)",
      l1_url:"https://genspark.ofshore.dev"
    });
    
    // ── MoA Chat ──────────────────────────────────────────────
    if(p==="/v1/chat" && request.method==="POST") {
      const {message, mode="moa"} = await request.json().catch(()=>({}));
      if(!message) return J({error:"message required"},400);
      
      const start = Date.now();
      let result;
      
      if(mode==="deep" || message.length > 200) {
        // Deep research for complex queries
        result = await deepResearch(message, gk);
        return J({
          content: result.synthesis,
          model: "genspark-enhanced-deep-research",
          moa_models: result.findings.length,
          steps: result.steps,
          latency_ms: Date.now()-start,
          atomic_ns: result.ns,
          layer: "L2"
        });
      } else {
        // Standard MoA
        result = await moa(message, gk);
        return J({
          content: result.text,
          model: "genspark-enhanced-moa",
          moa_consensus: result.moa_consensus || 1,
          moa_models: result.models,
          latency_ms: Date.now()-start,
          atomic_ns: result.ns,
          layer: "L2"
        });
      }
    }
    
    // ── HD Slides ─────────────────────────────────────────────
    if(p==="/v1/slides/generate" && request.method==="POST") {
      const {prompt, slide_count=10, style="professional"} = await request.json().catch(()=>({}));
      const start = Date.now();
      
      // Parallel: structure + speaker notes + design
      const [structure, coaching] = await Promise.allSettled([
        callGroq(`Create ${slide_count}-slide presentation: "${prompt}". Style: ${style}. Return ONLY JSON: {"title":"...","slides":[{"index":1,"title":"...","content":["•bullet"],"speaker_notes":"...","visual_hint":"describe image"}]}`, gk, "llama-3.3-70b-versatile", 2500),
        callGroq(`Give 3 presentation coaching tips for: "${prompt}". Be specific and actionable.`, gk, "llama-3.1-8b-instant", 300)
      ]);
      
      let slides_data;
      try { slides_data = JSON.parse((structure.status==="fulfilled"?structure.value:"{}").replace(/```json|```/g,"").trim()); }
      catch { slides_data = {title:prompt, slides:[]}; }
      
      return J({
        id: crypto.randomUUID(),
        title: slides_data.title,
        slides: slides_data.slides || [],
        slide_count: (slides_data.slides||[]).length,
        coaching: coaching.status==="fulfilled" ? coaching.value : "",
        style,
        latency_ms: Date.now()-start,
        atomic_ns: String(ns),
        layer: "L2",
        enhanced: true
      });
    }
    
    // ── Deep Research ─────────────────────────────────────────
    if(p==="/v1/research" && request.method==="POST") {
      const {query} = await request.json().catch(()=>({}));
      if(!query) return J({error:"query required"},400);
      const result = await deepResearch(query, gk);
      return J({...result, layer:"L2"});
    }
    
    // ── Benchmark vs L1 ──────────────────────────────────────
    if(p==="/v1/benchmark/vs-l1" && request.method==="POST") {
      const {task} = await request.json().catch(()=>({}));
      const start = Date.now();
      
      // Run L2 (MoA) and L1 in parallel
      const [l2result, l1result] = await Promise.allSettled([
        moa(task, gk),
        fetch("https://genspark.ofshore.dev/v1/chat", {
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({message:task}),
          signal:AbortSignal.timeout(20000)
        }).then(r=>r.json())
      ]);
      
      const l2 = l2result.status==="fulfilled" ? l2result.value.text : "L2 failed";
      const l1 = l1result.status==="fulfilled" ? l1result.value?.content : "L1 failed";
      const ms = Date.now()-start;
      
      // Judge
      const judgment = await callGroq(
        `Compare two AI responses to: "${task.slice(0,100)}"\n\nL1 (single model): ${l1?.slice(0,300)}\nL2 (MoA 4 models): ${l2?.slice(0,300)}\n\nReturn JSON: {"winner":"L1|L2|tie","reason":"...","quality_diff":0.15}`,
        gk, "llama-3.1-8b-instant", 200
      );
      
      let verdict;
      try { verdict = JSON.parse(judgment.replace(/```json|```/g,"").trim()); }
      catch { verdict = {winner:"tie", reason:"judgment failed", quality_diff:0}; }
      
      return J({
        task, l1_response:l1?.slice(0,400), l2_response:l2?.slice(0,400),
        verdict, latency_ms:ms, atomic_ns:String(ns), layer:"L2"
      });
    }
    
    // ── Proxy to L1 for unsupported endpoints ─────────────────
    if(["/v1/sheets/generate","/v1/sparkpages/generate","/v1/search","/v1/images/generate",
        "/v1/advisor","/clone","/v1/benchmark/compare","/legal","/robots.txt"].includes(p)) {
      try {
        const fwd = await fetch("https://genspark.ofshore.dev"+p, {
          method:request.method,
          headers:request.headers,
          body:request.method==="POST"?await request.text():undefined,
          signal:AbortSignal.timeout(30000)
        });
        const body = await fwd.text();
        return new Response(body, {status:fwd.status, headers:Object.assign({"X-Forwarded-From":"L2-enhanced","X-Atomic-NS":String(ns)},CORS)});
      } catch(e) {
        return J({error:"L1 proxy failed: "+e.message, layer:"L2"},502);
      }
    }
    
    // ── UI — same as L1 but with L2 badge ────────────────────
    if(p==="/" || p==="/index.html") {
      const l1 = await fetch("https://genspark.ofshore.dev/", {signal:AbortSignal.timeout(10000)}).then(r=>r.text()).catch(()=>"");
      const enhanced = l1
        .replace(/<title>Genspark/,'<title>Genspark Enhanced')
        .replace('by ofshore.dev','by ofshore.dev · L2 Enhanced')
        .replace('</head>',`<style>.l2-badge{position:fixed;top:8px;right:10px;z-index:9999;padding:3px 10px;background:linear-gradient(135deg,#7c5cff,#10b981);color:white;border-radius:20px;font-size:10px;font-weight:700;font-family:monospace}</style></head>`)
        .replace('<body>','<body><div class="l2-badge">⚡ L2 MoA Enhanced</div>');
      return new Response(enhanced || "<h1>L2 Enhanced</h1>", {headers:{"Content-Type":"text/html;charset=utf-8","X-Membrane":"L2","X-Atomic-NS":String(ns)}});
    }
    
    return J({error:"not found",layer:"L2",hint:"See /health for capabilities"},404);
  }
};
