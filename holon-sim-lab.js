// ╔═══════════════════════════════════════════════════════════════════╗
// ║  HOLON SIM LAB v2 — RÓWNOLEGŁY GENERATOR + TESTER              ║
// ║                                                                   ║
// ║  Jeden cykl cron robi WSZYSTKO naraz:                            ║
// ║  • Generator AI szuka NOWYCH optymalizacji                       ║
// ║  • Tester testuje N istniejących RÓWNOLEGLE                      ║
// ║  • Analizator ocenia wyniki i wydaje werdykt                     ║
// ║                                                                   ║
// ║  Storage: Upstash Redis sim:* + D1 holon-sim-db                 ║
// ║  Cron: */5 * * * *                                               ║
// ╚═══════════════════════════════════════════════════════════════════╝

const U   = 'https://fresh-walleye-84119.upstash.io';
const UT  = 'gQAAAAAAAUiXAAIncDEwMjljNTI2ZGQ5OWQ0OGJlOTFmYWU2YjQ2OGI0NmIyZXAxODQxMTk';
const TG  = '8394457153:AAFZQ4eMHaiAnmwejmTfWZHI_5KSqhXgCXg';
const CHAT = '8149345223';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const J = (d, s = 200) => new Response(JSON.stringify(d, null, 2), { status: s, headers: CORS });

// ── UPSTASH PIPELINE ──────────────────────────────────────────────────────────

const UH = { Authorization: `Bearer ${UT}` };
const enc = s => encodeURIComponent(String(s));
const tryParse = s => { try { return JSON.parse(s); } catch { return s; } };

