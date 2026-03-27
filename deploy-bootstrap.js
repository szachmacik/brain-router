const SB = "https://blgdhfcosqjzrutncbbr.supabase.co";
const TG = "8394457153:AAFZQ4eMHaiAnmwejmTfWZHI_5KSqhXgCXg";
const CHAT = "8149345223";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, worker: "bootstrap-deployer", has_sb_key: !!env.SUPABASE_SERVICE_KEY });
    if (url.pathname === "/run" && request.method === "POST") return runBootstrap(env);
    if (url.pathname === "/sql" && request.method === "POST") return runSQL(request, env);
    return Response.json({ endpoints: ["/health", "/run", "/sql"] });
  }
};

async function runSQL(request, env) {
  const { sql } = await request.json().catch(() => ({}));
  if (!sql) return Response.json({ error: "sql required" }, { status: 400 });

  // Metoda 1: execute_sql_with_result RPC
  let r = await fetch(SB + "/rest/v1/rpc/execute_sql_with_result", {
    method: "POST",
    headers: { "apikey": env.SUPABASE_SERVICE_KEY, "Authorization": "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ sql_query: sql })
  });
  
  if (r.ok) {
    const d = await r.json();
    return Response.json({ ok: true, method: "rpc", result: d });
  }

  // Metoda 2: raw SQL przez pg connection
  const r2 = await fetch(SB + "/rest/v1/rpc/exec", {
    method: "POST",
    headers: { "apikey": env.SUPABASE_SERVICE_KEY, "Authorization": "Bearer " + env.SUPABASE_SERVICE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ sql })
  });

  return Response.json({ ok: r2.ok, method: "exec", status: r.status, status2: r2.status });
}

async function runBootstrap(env) {
  // ... same as before
  return Response.json({ ok: true, note: "use /sql for SQL operations" });
}
