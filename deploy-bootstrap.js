// bootstrap-deployer — jednorazowy worker do deployu klonów
// używa CF secrets: COOLIFY_TOKEN, CF_API_TOKEN, CF_ACCOUNT_ID

const TG = "8394457153:AAFZQ4eMHaiAnmwejmTfWZHI_5KSqhXgCXg";
const CHAT = "8149345223";
const COOLIFY = "https://coolify.ofshore.dev";
const SB = "https://blgdhfcosqjzrutncbbr.supabase.co";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, worker: "bootstrap-deployer" });
    if (url.pathname === "/run" && request.method === "POST") return runBootstrap(env);
    if (url.pathname === "/vault" && request.method === "POST") return getVault(request, env);
    return Response.json({ error: "use POST /run" }, { status: 404 });
  }
};

async function getVault(request, env) {
  const { key } = await request.json().catch(() => ({}));
  const r = await fetch(SB + "/rest/v1/rpc/get_vault_secret", {
    method: "POST",
    headers: { "apikey": env.SUPABASE_SERVICE_KEY, "Authorization": "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ secret_name: key })
  });
  const val = await r.text();
  return Response.json({ key, found: val !== "null" && val !== "", preview: val.slice(0, 8) });
}

async function runBootstrap(env) {
  const log = [];
  const tg = async (msg) => {
    log.push(msg);
    await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text: msg, parse_mode: "Markdown" })
    }).catch(() => {});
  };

  await tg("🚀 *Bootstrap Deploy Started*");

  // 1. Pobierz klucze z Vault
  const getSecret = async (name) => {
    const r = await fetch(SB + "/rest/v1/rpc/get_vault_secret", {
      method: "POST",
      headers: { "apikey": env.SUPABASE_SERVICE_KEY, "Authorization": "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ secret_name: name })
    });
    const t = await r.text();
    return t && t !== "null" ? t.replace(/^"|"$/g, "") : null;
  };

  const [coolifyToken, anthropicKey, togetherKey, falKey, tavilyKey] = await Promise.all([
    env.COOLIFY_TOKEN || getSecret("coolify_token"),
    getSecret("anthropic_api_key"),
    getSecret("together_api_key"),
    getSecret("fal_api_key"),
    getSecret("tavily_api_key"),
  ]);

  await tg(`🔑 Vault: coolify=${coolifyToken?"✅":"❌"} anthropic=${anthropicKey?"✅":"❌"} together=${togetherKey?"✅":"❌"}`);

  if (!coolifyToken) return Response.json({ error: "no coolify_token", log });

  // 2. Pobierz server i project UUID
  const servers = await fetch(COOLIFY + "/api/v1/servers", {
    headers: { Authorization: "Bearer " + coolifyToken }
  }).then(r => r.json()).catch(() => []);

  const projects = await fetch(COOLIFY + "/api/v1/projects", {
    headers: { Authorization: "Bearer " + coolifyToken }
  }).then(r => r.json()).catch(() => []);

  const serverUuid = Array.isArray(servers) ? servers[0]?.uuid : null;
  const projectUuid = Array.isArray(projects) ? projects[0]?.uuid : null;

  await tg(`🏗️ Server: ${serverUuid?.slice(0,8)||"?"} Project: ${projectUuid?.slice(0,8)||"?"}`);

  // 3. Stwórz 3 aplikacje
  const apps = [
    {
      name: "clone-engine", git: "https://github.com/szachmacik/clone-engine",
      domain: "https://clone.ofshore.dev", port: "9000",
      envs: { BRAIN_ROUTER_URL: "https://brain-router.ofshore.dev", ROUTER_KEY: "holon-brain-router-2026",
        SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: env.SUPABASE_SERVICE_KEY || "",
        BROWSERLESS_URL: "http://178.62.246.169:3000", TOGETHER_API_KEY: togetherKey||"", TAVILY_API_KEY: tavilyKey||"" }
    },
    {
      name: "genspark-clone", git: "https://github.com/szachmacik/genspark-clone",
      domain: "https://genspark.ofshore.dev", port: "8000",
      envs: { ANTHROPIC_API_KEY: anthropicKey||"", TOGETHER_API_KEY: togetherKey||"",
        FAL_API_KEY: falKey||"", TAVILY_API_KEY: tavilyKey||"", BROWSERLESS_URL: "http://178.62.246.169:3000" }
    },
    {
      name: "onepass", git: "https://github.com/szachmacik/onepass",
      domain: "https://onepass.ofshore.dev", port: "7000",
      envs: { SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: env.SUPABASE_SERVICE_KEY || "", OWNER_EMAIL: "maciej@ofshore.dev" }
    }
  ];

  const results = [];
  for (const app of apps) {
    // Sprawdź czy już istnieje
    const existing = await fetch(COOLIFY + "/api/v1/applications", {
      headers: { Authorization: "Bearer " + coolifyToken }
    }).then(r => r.json()).then(list => Array.isArray(list) ? list.find(a => a.name === app.name) : null).catch(() => null);

    let uuid = existing?.uuid;

    if (!uuid) {
      const createRes = await fetch(COOLIFY + "/api/v1/applications/public", {
        method: "POST",
        headers: { Authorization: "Bearer " + coolifyToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          project_uuid: projectUuid, server_uuid: serverUuid,
          environment_name: "production", git_repository: app.git,
          git_branch: "main", build_pack: "dockerfile", name: app.name,
          domains: app.domain, ports_exposes: app.port, instant_deploy: false
        })
      });
      const d = await createRes.json();
      uuid = d?.uuid;
      results.push({ name: app.name, uuid, status: createRes.status, created: true });
    } else {
      results.push({ name: app.name, uuid, existing: true });
    }

    // Ustaw env vars
    if (uuid) {
      for (const [key, value] of Object.entries(app.envs)) {
        if (!value) continue;
        await fetch(COOLIFY + "/api/v1/applications/" + uuid + "/envs", {
          method: "POST",
          headers: { Authorization: "Bearer " + coolifyToken, "Content-Type": "application/json" },
          body: JSON.stringify({ key, value, is_preview: false, is_build_time: false })
        }).catch(() => {});
      }
      // Deploy
      await fetch(COOLIFY + "/api/v1/deploy?uuid=" + uuid + "&force=false", {
        method: "GET", headers: { Authorization: "Bearer " + coolifyToken }
      }).catch(() => {});
    }
  }

  // 4. SQL - stwórz tabele
  const sqlOps = [];
  const runSql = async (sql) => {
    const r = await fetch(SB + "/rest/v1/rpc/execute_sql_with_result", {
      method: "POST",
      headers: { "apikey": env.SUPABASE_SERVICE_KEY, "Authorization": "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ sql_query: sql })
    });
    return r.ok;
  };

  sqlOps.push(await runSql("CREATE SCHEMA IF NOT EXISTS autonomous"));
  sqlOps.push(await runSql(`CREATE TABLE IF NOT EXISTS autonomous.sandbox_cartridges (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, created_at timestamptz DEFAULT now(), name text NOT NULL, slug text UNIQUE NOT NULL, source_url text NOT NULL, category text DEFAULT 'ai', emoji text DEFAULT '🎮', status text DEFAULT 'idle', last_synced_at timestamptz, snapshot_count int DEFAULT 0, sync_interval_h int DEFAULT 24, owner text DEFAULT 'maciej', is_private boolean DEFAULT true)`));
  sqlOps.push(await runSql(`CREATE TABLE IF NOT EXISTS autonomous.clone_patterns (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, created_at timestamptz DEFAULT now(), clone_id text NOT NULL, product_url text NOT NULL, product_name text, category text, features_count int DEFAULT 0, tech_stack text[] DEFAULT '{}', feature_names text[] DEFAULT '{}', analysis_json jsonb DEFAULT '{}', quality_score float DEFAULT 0)`));
  sqlOps.push(await runSql(`CREATE TABLE IF NOT EXISTS autonomous.clone_jobs (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, created_at timestamptz DEFAULT now(), clone_id text UNIQUE NOT NULL, source_url text NOT NULL, clone_name text, status text DEFAULT 'pending', analysis jsonb DEFAULT '{}', generation_ms int)`));
  sqlOps.push(await runSql(`CREATE TABLE IF NOT EXISTS autonomous.onepass_sessions (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, created_at timestamptz DEFAULT now(), expires_at timestamptz DEFAULT now() + interval '24 hours', token text UNIQUE NOT NULL DEFAULT gen_random_uuid()::text, email text, is_valid boolean DEFAULT true)`));

  const sqlOk = sqlOps.filter(Boolean).length;
  await tg(`✅ *Deploy Complete!*

Apps: ${results.map(r => r.name + (r.created?"✅":"🔄")).join(", ")}
SQL: ${sqlOk}/${sqlOps.length}

https://sandbox.ofshore.dev`);

  return Response.json({ ok: true, apps: results, sql: { total: sqlOps.length, ok: sqlOk }, log });
}