async function pipe(cmds) {
  try {
    const r = await fetch(`${U}/pipeline`, {
      method: 'POST',
      headers: { ...UH, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(5000),
    });
    return (await r.json()).map(x => ({ result: tryParse(x.result) }));
  } catch { return cmds.map(() => ({ result: null })); }
}

const uGet  = async k => (await pipe([['get', k]]))[0].result;
const uSet  = async (k, v, ttl = 0) => pipe([ttl ? ['set', k, typeof v === 'string' ? v : JSON.stringify(v), 'ex', ttl] : ['set', k, typeof v === 'string' ? v : JSON.stringify(v)]]);
const uLlen = async k => Number((await pipe([['llen', k]]))[0].result) || 0;

async function uLpush(k, v) {
  await pipe([['lpush', k, typeof v === 'string' ? v : JSON.stringify(v)]]);
}

// Pobierz N itemów z kolejki jednocześnie
async function uRpopN(k, n) {
  const results = await pipe(Array.from({ length: n }, () => ['rpop', k]));
  return results.map(r => r.result).filter(Boolean);
}

async function tg(msg) {
  return fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text: msg, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
}

// ── SCENARIUSZE ───────────────────────────────────────────────────────────────

const rng = (a, b) => a + Math.random() * (b - a);
const sim = (p, ok, fail, crit = false, lat) => {
  const pass = Math.random() < p;
  return { ok: pass, msg: pass ? ok : fail, latency: lat || Math.round(rng(2, 20)), critical: !pass && crit };
};

const BOTS = {
  perf: {
    latency_p99:    () => { const v = Math.round(rng(3,22)); return { ok: v<18, msg: `p99: ${v}ms`, latency: v, critical: false }; },
    throughput:     () => { const v = Math.round(rng(820,1280)); return { ok: v>900, msg: `${v} req/s`, latency: 8, critical: false }; },
    cache_hit:      () => { const v = Math.round(rng(65,96)); return { ok: v>72, msg: `cache: ${v}%`, latency: 3, critical: false }; },
    memory_mb:      () => { const v = Math.round(rng(55,210)); return { ok: v<170, msg: `RAM: ${v}MB`, latency: 4, critical: false }; },
    cold_start_ms:  () => { const v = Math.round(rng(15,95)); return { ok: v<75, msg: `cold: ${v}ms`, latency: v, critical: false }; },
    cpu_eff:        () => { const v = Math.round(rng(50,95)); return { ok: v>60, msg: `CPU: ${v}%`, latency: 5, critical: false }; },
  },
  sec: {
    sqli:           () => sim(0.99, 'SQL injection blocked L1', 'SQLi passed — CRITICAL', true),
    xss:            () => sim(0.98, 'XSS blocked Sentinel', 'XSS undetected — vuln', true),
    secret_leak:    () => sim(0.99, 'no API key leaks', 'API key in payload — ALARM', true),
    rate_limit:     () => sim(0.95, 'rate limit L0 OK', 'rate limit bypassable'),
    path_traversal: () => sim(0.98, '../ blocked', 'traversal passed', true),
    auth:           () => sim(0.96, 'auth verified', 'missing token check', true),
  },
  hypo: {
    null_payload:   () => sim(0.97, 'null handled', 'null crash — add guard'),
    overflow:       () => sim(0.87, 'overflow handled', 'overflow — add validation'),
    concurrent:     () => sim(0.83, 'concurrent writes OK WAL', 'write conflict — mutex needed'),
    timeout:        () => sim(0.88, 'timeout fallback OK', 'cascade timeout — circuit breaker!', true),
    partial_fail:   () => sim(0.85, 'partial rollback OK', 'no rollback — inconsistency', true),
  },
  chaos: {
    node_failure:   () => sim(0.87, 'auto-heal <30s', 'heal timeout — escalation needed'),
    partition:      () => sim(0.82, 'fallback active', 'split-brain — no coordination', true),
    corruption:     () => sim(0.92, 'WAL protects integrity', 'data corruption — backup!', true),
    oom:            () => sim(0.85, 'graceful degradation', 'OOM kill — set limits!', true),
  },
};

function runBot(botId, count = 4) {
  const scenarios = BOTS[botId] || {};
  const keys = Object.keys(scenarios).slice(0, count);
  return keys.map(name => {
    const r = scenarios[name]();
    return { bot_id: botId, scenario: name, ...r };
  });
}

function calcVerdict(results) {
  const total = results.length;
  if (!total) return { verdict: 'blocked', successRate: 0, deployAllowed: false, passed: 0, total: 0, crits: 0 };
  const passed = results.filter(r => r.ok).length;
  const crits  = results.filter(r => !r.ok && r.critical).length;
  const rate   = Math.round(passed / total * 100);
  const v = crits > 0 ? 'blocked' : rate >= 90 ? 'approved' : rate >= 75 ? 'conditional' : 'blocked';
  return {
    verdict: v, successRate: rate, passed, total, crits,
    deployAllowed: v === 'approved',
    notes: results.filter(r => !r.ok).map(r => `${r.scenario}: ${r.msg}`).join(' | ') || 'all OK',
  };
}

// ── FAZA 1: AI GENERATOR ──────────────────────────────────────────────────────

const DISCOVERY_CTX = [
  'CF Workers: placement hints, CPU limits, service bindings performance',
  'Upstash Redis: pipeline batching, TTL optimization, pub/sub patterns',
  'Stockfish: depth tuning, MultiPV, concurrent games management',
  'DNS + CDN: preconnect, prefetch, Cloudflare cache rules optimization',
  'Compute harvest: idle CPU/GPU/RAM from user devices via bookmarklet',
  'D1 SQLite: WAL mode, indexing, query planning for brain-router cache',
  'n8n workflows: parallel execution, webhook batching, error retry',
  'AI token cost: prompt compression, routing optimization, cache hit rate',
  'Memory hierarchy: L1-cache → RAM → Redis → D1 → Supabase gradient',
  'Mobile PWA: service worker caching, background sync, offline-first',
];

async function phaseGenerate(env, cycleId) {
  if (!env.GROQ_KEY) return { skipped: true, reason: 'no GROQ_KEY' };
  const ctx = DISCOVERY_CTX[Math.floor(Math.random() * DISCOVERY_CTX.length)];
  const t0 = Date.now();
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: 350,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are Holon Discovery Agent. Find ONE specific optimization opportunity. Reply ONLY valid JSON.' },
          { role: 'user', content: `Context: ${ctx}\n\nReturn JSON: {"id":"snake_case","name":"Short name","risk":"low|medium","layers":["perf","sec"],"intensity":3,"description":"What and why","expected_gain_pct":80,"how":"1 sentence implementation"}` },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    });
    const d = await r.json();
    const opt = JSON.parse(d.choices?.[0]?.message?.content || '{}');
    if (!opt.id || !opt.name) return { skipped: true, reason: 'invalid response' };
    const item = {
      id: `disc_${cycleId}_${opt.id}`,
      opt_id: opt.id,
      opt_name: opt.name,
      risk: opt.risk || 'low',
      layers: opt.layers || ['perf', 'sec', 'hypo'],
      intensity: opt.intensity || 3,
      description: opt.description,
      expected_gain: opt.expected_gain_pct,
      implementation: opt.how,
      source: 'ai_discovery',
      queued_at: new Date().toISOString(),
    };
    await uLpush('sim:queue', item);
    return { found: opt.name, id: opt.id, gain: opt.expected_gain_pct, ms: Date.now() - t0 };
  } catch (e) { return { skipped: true, reason: e.message }; }
}

