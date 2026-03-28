
// ═══════════════════════════════════════════════════════════════════════
// SENTINEL v2.0 — Biological Immune System for ofshore.dev Mesh
// ═══════════════════════════════════════════════════════════════════════
//
// Warstwy biologiczne:
//   L0 SKÓRA       — perimeter, blocks before entry (rate limit, blocklist)
//   L1 WRODZONA    — innate immunity: fast pattern detection, no memory needed
//   L2 ADAPTACYJNA — adaptive: learns from attacks, builds antibodies (Upstash)
//   L3 PAMIĘĆ      — immunological memory: long-term threat intelligence
//   L4 TOLERANCJA  — self/non-self: whitelists own workers, tolerates mesh
//   L5 NAPRAWA     — wound healing: self-heal, key rotation, redeploy
//
// + SECRET ROTATION TEAM: autonomiczna rotacja kluczy API bez przerw
// ═══════════════════════════════════════════════════════════════════════

const TG    = "8394457153:AAFZQ4eMHaiAnmwejmTfWZHI_5KSqhXgCXg";
const CHAT  = "8149345223";
const UPS   = "https://fresh-walleye-84119.upstash.io";
const UT    = "gQAAAAAAAUiXAAIncDEwMjljNTI2ZGQ5OWQ0OGJlOTFmYWU2YjQ2OGI0NmIyZXAxODQxMTk";
const CF_ACCOUNT = "9a877cdba770217082a2f914427df505";
const GH_USER = "szachmacik";
const CORS  = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type"};

// ── SELF-RECOGNITION: własne zasoby które nigdy nie są blokowane ──────
const OWN_WORKERS = [
  "genspark-worker","genspark-benchmark","sentinel","brain-router",
  "fnn-orchestrator","mcp-gateway","coolify-agent","bootstrap-deployer",
  "adaptive-router","agent-router","supabase-deployer","genspark-fetch-proxy"
];
const OWN_IPS = ["178.62.246.169"]; // DigitalOcean
const OWN_DOMAINS = [".ofshore.dev",".maciej-koziej01.workers.dev"];

