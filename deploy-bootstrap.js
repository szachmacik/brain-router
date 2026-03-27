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
    if (p === "/health")         return Response.json({ ok: true, worker: "bootstrap-deployer", v: 3, has_coolify: !!env.COOLIFY_TOKEN, has_sb: !!env.SUPABASE_SERVICE_KEY });
    if (p === "/apps")           return getApps(env);
    if (p === "/deploy" && request.method === "POST") return deployApp(request, env);
    if (p === "/sql" && request.method === "POST")    return runSQL(request, env);
    if (p === "/vault" && request.method === "POST")  return vaultGet(request, env);
    if (p === "/run" && request.method === "POST")    return runBootstrap(env);
    return Response.json({ endpoints: ["/health","/apps","/deploy","/sql","/vault","/run"] });
  }
};

async function vaultGet(request, env) {
  const { key } = await request.json().catch(() => ({}));
  const val = await getSecret(key, env);
  return Response.json({ key, found: !!val, preview: val ? val.slice(0,8)+"..." : null });
}

async function getSecret(name, env) {
  if (!name) return null;
  try {
    const r = await fetch(SB + "/rest/v1/rpc/get_vault_secret", {
      method: "POST",
      headers: { "apikey": env.SUPABASE_SERVICE_KEY, "Authorization": "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ secret_name: name })
    });
    const t = await r.text();
    return t && t !== "null" ? t.replace(/^"|"$/g, "") : null;
  } catch { return null; }
}

// SQL via Supabase Management API (używa PAT - omija RPC)
async function runSQL(request, env) {
  const { sql } = await request.json().catch(() => ({}));
  if (!sql) return Response.json({ error: "sql required" }, { status: 400 });

  // Metoda 1: Management API z PAT
  const pat = await getSecret("supabase_pat", env);
  if (pat) {
    try {
      const r = await fetch(`${SB_MGMT}/projects/${PROJECT_REF}/database/query`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${pat}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql })
      });
      const d = await r.json();
      if (r.ok) return Response.json({ ok: true, method: "mgmt_api", result: d });
      console.log("mgmt_api failed:", d.message);
    } catch(e) { console.log("mgmt_api error:", e.message); }
  }

  // Metoda 2: Direct REST z service key (dla prostych operacji)
  try {
    const r = await fetch(SB + "/rest/v1/rpc/exec_sql", {
      method: "POST",
      headers: { "apikey": env.SUPABASE_SERVICE_KEY, "Authorization": "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ sql })
    });
    const d = await r.json();
    if (r.ok) return Response.json({ ok: true, method: "exec_sql_rpc", result: d });
  } catch(e) {}

  // Metoda 3: Lista dostępnych RPC
  try {
    const r = await fetch(SB + "/rest/v1/rpc/get_available_functions", {
      method: "POST",
      headers: { "apikey": env.SUPABASE_SERVICE_KEY, "Authorization": "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json" },
      body: "{}"
    });
    const t = await r.text();
    return Response.json({ ok: false, methods_tried: ["mgmt_api","exec_sql_rpc"], pat_found: !!pat, status: r.status, available_hint: t.slice(0,200) });
  } catch(e) {
    return Response.json({ ok: false, methods_tried: ["mgmt_api","exec_sql_rpc"], pat_found: !!pat, error: e.message });
  }
}

async function getApps(env) {
  const r = await fetch(COOLIFY + "/api/v1/applications", { headers: { Authorization: "Bearer " + env.COOLIFY_TOKEN } });
  const apps = await r.json();
  const filtered = Array.isArray(apps) ? apps.filter(a => 
    ["clone-engine","genspark-clone","onepass"].includes(a.name)
  ).map(a => ({ uuid: a.uuid, name: a.name, status: a.status, fqdn: a.fqdn })) : apps;
  return Response.json({ ok: r.ok, apps: filtered });
}

async function deployApp(request, env) {
  const { uuid, name } = await request.json().catch(() => ({}));
  let targetUuid = uuid;
  if (!targetUuid && name) {
    const r = await fetch(COOLIFY + "/api/v1/applications", { headers: { Authorization: "Bearer " + env.COOLIFY_TOKEN } });
    const apps = await r.json();
    targetUuid = Array.isArray(apps) ? apps.find(a => a.name === name)?.uuid : null;
  }
  if (!targetUuid) return Response.json({ error: "not found" }, { status: 404 });
  const r = await fetch(`${COOLIFY}/api/v1/deploy?uuid=${targetUuid}&force=true`, { headers: { Authorization: "Bearer " + env.COOLIFY_TOKEN } });
  return Response.json({ ok: r.ok, uuid: targetUuid, result: await r.json() });
}

async function runBootstrap(env) {
  const [anthropicKey, togetherKey, falKey, tavilyKey] = await Promise.all([
    getSecret("anthropic_api_key", env), getSecret("together_api_key", env),
    getSecret("fal_api_key", env), getSecret("tavily_api_key", env)
  ]);
  
  const apps = await fetch(COOLIFY + "/api/v1/applications", { headers: { Authorization: "Bearer " + env.COOLIFY_TOKEN } })
    .then(r => r.json()).then(list => {
      const m = {};
      if (Array.isArray(list)) list.forEach(a => { m[a.name] = a.uuid; });
      return m;
    }).catch(() => ({}));

  const envSets = [
    { name: "genspark-clone", uuid: apps["genspark-clone"], envs: { ANTHROPIC_API_KEY: anthropicKey, TOGETHER_API_KEY: togetherKey, FAL_API_KEY: falKey, TAVILY_API_KEY: tavilyKey, BROWSERLESS_URL: "http://178.62.246.169:3000" } },
    { name: "clone-engine", uuid: apps["clone-engine"], envs: { BRAIN_ROUTER_URL: "https://brain-router.ofshore.dev", ROUTER_KEY: "holon-brain-router-2026", SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: env.SUPABASE_SERVICE_KEY, BROWSERLESS_URL: "http://178.62.246.169:3000", TOGETHER_API_KEY: togetherKey, TAVILY_API_KEY: tavilyKey } },
    { name: "onepass", uuid: apps["onepass"], envs: { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: env.SUPABASE_SERVICE_KEY, OWNER_EMAIL: "maciej@ofshore.dev" } }
  ];

  const results = [];
  for (const app of envSets) {
    if (!app.uuid) { results.push({ name: app.name, error: "no uuid" }); continue; }
    let envOk = 0;
    for (const [key, value] of Object.entries(app.envs)) {
      if (!value) continue;
      const r = await fetch(`${COOLIFY}/api/v1/applications/${app.uuid}/envs`, {
        method: "POST",
        headers: { Authorization: "Bearer " + env.COOLIFY_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ key, value, is_preview: false, is_build_time: false })
      });
      if (r.ok) envOk++;
    }
    // Redeploy
    await fetch(`${COOLIFY}/api/v1/deploy?uuid=${app.uuid}&force=false`, { headers: { Authorization: "Bearer " + env.COOLIFY_TOKEN } });
    results.push({ name: app.name, uuid: app.uuid, envs_set: envOk, deployed: true });
  }

  await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, parse_mode: "Markdown",
      text: `✅ *Bootstrap v3*

${results.map(r => `${r.name}: ${r.envs_set||0} envs ✅`).join("
")}

anthropic=${anthropicKey?"✅":"❌"} together=${togetherKey?"✅":"❌"}` })
  }).catch(() => {});

  return Response.json({ ok: true, results, vault: { anthropic: !!anthropicKey, together: !!togetherKey, fal: !!falKey, tavily: !!tavilyKey } });
}