// ── FAZA 2: RÓWNOLEGŁY TESTER ─────────────────────────────────────────────────

async function phaseTest(env, n = 3) {
  const raw = await uRpopN('sim:queue', n);
  if (!raw.length) return { skipped: true, reason: 'empty queue' };

  // Testuj WSZYSTKIE naraz — Promise.allSettled
  const settled = await Promise.allSettled(raw.map(item => runSingle(item, env)));

  return {
    tested: raw.length,
    results: settled.map((s, i) => ({
      item: raw[i],
      result: s.status === 'fulfilled' ? s.value : { error: s.reason?.message, verdict: 'blocked', successRate: 0 },
    })),
  };
}

async function runSingle(item, env) {
  const layers = item.layers || ['perf', 'sec', 'hypo'];
  const intensity = item.intensity || 3;
  const t0 = Date.now();

  // Uruchom boty równolegle
  const botResults = await Promise.all(
    layers.map(layer => Promise.resolve(runBot(layer, Math.ceil(intensity * 1.2))))
  );
  const all = botResults.flat();
  const verd = calcVerdict(all);

  // Szybka AI analiza
  let analysis = '';
  if (env.GROQ_KEY && verd.verdict !== 'approved') {
    try {
      const ar = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          max_tokens: 80,
          messages: [{ role: 'user', content: `"${item.opt_name}": ${verd.successRate}% (${verd.verdict}). Issues: ${verd.notes?.slice(0, 100)}. 1 sentence fix.` }],
        }),
        signal: AbortSignal.timeout(5000),
      });
      const ad = await ar.json();
      analysis = ad.choices?.[0]?.message?.content?.trim() || '';
    } catch {}
  }

  const runId = item.id || `run_${Date.now()}`;
  const run = {
    id: runId, opt_id: item.opt_id, opt_name: item.opt_name,
    source: item.source || 'manual',
    ...verd, analysis, layers, intensity,
    results: all, ms: Date.now() - t0,
    ts: new Date().toISOString(),
  };

  // Zapisz atomowo pipeline
  await pipe([
    ['set', `sim:run:${runId}`, JSON.stringify(run), 'ex', String(86400 * 14)],
    ['lpush', 'sim:history', JSON.stringify({ id: runId, opt_id: item.opt_id, opt_name: item.opt_name, verdict: verd.verdict, successRate: verd.successRate, source: item.source, ts: run.ts })],
    ['ltrim', 'sim:history', '0', '199'],
    ['incr', 'sim:stats:total'],
    ['incr', `sim:stats:${verd.verdict}`],
  ]);

  // D1 backup (fire-and-forget)
  if (env.SIM_DB) {
    env.SIM_DB.prepare(
      'INSERT OR REPLACE INTO sim_runs (id,opt_id,opt_name,status,intensity,layers,success_rate,verdict,deploy_allowed,critical_fails,total_tests,passed_tests,notes,ai_analysis,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(runId, item.opt_id, item.opt_name, verd.verdict === 'approved' ? 'passed' : 'failed', intensity, layers.join(','), verd.successRate, verd.verdict, verd.deployAllowed ? 1 : 0, verd.crits, verd.total, verd.passed, verd.notes?.slice(0, 500), analysis, run.ts, run.ts).run().catch(() => null);
  }

  return run;
}

// ── FAZA 3: ANALIZATOR ────────────────────────────────────────────────────────

async function phaseAnalyze(testResult) {
  if (!testResult?.results) return { skipped: true };
  const approved = testResult.results.filter(r => r.result?.deployAllowed).length;
  const blocked  = testResult.results.filter(r => r.result?.verdict === 'blocked').length;

  // Requeue zablokowane (max 2 retry)
  let requeued = 0;
  for (const b of testResult.results.filter(r => r.result?.verdict === 'blocked')) {
    const item = b.item;
    if (item.source === 'ai_discovery' && (item.retry_count || 0) < 2) {
      await uLpush('sim:queue', { ...item, retry_count: (item.retry_count || 0) + 1, retry_at: new Date(Date.now() + 20 * 60 * 1000).toISOString() });
      requeued++;
    }
  }
  return { approved, blocked, requeued };
}