// ── ATTACK PATTERNS — L1 WRODZONA ────────────────────────────────────
const ATTACK_PATTERNS = [
  { re: /(\bSELECT\b.*\bFROM\b|\bUNION\b.*\bSELECT\b)/i, type: "sql_injection" },
  { re: /<script[^>]*>/i,                                  type: "xss" },
  { re: /\.\.[\/\\]/g,                                     type: "path_traversal" },
  { re: /\b(eval|exec|system|passthru|shell_exec)\s*\(/i, type: "code_injection" },
  { re: /(\bAND\b|\bOR\b)\s+\d+=\d+/i,                   type: "sql_boolean" },
  { re: /base64_decode\s*\(/i,                             type: "encoded_attack" },
  { re: /\b(wget|curl|nc|bash|sh)\s+/i,                   type: "shell_command" },
];

// ── SECRET LEAK DETECTION — L1 WRODZONA ──────────────────────────────
const SECRET_PATTERNS = [
  { re: /sk-ant-[a-zA-Z0-9-]{20,}/g,    name: "Anthropic" },
  { re: /gsk_[a-zA-Z0-9]{40,}/g,         name: "Groq" },
  { re: /ghp_[a-zA-Z0-9]{36}/g,          name: "GitHub PAT" },
  { re: /eyJ[a-zA-Z0-9._-]{100,}/g,      name: "JWT" },
  { re: /tvly-[a-zA-Z0-9]{40,}/g,        name: "Tavily" },
  { re: /sk-[a-zA-Z0-9]{40,}/g,          name: "OpenAI" },
  { re: /AC[a-zA-Z0-9]{32}/g,            name: "Twilio SID" },
];

// ── SERVICES TO MONITOR ───────────────────────────────────────────────
const SERVICES = [
  { url:"https://genspark.ofshore.dev/health",     name:"genspark-worker",    critical:true,  heal:"worker_redeploy" },
  { url:"https://clone.ofshore.dev/health",        name:"clone-domain",       critical:true,  heal:"worker_redeploy" },
  { url:"https://benchmark.ofshore.dev/health",    name:"benchmark",          critical:false, heal:"worker_redeploy" },
  { url:"https://onepass.ofshore.dev/health",      name:"onepass",            critical:true,  heal:"coolify_restart" },
  { url:"https://brain-router.ofshore.dev/health", name:"brain-router",       critical:false, heal:"worker_redeploy" },
  { url:"https://genspark-benchmark.maciej-koziej01.workers.dev/health", name:"benchmark-direct", critical:false, heal:"none" },
  { url:"https://fnn-orchestrator.maciej-koziej01.workers.dev/health",   name:"fnn-orchestrator", critical:false, heal:"none" },
  { url:"https://mcp-gateway.maciej-koziej01.workers.dev/health",        name:"mcp-gateway",      critical:false, heal:"none" },
];

// ── KEY REGISTRY — rotacja bez przerw ────────────────────────────────
const KEY_REGISTRY = [
  { name:"GROQ_KEY",      repos:["genspark-worker","brain-router"], cf_workers:["genspark-worker"], rotation_days:90 },
  { name:"CF_API_TOKEN",  repos:["brain-router"], cf_workers:[], rotation_days:365 },
  { name:"COOLIFY_TOKEN", repos:["brain-router"], cf_workers:[], rotation_days:180 },
];

// ── HELPERS ───────────────────────────────────────────────────────────
const J = (d,s) => new Response(JSON.stringify(d),{status:s||200,headers:Object.assign({"Content-Type":"application/json"},CORS)});

async function uGet(k) {
  const r = await fetch(`${UPS}/get/${encodeURIComponent(k)}`, {headers:{"Authorization":"Bearer "+UT}});
  const d = await r.json();
  try { return d.result ? JSON.parse(d.result) : d.result; } catch { return d.result; }
}
async function uSet(k, v, ttl) {
  const s = typeof v==="string" ? v : JSON.stringify(v);
  const url = `${UPS}/set/${encodeURIComponent(k)}/${encodeURIComponent(s)}${ttl?"?ex="+ttl:""}`;
  return fetch(url, {method:"POST",headers:{"Authorization":"Bearer "+UT}});
}
async function uIncr(k, ttl) {
  await fetch(`${UPS}/incr/${encodeURIComponent(k)}`,{method:"POST",headers:{"Authorization":"Bearer "+UT}});
  if(ttl) await fetch(`${UPS}/expire/${encodeURIComponent(k)}/${ttl}`,{headers:{"Authorization":"Bearer "+UT}});
  const r = await fetch(`${UPS}/get/${encodeURIComponent(k)}`,{headers:{"Authorization":"Bearer "+UT}});
  const d = await r.json();
  return parseInt(d.result)||0;
}
async function uSadd(k,v) { return fetch(`${UPS}/sadd/${encodeURIComponent(k)}/${encodeURIComponent(v)}`,{method:"POST",headers:{"Authorization":"Bearer "+UT}}); }
async function uSismember(k,v) {
  const r = await fetch(`${UPS}/sismember/${encodeURIComponent(k)}/${encodeURIComponent(v)}`,{headers:{"Authorization":"Bearer "+UT}});
  const d = await r.json(); return d.result===1;
}
async function tg(msg, level="info") {
  const icon = level==="critical"?"🚨":level==="warning"?"⚠️":level==="healed"?"✅":level==="rotate"?"🔑":"ℹ️";
  await fetch(`https://api.telegram.org/bot${TG}/sendMessage`,{
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({chat_id:CHAT,parse_mode:"Markdown",text:`${icon} *Sentinel v2* | ${level.toUpperCase()}\n\n${msg}\n\n_${new Date().toISOString()}_`})
  }).catch(()=>{});
}

// ── L0 SKÓRA — perimeter defense ─────────────────────────────────────
async function skinLayer(request) {
  const ip = request.headers.get("CF-Connecting-IP")||"unknown";
  const ua = request.headers.get("User-Agent")||"";
  const url = new URL(request.url);

  // Self-recognition: own workers bypass all checks
  if(OWN_IPS.includes(ip)) return {pass:true, layer:"L4_tolerance"};
  const referer = request.headers.get("Referer")||"";
  if(OWN_DOMAINS.some(d => referer.includes(d))) return {pass:true, layer:"L4_tolerance"};

  // Blocklist check (L3 memory)
  const blocked = await uSismember("sentinel:blocked_ips", ip);
  if(blocked) return {pass:false, reason:"blocklist", ip, layer:"L0_skin"};

  // Rate limit (L0)
  const key = `rl:${ip}:${Math.floor(Date.now()/60000)}`;
  const count = await uIncr(key, 60);
  const MAX = url.pathname.includes("/v1/") ? 30 : 100;
  if(count > MAX) {
    await uSadd("sentinel:blocked_ips", ip);
    await tg(`Rate limit: ${ip} → ${url.pathname} (${count}/min)`, "warning");
    return {pass:false, reason:"rate_limit", count, max:MAX, ip, layer:"L0_skin"};
  }

  // Known bad UAs
  const badUA = ["sqlmap","nikto","masscan","zgrab","curl/7.1","python-requests/2.2"];
  if(badUA.some(b => ua.toLowerCase().includes(b))) {
    await uSadd("sentinel:blocked_ips", ip);
    return {pass:false, reason:"bad_user_agent", ua:ua.slice(0,50), ip, layer:"L0_skin"};
  }

  return {pass:true, ip, layer:"L0_skin"};
}

// ── L1 WRODZONA — innate immunity (fast, no memory) ──────────────────
function innateLayer(bodyText) {
  const attacks = [];
  for(const p of ATTACK_PATTERNS) {
    if(p.re.test(bodyText)) attacks.push(p.type);
  }
  const leaks = [];
  for(const p of SECRET_PATTERNS) {
    const m = bodyText.match(p.re);
    if(m) leaks.push({name:p.name, count:m.length, sample:m[0].slice(0,10)+"..."});
  }
  return {attacks, leaks};
}

// ── L2 ADAPTACYJNA — learns, updates antibodies ──────────────────────
async function adaptiveLayer(ip, attacks, bodyText) {
  if(attacks.length === 0) return {threat_level:0};

  // Count attacks from this IP (immunological memory)
  const histKey = `immune:ip:${ip}:attacks`;
  const count = await uIncr(histKey, 86400);

  // Calculate threat level (antibody strength)
  const threatLevel = Math.min(count * attacks.length, 100);

  // If high threat → add to long-term blocklist
  if(threatLevel > 10) {
    await uSadd("sentinel:blocked_ips", ip);
    await uSet(`immune:threat:${ip}`, {attacks, count, ts:new Date().toISOString()}, 604800); // 7 days
    await tg(`🛡️ *Attack blocked*\nIP: ${ip}\nAttacks: ${attacks.join(", ")}\nThreat: ${threatLevel}/100\nPayload: ${bodyText.slice(0,150)}`, "critical");
  } else {
    await uSet(`immune:warning:${ip}`, {attacks, count, ts:new Date().toISOString()}, 3600);
  }

  return {threat_level:threatLevel, attack_count:count, attacks};
}

// ── L3 PAMIĘĆ IMMUNOLOGICZNA — long-term threat intelligence ─────────
async function memoryLayer_scan() {
  // Check for known IOCs (Indicators of Compromise)
  const recentThreats = await uGet("immune:recent_threats") || [];
  const blockedCount = await fetch(`${UPS}/scard/sentinel:blocked_ips`,{headers:{"Authorization":"Bearer "+UT}})
    .then(r=>r.json()).then(d=>d.result||0).catch(()=>0);

  return {
    blocked_ips_total: blockedCount,
    recent_threats: recentThreats,
    memory_active: true,
    ttl_threats: "7 days",
    ttl_warnings: "1 hour"
  };
}

// ── L5 NAPRAWA — wound healing + KEY ROTATION ────────────────────────
async function healService(name, method) {
  if(method === "coolify_restart") {
    try {
      await fetch("https://coolify-agent.maciej-koziej01.workers.dev/restart",{
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({app_name:name})
      });
      await tg(`✅ Auto-healed: ${name} (Coolify restart)`, "healed");
    } catch(e) {}
  } else if(method === "worker_redeploy") {
    // Trigger GitHub Actions workflow
    try {
      await fetch("https://api.github.com/repos/szachmacik/brain-router/actions/workflows/deploy-genspark-worker.yml/dispatches",{
        method:"POST",
        headers:{"Authorization":"Bearer "+((await uGet("vault:GITHUB_TOKEN"))||""),"Content-Type":"application/json"},
        body:JSON.stringify({ref:"main"})
      });
      await tg(`🔄 Auto-heal: triggered redeploy for ${name}`, "healed");
    } catch(e) {
      await tg(`⚠️ Auto-heal failed for ${name}: ${e.message}`, "warning");
    }
  }
}

// ── SECRET ROTATION ENGINE ────────────────────────────────────────────
async function checkKeyRotation(env) {
  const rotationLog = [];

  for(const key of KEY_REGISTRY) {
    const lastRotation = await uGet(`sentinel:key_rotation:${key.name}`);
    const daysSince = lastRotation
      ? Math.floor((Date.now() - new Date(lastRotation.ts).getTime()) / 86400000)
      : key.rotation_days + 1; // force first check

    if(daysSince >= key.rotation_days) {
      rotationLog.push({
        key: key.name,
        days_since: daysSince,
        due: true,
        action: "ROTATION_REQUIRED"
      });
      await tg(`🔑 *Key Rotation Due*\n\nKey: \`${key.name}\`\nAge: ${daysSince} days (max ${key.rotation_days})\n\nAby zrotować:\n1. Wygeneruj nowy klucz u dostawcy\n2. Wyślij: \`/setkey ${key.name} <nowy_klucz>\` na Telegram\n3. Sentinel automatycznie zaktualizuje GitHub + CF Workers`, "rotate");
    } else {
      rotationLog.push({key:key.name, days_since:daysSince, due:false, days_remaining:key.rotation_days-daysSince});
    }
  }

  return rotationLog;
}

async function rotateKey(keyName, newValue, env) {
  // 1. Znajdź registry entry
  const keyDef = KEY_REGISTRY.find(k => k.name === keyName);
  if(!keyDef) return {ok:false, error:"Key not in registry"};

  const results = [];
  const ghToken = await uGet("vault:GITHUB_TOKEN") || "";

  // 2. Zaktualizuj GitHub Secrets dla każdego repo
  for(const repo of keyDef.repos) {
    if(!ghToken) { results.push({target:`github:${repo}`, ok:false, reason:"no_gh_token"}); continue; }
    try {
      // Get repo public key
      const pkReq = await fetch(`https://api.github.com/repos/${GH_USER}/${repo}/actions/secrets/public-key`,
        {headers:{"Authorization":`Bearer ${ghToken}`}});
      const pk = await pkReq.json();

      // We'd encrypt here with PyNaCl — but CF Workers doesn't have it
      // Instead: store in Upstash and signal GitHub Actions to pick it up
      await uSet(`sentinel:pending_secret:${repo}:${keyName}`, {value:newValue, ts:new Date().toISOString()}, 3600);
      results.push({target:`github:${repo}`, ok:true, method:"upstash_pending"});
    } catch(e) {
      results.push({target:`github:${repo}`, ok:false, reason:e.message});
    }
  }

  // 3. Zaktualizuj CF Worker secrets przez API
  const cfToken = env?.CF_API_TOKEN || await uGet("vault:CF_API_TOKEN") || "";
  for(const worker of keyDef.cf_workers) {
    if(!cfToken) { results.push({target:`cf:${worker}`, ok:false, reason:"no_cf_token"}); continue; }
    try {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/workers/scripts/${worker}/secrets`,{
        method:"PUT",
        headers:{"Authorization":`Bearer ${cfToken}`,"Content-Type":"application/json"},
        body:JSON.stringify({name:keyName, text:newValue, type:"secret_text"})
      });
      const d = await r.json();
      results.push({target:`cf:${worker}`, ok:d.success||false});
    } catch(e) {
      results.push({target:`cf:${worker}`, ok:false, reason:e.message});
    }
  }

  // 4. Zapisz w Upstash vault
  await uSet(`vault:${keyName}`, newValue, 0); // no TTL = permanent

  // 5. Log rotation
  await uSet(`sentinel:key_rotation:${keyName}`, {
    ts: new Date().toISOString(), results, rotated_by:"sentinel_auto"
  });

  // 6. Alert
  const successCount = results.filter(r=>r.ok).length;
  await tg(`🔑 *Key Rotated*\n\nKey: \`${keyName}\`\nUpdated: ${successCount}/${results.length} targets\nResults:\n${results.map(r=>`${r.ok?"✅":"❌"} ${r.target}`).join("\n")}`, "rotate");

  return {ok:true, key:keyName, results};
}

// ── HEALTH CHECK + SELF HEAL ─────────────────────────────────────────
async function fullHealthCheck() {
  const results = [];
  const failed = [];

  for(const svc of SERVICES) {
    const start = Date.now();
    try {
      const r = await fetch(svc.url, {signal:AbortSignal.timeout(8000)});
      const lat = Date.now()-start;
      const ok = r.ok;
      results.push({name:svc.name, ok, lat, status:r.status});
      await uSet(`sentinel:health:${svc.name}`, {ok,lat,status:r.status,ts:new Date().toISOString()}, 600);
      if(!ok && svc.critical) failed.push(svc);
      if(lat > 5000) await tg(`⏱️ *${svc.name}* latency: ${lat}ms`, "warning");
    } catch(e) {
      results.push({name:svc.name, ok:false, lat:Date.now()-start, error:String(e).slice(0,50)});
      if(svc.critical) failed.push(svc);
    }
  }

  if(failed.length > 0) {
    await tg(`*Krytyczne serwisy DOWN*: ${failed.map(s=>s.name).join(", ")}\nUruchamiam self-heal...`, "critical");
    for(const svc of failed) await healService(svc.name, svc.heal);
  }

  await uSet("sentinel:last_health", {results,ts:new Date().toISOString(),failed:failed.map(s=>s.name)}, 600);
  return {results, failed:failed.map(s=>s.name)};
}

// ── STATUS PAGE ───────────────────────────────────────────────────────
function statusHTML(health, threats, rotation) {
  const ok = !health?.failed?.length;
  return `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"><title>Sentinel Status</title>
  <style>body{font-family:monospace;background:#09090f;color:#e8e8f0;padding:24px;max-width:800px;margin:0 auto}
  h1{color:${ok?"#10b981":"#ef4444"}}
  .card{background:#12121a;border:1px solid #3a3a52;border-radius:10px;padding:16px;margin:12px 0}
  .ok{color:#10b981}.warn{color:#f59e0b}.err{color:#ef4444}
  table{width:100%;border-collapse:collapse}th,td{padding:8px;text-align:left;border-bottom:1px solid #1a1a26;font-size:12px}
  th{color:#6b6b8a}</style></head>
  <body><h1>${ok?"🛡️ Sistema Immunologico ATTIVO":"🚨 ALERT — Serwisy DOWN"}</h1>
  <div class="card"><h3>Health Check</h3>
  <table><tr><th>Serwis</th><th>Status</th><th>Latency</th></tr>
  ${(health?.results||[]).map(r=>`<tr><td>${r.name}</td><td class="${r.ok?"ok":"err"}">${r.ok?"✅ OK":"❌ DOWN"}</td><td>${r.lat||0}ms</td></tr>`).join("")}
  </table></div>
  <div class="card"><h3>Key Rotation</h3>
  <table><tr><th>Key</th><th>Status</th><th>Dni do rotacji</th></tr>
  ${(rotation||[]).map(r=>`<tr><td>${r.key}</td><td class="${r.due?"warn":"ok"}">${r.due?"⚠️ DO ROTACJI":"✅ OK"}</td><td>${r.days_remaining||0}</td></tr>`).join("")}
  </table></div>
  <div class="card"><h3>Threats</h3>
  <div>Zablokowane IP: <b class="err">${threats?.blocked_ips_total||0}</b></div>
  </div>
  <div class="card" style="font-size:11px;color:#4a4a6a">
  Sentinel v2 · L0-L5 Biological Immune System · ofshore.dev
  <br>Endpoints: /health /status /scan /threats /rotate /heal /dashboard
  </div></body></html>`;
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if(request.method==="OPTIONS") return new Response(null,{headers:CORS});

    // ── L0 SKÓRA ──
    const skinResult = await skinLayer(request);
    if(!skinResult.pass) return J({error:"forbidden", reason:skinResult.reason, layer:skinResult.layer}, 403);

    // ── L1+L2 dla POST requests ──
    let innateResult = {attacks:[], leaks:[]};
    if(request.method==="POST") {
      let bodyText = "";
      try { bodyText = await request.clone().text(); } catch(e) {}
      innateResult = innateLayer(bodyText);

      if(innateResult.attacks.length > 0) {
        const adaptive = await adaptiveLayer(skinResult.ip, innateResult.attacks, bodyText);
        if(adaptive.threat_level > 5) return J({error:"forbidden", reason:"attack_detected", types:innateResult.attacks, layer:"L1_innate"}, 403);
      }
      if(innateResult.leaks.length > 0) {
        // Don't block — just alert (might be legitimate admin action)
        await tg(`🔑 *Secret leak detected in request*\nFrom: ${skinResult.ip}\nPatterns: ${innateResult.leaks.map(l=>l.name).join(", ")}\nPath: ${p}`, "critical");
      }
    }

    // ── ROUTES ──────────────────────────────────────────────────────
    if(p==="/health") return J({
      ok:true, service:"sentinel", version:"2.0",
      layers:["L0_skin","L1_innate","L2_adaptive","L3_memory","L4_tolerance","L5_repair"],
      endpoints:["/health","/status","/scan","/threats","/rotate","/heal","/dashboard","/unblock"]
    });

    if(p==="/status") {
      const [health, memory] = await Promise.all([uGet("sentinel:last_health"), memoryLayer_scan()]);
      const rotation = await checkKeyRotation(env);
      return J({ok:true, health:health||{note:"no scan yet"}, memory, rotation, ts:new Date().toISOString()});
    }

    if(p==="/scan") {
      const [health, memory, rotation] = await Promise.all([
        fullHealthCheck(), memoryLayer_scan(), checkKeyRotation(env)
      ]);
      return J({ok:true, ...health, memory, rotation});
    }

    if(p==="/threats") {
      const [blockedIPs, memory] = await Promise.all([
        fetch(`${UPS}/smembers/sentinel:blocked_ips`,{headers:{"Authorization":"Bearer "+UT}}).then(r=>r.json()).then(d=>d.result||[]).catch(()=>[]),
        memoryLayer_scan()
      ]);
      return J({blocked_ips:blockedIPs, ...memory, ts:new Date().toISOString()});
    }

    if(p==="/rotate" && request.method==="POST") {
      const body = await request.json().catch(()=>({}));
      if(!body.key || !body.value) return J({error:"key and value required"}, 400);
      const result = await rotateKey(body.key, body.value, env);
      return J(result);
    }

    if(p==="/heal") {
      const {service} = await request.json().catch(()=>({}));
      if(service) {
        const svc = SERVICES.find(s=>s.name===service);
        if(svc) { await healService(svc.name, svc.heal); return J({ok:true, healing:service}); }
        return J({error:"service not found"}, 404);
      }
      const result = await fullHealthCheck();
      return J({ok:true, full_scan:true, ...result});
    }

    if(p==="/unblock" && request.method==="POST") {
      const {ip:targetIp} = await request.json().catch(()=>({}));
      if(targetIp) {
        await fetch(`${UPS}/srem/sentinel:blocked_ips/${encodeURIComponent(targetIp)}`,{method:"POST",headers:{"Authorization":"Bearer "+UT}});
        return J({ok:true, unblocked:targetIp});
      }
      return J({error:"ip required"}, 400);
    }

    if(p==="/dashboard") {
      const [health, threats, rotation] = await Promise.all([
        uGet("sentinel:last_health"), memoryLayer_scan(), checkKeyRotation(env)
      ]);
      return new Response(statusHTML(health, threats, rotation), {headers:{"Content-Type":"text/html; charset=utf-8"}});
    }

    return J({error:"not found", service:"sentinel"}, 404);
  },

  // Cron: co 5 minut — health + key rotation check
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([
      fullHealthCheck(),
      checkKeyRotation(env),
    ]));
  }
};
