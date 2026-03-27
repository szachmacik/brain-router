const SB = "https://blgdhfcosqjzrutncbbr.supabase.co";
const SB_MGMT = "https://api.supabase.com/v1";
const PROJECT_REF = "blgdhfcosqjzrutncbbr";
const COOLIFY = "https://coolify.ofshore.dev";
const TG = "8394457153:AAFZQ4eMHaiAnmwejmTfWZHI_5KSqhXgCXg";
const CHAT = "8149345223";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if (p === "/health") return Response.json({ ok:true, worker:"bootstrap-deployer", v:4, has_coolify:!!env.COOLIFY_TOKEN, has_sb:!!env.SUPABASE_SERVICE_KEY });
    if (p === "/apps")   return getApps(env);
    if (p === "/vault" && request.method === "POST") return vaultGet(request, env);
    if (p === "/deploy" && request.method === "POST") return deployApp(request, env);
    if (p === "/sql"    && request.method === "POST") return runSQL(request, env);
    if (p === "/run"    && request.method === "POST") return runBootstrap(env);
    return Response.json({ endpoints:["/health","/apps","/vault","/deploy","/sql","/run"] });
  }
};

async function getSecret(name, env) {
  if (!name) return null;
  try {
    const r = await fetch(SB + "/rest/v1/rpc/get_vault_secret", {
      method:"POST",
      headers:{"apikey":env.SUPABASE_SERVICE_KEY,"Authorization":"Bearer "+env.SUPABASE_SERVICE_KEY,"Content-Type":"application/json"},
      body:JSON.stringify({secret_name:name})
    });
    const t = await r.text();
    return t && t !== "null" ? t.replace(/^"|"$/g,"") : null;
  } catch { return null; }
}

async function vaultGet(request, env) {
  const { key } = await request.json().catch(() => ({}));
  const val = await getSecret(key, env);
  return Response.json({ key, found:!!val, preview: val ? val.slice(0,12)+"..." : null });
}

async function runSQL(request, env) {
  const { sql } = await request.json().catch(() => ({}));
  if (!sql) return Response.json({ error:"sql required" }, { status:400 });

  const pat = await getSecret("supabase_pat", env);

  if (pat) {
    try {
      const r = await fetch(SB_MGMT + "/projects/" + PROJECT_REF + "/database/query", {
        method:"POST",
        headers:{"Authorization":"Bearer "+pat,"Content-Type":"application/json"},
        body:JSON.stringify({query:sql}),
        signal:AbortSignal.timeout(25000)
      });
      const d = await r.json();
      if (r.ok) return Response.json({ ok:true, method:"mgmt_api_pat", result:d });
      return Response.json({ ok:false, method:"mgmt_api_pat", status:r.status, error:d.message, pat_found:true });
    } catch(e) {}
  }

  const r2 = await fetch(SB + "/rest/v1/rpc/exec_sql", {
    method:"POST",
    headers:{"apikey":env.SUPABASE_SERVICE_KEY,"Authorization":"Bearer "+env.SUPABASE_SERVICE_KEY,"Content-Type":"application/json"},
    body:JSON.stringify({sql}),
    signal:AbortSignal.timeout(20000)
  });
  const d2 = await r2.json();
  return Response.json({ ok:r2.ok, method:"exec_sql_rpc", status:r2.status, result:d2, pat_found:!!pat });
}

async function getApps(env) {
  const r = await fetch(COOLIFY+"/api/v1/applications",{headers:{Authorization:"Bearer "+env.COOLIFY_TOKEN}});
  const apps = await r.json();
  const names = ["clone-engine","genspark-clone","onepass"];
  const filtered = Array.isArray(apps) ? apps.filter(a=>names.includes(a.name)).map(a=>({uuid:a.uuid,name:a.name,status:a.status,fqdn:a.fqdn})) : apps;
  return Response.json({ok:r.ok,apps:filtered});
}

async function deployApp(request, env) {
  const { uuid, name } = await request.json().catch(() => ({}));
  let id = uuid;
  if (!id && name) {
    const r = await fetch(COOLIFY+"/api/v1/applications",{headers:{Authorization:"Bearer "+env.COOLIFY_TOKEN}});
    const apps = await r.json();
    id = Array.isArray(apps) ? apps.find(a=>a.name===name)?.uuid : null;
  }
  if (!id) return Response.json({error:"not found"},{status:404});
  const r = await fetch(COOLIFY+"/api/v1/deploy?uuid="+id+"&force=true",{headers:{Authorization:"Bearer "+env.COOLIFY_TOKEN}});
  return Response.json({ok:r.ok,uuid:id,result:await r.json()});
}

async function runBootstrap(env) {
  const [anthropicKey,togetherKey,falKey,tavilyKey] = await Promise.all([
    getSecret("anthropic_api_key",env),getSecret("together_api_key",env),
    getSecret("fal_api_key",env),getSecret("tavily_api_key",env)
  ]);
  const appsR = await fetch(COOLIFY+"/api/v1/applications",{headers:{Authorization:"Bearer "+env.COOLIFY_TOKEN}}).then(r=>r.json()).catch(()=>[]);
  const appMap = {};
  if (Array.isArray(appsR)) appsR.forEach(a=>{appMap[a.name]=a.uuid;});

  const configs = [
    {name:"genspark-clone",envs:{ANTHROPIC_API_KEY:anthropicKey,TOGETHER_API_KEY:togetherKey,FAL_API_KEY:falKey,TAVILY_API_KEY:tavilyKey,BROWSERLESS_URL:"http://178.62.246.169:3000"}},
    {name:"clone-engine",envs:{BRAIN_ROUTER_URL:"https://brain-router.ofshore.dev",ROUTER_KEY:"holon-brain-router-2026",SUPABASE_URL:SB,SUPABASE_SERVICE_KEY:env.SUPABASE_SERVICE_KEY||"",TOGETHER_API_KEY:togetherKey||"",TAVILY_API_KEY:tavilyKey||"",BROWSERLESS_URL:"http://178.62.246.169:3000"}},
    {name:"onepass",envs:{SUPABASE_URL:SB,SUPABASE_SERVICE_KEY:env.SUPABASE_SERVICE_KEY||"",OWNER_EMAIL:"maciej@ofshore.dev"}}
  ];

  const results = [];
  for (const cfg of configs) {
    const uuid = appMap[cfg.name];
    if (!uuid) { results.push({name:cfg.name,error:"uuid not found"}); continue; }
    let n = 0;
    for (const [k,v] of Object.entries(cfg.envs)) {
      if (!v) continue;
      const r = await fetch(COOLIFY+"/api/v1/applications/"+uuid+"/envs",{
        method:"POST",headers:{Authorization:"Bearer "+env.COOLIFY_TOKEN,"Content-Type":"application/json"},
        body:JSON.stringify({key:k,value:v,is_preview:false,is_build_time:false})
      });
      if (r.ok) n++;
    }
    await fetch(COOLIFY+"/api/v1/deploy?uuid="+uuid+"&force=false",{headers:{Authorization:"Bearer "+env.COOLIFY_TOKEN}});
    results.push({name:cfg.name,uuid,envs_set:n,deployed:true});
  }

  const msg = "Bootstrap v4 done: "+results.map(r=>r.name+" "+r.envs_set+" envs").join(", ");
  await fetch("https://api.telegram.org/bot"+TG+"/sendMessage",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:CHAT,text:msg})
  }).catch(()=>{});

  return Response.json({ok:true,results,vault:{anthropic:!!anthropicKey,together:!!togetherKey,fal:!!falKey,tavily:!!tavilyKey}});
}
