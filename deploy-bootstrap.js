const SB = "https://blgdhfcosqjzrutncbbr.supabase.co";
const COOLIFY = "https://coolify.ofshore.dev";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, worker: "bootstrap-deployer", has_coolify: !!env.COOLIFY_TOKEN, has_sb: !!env.SUPABASE_SERVICE_KEY });
    if (url.pathname === "/apps") return getApps(env);
    if (url.pathname === "/deploy" && request.method === "POST") return deployApp(request, env);
    if (url.pathname === "/run" && request.method === "POST") return runBootstrap(env);
    if (url.pathname === "/sql" && request.method === "POST") return runSQL(request, env);
    return Response.json({ endpoints: ["/health", "/apps", "/deploy", "/run", "/sql"] });
  }
};

async function getApps(env) {
  const r = await fetch(COOLIFY + "/api/v1/applications", {
    headers: { Authorization: "Bearer " + env.COOLIFY_TOKEN }
  });
  const apps = await r.json();
  const filtered = Array.isArray(apps) ? apps.map(a => ({
    uuid: a.uuid, name: a.name, status: a.status,
    fqdn: a.fqdn, git: a.git_repository_url
  })) : apps;
  return Response.json({ ok: r.ok, count: Array.isArray(apps) ? apps.length : 0, apps: filtered });
}

async function deployApp(request, env) {
  const { uuid, name } = await request.json().catch(() => ({}));
  let targetUuid = uuid;
  
  if (!targetUuid && name) {
    const r = await fetch(COOLIFY + "/api/v1/applications", {
      headers: { Authorization: "Bearer " + env.COOLIFY_TOKEN }
    });
    const apps = await r.json();
    const found = Array.isArray(apps) ? apps.find(a => a.name === name) : null;
    targetUuid = found?.uuid;
  }
  
  if (!targetUuid) return Response.json({ error: "app not found" }, { status: 404 });
  
  const r = await fetch(COOLIFY + "/api/v1/deploy?uuid=" + targetUuid + "&force=true", {
    method: "GET",
    headers: { Authorization: "Bearer " + env.COOLIFY_TOKEN }
  });
  const d = await r.json();
  return Response.json({ ok: r.ok, uuid: targetUuid, result: d });
}

async function runSQL(request, env) {
  const { sql } = await request.json().catch(() => ({}));
  if (!sql) return Response.json({ error: "sql required" }, { status: 400 });
  const r = await fetch(SB + "/rest/v1/rpc/execute_sql_with_result", {
    method: "POST",
    headers: { "apikey": env.SUPABASE_SERVICE_KEY, "Authorization": "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ sql_query: sql })
  });
  const text = await r.text();
  return Response.json({ ok: r.ok, status: r.status, result: text.slice(0, 500) });
}

async function runBootstrap(env) {
  const getSecret = async (name) => {
    const r = await fetch(SB + "/rest/v1/rpc/get_vault_secret", {
      method: "POST",
      headers: { "apikey": env.SUPABASE_SERVICE_KEY, "Authorization": "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ secret_name: name })
    });
    const t = await r.text();
    return t && t !== "null" ? t.replace(/^"|"$/g, "") : null;
  };
  const [anthropicKey, togetherKey, falKey, tavilyKey] = await Promise.all([
    getSecret("anthropic_api_key"), getSecret("together_api_key"),
    getSecret("fal_api_key"), getSecret("tavily_api_key")
  ]);
  
  const servers = await fetch(COOLIFY + "/api/v1/servers", { headers: { Authorization: "Bearer " + env.COOLIFY_TOKEN } }).then(r => r.json()).catch(() => []);
  const projects = await fetch(COOLIFY + "/api/v1/projects", { headers: { Authorization: "Bearer " + env.COOLIFY_TOKEN } }).then(r => r.json()).catch(() => []);
  const serverUuid = Array.isArray(servers) ? servers[0]?.uuid : null;
  const projectUuid = Array.isArray(projects) ? projects[0]?.uuid : null;

  const appsConfig = [
    { name: "clone-engine", git: "https://github.com/szachmacik/clone-engine", domain: "https://clone.ofshore.dev", port: "9000",
      envs: { BRAIN_ROUTER_URL: "https://brain-router.ofshore.dev", ROUTER_KEY: "holon-brain-router-2026", SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: env.SUPABASE_SERVICE_KEY||"", BROWSERLESS_URL: "http://178.62.246.169:3000", TOGETHER_API_KEY: togetherKey||"", TAVILY_API_KEY: tavilyKey||"" }
    },
    { name: "genspark-clone", git: "https://github.com/szachmacik/genspark-clone", domain: "https://genspark.ofshore.dev", port: "8000",
      envs: { ANTHROPIC_API_KEY: anthropicKey||"", TOGETHER_API_KEY: togetherKey||"", FAL_API_KEY: falKey||"", TAVILY_API_KEY: tavilyKey||"", BROWSERLESS_URL: "http://178.62.246.169:3000" }
    },
    { name: "onepass", git: "https://github.com/szachmacik/onepass", domain: "https://onepass.ofshore.dev", port: "7000",
      envs: { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: env.SUPABASE_SERVICE_KEY||"", OWNER_EMAIL: "maciej@ofshore.dev" }
    }
  ];

  // Pobierz istniejące apps
  const existing = await fetch(COOLIFY + "/api/v1/applications", { headers: { Authorization: "Bearer " + env.COOLIFY_TOKEN } }).then(r => r.json()).catch(() => []);
  const existingMap = {};
  if (Array.isArray(existing)) existing.forEach(a => { existingMap[a.name] = a.uuid; });

  const results = [];
  for (const app of appsConfig) {
    let uuid = existingMap[app.name];
    let created = false;

    if (!uuid) {
      const createRes = await fetch(COOLIFY + "/api/v1/applications/public", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.COOLIFY_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ project_uuid: projectUuid, server_uuid: serverUuid, environment_name: "production", git_repository: app.git, git_branch: "main", build_pack: "dockerfile", name: app.name, domains: app.domain, ports_exposes: app.port, instant_deploy: false })
      });
      const d = await createRes.json();
      uuid = d?.uuid;
      created = true;
    }

    if (uuid) {
      for (const [key, value] of Object.entries(app.envs)) {
        if (!value) continue;
        await fetch(COOLIFY + "/api/v1/applications/" + uuid + "/envs", {
          method: "POST",
          headers: { Authorization: "Bearer " + env.COOLIFY_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ key, value, is_preview: false, is_build_time: false })
        }).catch(() => {});
      }
      await fetch(COOLIFY + "/api/v1/deploy?uuid=" + uuid + "&force=false", {
        method: "GET", headers: { Authorization: "Bearer " + env.COOLIFY_TOKEN }
      }).catch(() => {});
    }
    results.push({ name: app.name, uuid, created, existing: !created });
  }
  return Response.json({ ok: true, server: serverUuid, project: projectUuid, apps: results });
}