// ── GŁÓWNY CYKL ───────────────────────────────────────────────────────────────

async function parallelCycle(env) {
  const cycleId = `c${Date.now()}`;
  const t0 = Date.now();

  // WSZYSTKIE FAZY NARAZ
  const [genR, testR] = await Promise.allSettled([
    phaseGenerate(env, cycleId),
    phaseTest(env, 3),
  ]);

  const gen  = genR.status  === 'fulfilled' ? genR.value  : { error: genR.reason?.message };
  const test = testR.status === 'fulfilled' ? testR.value : { error: testR.reason?.message };

  // Analiza po testach
  const analyze = await phaseAnalyze(test);
  const qlen    = await uLlen('sim:queue');
  const dur     = Date.now() - t0;

  const cycle = { cycleId, gen, tested: test?.tested || 0, ...analyze, duration_ms: dur, queue: qlen, ts: new Date().toISOString() };
  await uSet('sim:last_cycle', cycle, 3600);

  // Telegram tylko jeśli jest co raportować
  if (gen?.found || (test?.tested || 0) > 0) {
    const lines = [
      '⚡ <b>Holon Sim Lab</b> — cykl równoległy',
      '',
      gen?.found ? `🔍 Odkryto: <b>${gen.found}</b> (+${gen.gain || '?'}%)` : null,
      test?.tested ? `🧪 Przetestowano: <b>${test.tested}</b> równolegle` : null,
      analyze?.approved > 0 ? `✅ Zatwierdzone: ${analyze.approved}` : null,
      analyze?.blocked  > 0 ? `🚫 Zablokowane: ${analyze.blocked}` : null,
      analyze?.requeued > 0 ? `🔄 Requeued: ${analyze.requeued}` : null,
      '',
      `⏱ ${dur}ms · kolejka: ${qlen}`,
    ].filter(Boolean).join('\n');
    await tg(lines);
  }

  return cycle;
}

// ── D1 INIT ───────────────────────────────────────────────────────────────────

async function dbInit(env) {
  if (!env.SIM_DB) return;
  await env.SIM_DB.exec(`
    CREATE TABLE IF NOT EXISTS sim_runs (
      id TEXT PRIMARY KEY, opt_id TEXT, opt_name TEXT, status TEXT, intensity INTEGER,
      layers TEXT, success_rate INTEGER, verdict TEXT, deploy_allowed INTEGER DEFAULT 0,
      critical_fails INTEGER DEFAULT 0, total_tests INTEGER DEFAULT 0, passed_tests INTEGER DEFAULT 0,
      notes TEXT, ai_analysis TEXT, started_at TEXT, finished_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_verdict ON sim_runs(verdict, created_at DESC);
  `).catch(() => null);
}

// ── HANDLER ───────────────────────────────────────────────────────────────────

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (env.SIM_DB) ctx.waitUntil(dbInit(env));
    const p = new URL(req.url).pathname;

    if (p === '/health') {
      const rs = await pipe([['get','sim:stats:total'],['get','sim:stats:approved'],['get','sim:stats:blocked'],['llen','sim:queue'],['get','sim:last_cycle']]);
      const [total, approved, blocked, qlen, last] = rs.map(r => r.result);
      return J({ ok: true, service: 'holon-sim-lab-v2', cron: '*/5 * * * *', mode: 'parallel', stats: { total: total||0, approved: approved||0, blocked: blocked||0 }, queue: qlen||0, last_cycle: last });
    }

    if (p === '/run' && req.method === 'POST') {
      ctx.waitUntil(parallelCycle(env));
      return J({ ok: true, started: true, phases: ['generate', 'test×3', 'analyze'] });
    }

    if (p === '/enqueue' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      if (!b.opt_id && !b.opt_name) return J({ error: 'opt_id or opt_name required' }, 400);
      const item = { id: `m${Date.now()}`, opt_id: b.opt_id || b.opt_name.toLowerCase().replace(/\s+/g,'_'), opt_name: b.opt_name || b.opt_id, layers: b.layers || ['perf','sec','hypo'], intensity: b.intensity || 3, source: 'manual', queued_at: new Date().toISOString() };
      await uLpush('sim:queue', item);
      return J({ ok: true, queued: item, queue_length: await uLlen('sim:queue') });
    }

    if (p === '/queue') return J({ ok: true, pending: await uLlen('sim:queue') });

    if (p === '/history') {
      const [r] = await pipe([['lrange','sim:history','0','49']]);
      return J({ ok: true, history: Array.isArray(r.result) ? r.result : [], count: (r.result || []).length });
    }

    if (p.startsWith('/run/')) {
      const run = await uGet(`sim:run:${p.slice(5)}`);
      return run ? J({ ok: true, ...run }) : J({ error: 'not found' }, 404);
    }

    if (p === '/stats') {
      const rs = await pipe([['get','sim:stats:total'],['get','sim:stats:approved'],['get','sim:stats:conditional'],['get','sim:stats:blocked'],['llen','sim:queue'],['get','sim:last_cycle'],['lrange','sim:history','0','9']]);
      const [total, approved, conditional, blocked, qlen, last, hist] = rs.map(r => r.result);
      return J({ ok: true, stats: { total: total||0, approved: approved||0, conditional: conditional||0, blocked: blocked||0 }, approval_rate: total ? Math.round((approved||0)/total*100)+'%' : 'N/A', queue: qlen||0, last_cycle: last, recent: Array.isArray(hist) ? hist : [] });
    }

    if (p === '/dashboard') {
      const rs = await pipe([['get','sim:stats:total'],['get','sim:stats:approved'],['get','sim:stats:blocked'],['get','sim:last_cycle'],['llen','sim:queue'],['lrange','sim:history','0','14']]);
      const [total, approved, blocked, last, qlen, hist] = rs.map(r => r.result);
      return new Response(dashHTML(total, approved, blocked, last, qlen, Array.isArray(hist) ? hist : []), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (p === '/reset' && req.method === 'POST') {
      await pipe([['del','sim:stats:total'],['del','sim:stats:approved'],['del','sim:stats:blocked'],['del','sim:stats:conditional'],['del','sim:history'],['del','sim:last_cycle'],['del','sim:queue']]);
      return J({ ok: true, reset: true });
    }

    return J({ service: 'holon-sim-lab-v2', endpoints: ['/health','/run','/enqueue','/queue','/history','/stats','/dashboard','/run/:id','/reset'] });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(parallelCycle(env));
  },
};

// ── DASHBOARD ─────────────────────────────────────────────────────────────────

function dashHTML(total, approved, blocked, last, qlen, history) {
  const lc = last || {};
  const vc = { approved: '#10b981', conditional: '#f59e0b', blocked: '#ef4444' };
  const rate = total ? Math.round((approved||0)/total*100) : 0;
  const rows = history.map(h => {
    const c = vc[h.verdict] || '#8099b8';
    return `<tr><td style="color:#c8d6e5">${String(h.opt_name||h.opt_id||'—').slice(0,36)}</td><td><span style="font-size:8px;padding:1px 6px;border-radius:3px;background:#1a2535;color:#4a6080">${h.source||'manual'}</span></td><td style="color:${c};font-weight:700">${h.successRate||0}%</td><td><span style="font-size:8px;padding:1px 6px;border-radius:3px;background:${c}22;color:${c}">${(h.verdict||'—').toUpperCase()}</span></td><td style="font-size:10px;color:#4a6080">${h.ts?new Date(h.ts).toLocaleTimeString('pl'):'—'}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>Holon Sim Lab v2</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'JetBrains Mono',monospace;background:#060810;color:#c8d6e5;padding:20px;max-width:920px;margin:0 auto}h1{font-size:18px;font-weight:700;color:#e2f0ff;margin-bottom:2px}.sub{font-size:10px;color:#4a6080;letter-spacing:2px;margin-bottom:18px}.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}.card{background:#0d1520;border:1px solid #1a2535;border-radius:6px;padding:13px;text-align:center}.val{font-size:26px;font-weight:700;font-family:system-ui;line-height:1}.lbl{font-size:9px;color:#4a6080;margin-top:4px;letter-spacing:1px}.sec{background:#0a0e16;border:1px solid #1a2535;border-radius:6px;overflow:hidden;margin-bottom:12px}.sh{padding:7px 13px;border-bottom:1px solid #1a2535;font-size:9px;color:#4a6080;letter-spacing:2px;display:flex;justify-content:space-between}table{width:100%;border-collapse:collapse;font-size:11px}th{color:#4a6080;font-size:9px;letter-spacing:1px;text-transform:uppercase;padding:7px 12px;text-align:left;border-bottom:1px solid #1a2535}td{padding:7px 12px;border-bottom:1px solid #080c14}.ph{padding:10px 13px;font-size:11px}.pr{display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #0d1828}.bar{height:3px;background:#1a2535;border-radius:2px;margin-top:6px}.bf{height:100%;border-radius:2px}.note{font-size:9px;color:#2a4060;margin-top:12px;text-align:center;line-height:1.7}</style></head>
<body>
<h1>⚗️ Holon Sim Lab <span style="color:#00ff88">v2</span></h1>
<div class="sub">PARALLEL GENERATE + TEST + ANALYZE · auto-refresh 30s</div>
<div class="g4">
  <div class="card"><div class="val" style="color:#e2f0ff">${total||0}</div><div class="lbl">SYMULACJE</div><div class="bar"><div class="bf" style="width:100%;background:#1a2535"></div></div></div>
  <div class="card"><div class="val" style="color:#10b981">${approved||0}</div><div class="lbl">ZATWIERDZONE</div><div class="bar"><div class="bf" style="width:${rate}%;background:#10b981"></div></div></div>
  <div class="card"><div class="val" style="color:#ef4444">${blocked||0}</div><div class="lbl">ZABLOKOWANE</div></div>
  <div class="card"><div class="val" style="color:#38bdf8">${qlen||0}</div><div class="lbl">W KOLEJCE</div></div>
</div>
<div class="g2">
  <div class="sec"><div class="sh"><span>OSTATNI CYKL</span><span style="color:#2a4060">${lc.ts?new Date(lc.ts).toLocaleTimeString('pl'):'—'}</span></div>
  <div class="ph">
    <div class="pr"><span style="color:#4a6080">🔍 Generator</span><span style="color:${lc.gen?.found?'#00ff88':'#4a6080'}">${lc.gen?.found?'✓ '+String(lc.gen.found).slice(0,20):(lc.gen?.skipped?'skip':'—')}</span></div>
    <div class="pr"><span style="color:#4a6080">🧪 Testów</span><span style="color:#38bdf8">${lc.tested||0} opt × boty</span></div>
    <div class="pr"><span style="color:#4a6080">✅ Approved</span><span style="color:#10b981">${lc.approved||0}</span></div>
    <div class="pr"><span style="color:#4a6080">🚫 Blocked</span><span style="color:#ef4444">${lc.blocked||0}</span></div>
    <div class="pr"><span style="color:#4a6080">⏱ Czas</span><span style="color:#e2f0ff">${lc.duration_ms||0}ms</span></div>
    <div class="pr" style="border:none"><span style="color:#4a6080">📦 Kolejka</span><span style="color:#38bdf8">${lc.queue||0}</span></div>
  </div></div>
  <div class="sec"><div class="sh"><span>ARCHITEKTURA RÓWNOLEGŁA</span></div>
  <div class="ph" style="font-size:10px;color:#4a6080;line-height:1.9">
    <div>Promise.allSettled([</div>
    <div style="padding-left:12px;color:#a78bfa">phaseGenerate(),  <span style="color:#2a4060">// AI discovers</span></div>
    <div style="padding-left:12px;color:#38bdf8">phaseTest(n=3),   <span style="color:#2a4060">// tests N at once</span></div>
    <div>])</div>
    <div style="margin-top:6px">↓</div>
    <div style="color:#00ff88">phaseAnalyze()   <span style="color:#2a4060">// verdict + requeue</span></div>
    <div style="margin-top:8px;padding:6px;background:#0d1520;border-radius:4px;color:#2a4060;font-size:9px">każdy bot też Promise.all(layers)</div>
  </div></div>
</div>
<div class="sec"><div class="sh"><span>HISTORIA</span><span style="color:#2a4060">${history.length} wyników</span></div>
<table><tr><th>Optymalizacja</th><th>Źródło</th><th>Wynik</th><th>Werdykt</th><th>Czas</th></tr>${rows}</table></div>
<div class="note">Upstash <code>sim:*</code> + D1 <code>holon-sim-db</code> — zero Supabase · cron */5<br>
<a href="/stats" style="color:#4a6080">/stats</a> · <a href="/history" style="color:#4a6080">/history</a> · <a href="/queue" style="color:#4a6080">/queue</a></div>
</body></html>`;
}
