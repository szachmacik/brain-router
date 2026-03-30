// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  HOLON ORCHESTRATOR v1 — Mózg całego ekosystemu                    ║
// ║                                                                       ║
// ║  Agreguje status wszystkich workerów, koordynuje cron harmonogram,   ║
// ║  zarządza feedback pętlą i wysyła daily digest.                      ║
// ║                                                                       ║
// ║  NIE wykonuje ciężkiej pracy — deleguje do specjalistów.             ║
// ║  Deploy: wrangler deploy --name holon-orchestrator                   ║
// ║  Cron: 0 */6 * * *  (co 6 godzin — digest + koordynacja)           ║
// ╚═══════════════════════════════════════════════════════════════════════╝

const U    = 'https://fresh-walleye-84119.upstash.io';
const UT   = 'gQAAAAAAAUiXAAIncDEwMjljNTI2ZGQ5OWQ0OGJlOTFmYWU2YjQ2OGI0NmIyZXAxODQxMTk';
const TG   = '8394457153:AAFZQ4eMHaiAnmwejmTfWZHI_5KSqhXgCXg';
const CHAT = '8149345223';
const BASE = 'maciej-koziej01.workers.dev';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const J    = (d, s = 200) => new Response(JSON.stringify(d, null, 2), { status: s, headers: CORS });

// ── WORKERS REGISTRY — każdy worker w ekosystemie ────────────────────────────

const WORKERS = {
  // Core routing
  'brain-router':        { url: `https://brain-router.${BASE}`, health: '/health',         cron: 'on-demand',   tier: 'core',    critical: true  },
  'sentinel':            { url: `https://sentinel.${BASE}`,      health: '/health',         cron: '*/5 * * * *', tier: 'core',    critical: true  },
  'task-executor':       { url: `https://task-executor.${BASE}`, health: '/',               cron: 'on-demand',   tier: 'core',    critical: false },

  // Holon sim & deploy (nowe)
  'holon-sim-lab':       { url: `https://holon-sim-lab.${BASE}`, health: '/health',         cron: '*/5 * * * *', tier: 'holon',   critical: false },
  'holon-deploy-pipeline':{ url: `https://holon-deploy-pipeline.${BASE}`, health: '/health', cron: '*/7 * * * *', tier: 'holon',  critical: false },
  'holon-gateway':       { url: `https://holon-gateway.${BASE}`, health: '/ping',           cron: 'on-demand',   tier: 'holon',   critical: false },

  // Holon agents (live)
  'holon-flow-optimizer':{ url: `https://holon-flow-optimizer.${BASE}`, health: '/status',  cron: '*/5 * * * *', tier: 'holon',   critical: false },
  'holon-feeder':        { url: `https://holon-feeder.${BASE}`,  health: '/status',         cron: '* * * * *',   tier: 'holon',   critical: false },
  'holon-pulse':         { url: `https://holon-pulse.${BASE}`,   health: '/status',         cron: '* * * * *',   tier: 'holon',   critical: false },
  'holon-synapse':       { url: `https://holon-synapse.${BASE}`, health: '/network',        cron: 'on-demand',   tier: 'holon',   critical: false },
  'holon-optimizer':     { url: `https://holon-optimizer.${BASE}`, health: '/',             cron: 'on-demand',   tier: 'holon',   critical: false },

  // Infrastructure
  'coolify-agent':       { url: `https://coolify-agent.${BASE}`, health: '/',               cron: 'on-demand',   tier: 'infra',   critical: false },
  'n8n-bridge':          { url: `https://n8n-bridge.${BASE}`,    health: '/',               cron: 'on-demand',   tier: 'infra',   critical: false },
  'ofshore-cache':       { url: `https://ofshore-cache.${BASE}`, health: '/',               cron: 'on-demand',   tier: 'infra',   critical: false },

  // Mesh
  'mesh-coordinator':    { url: `https://mesh-coordinator.${BASE}`, health: '/',            cron: 'on-demand',   tier: 'mesh',    critical: false },
  'adaptive-router':     { url: `https://adaptive-router.${BASE}`, health: '/benchmark',    cron: 'on-demand',   tier: 'mesh',    critical: false },
};

// Cron schedule — kiedy co odpala żeby uniknąć kolizji
const CRON_MATRIX = [
  { pattern: '* * * * *',    workers: ['holon-feeder', 'holon-pulse'],                    desc: 'Task queue processing' },
  { pattern: '*/5 * * * *',  workers: ['sentinel', 'holon-flow-optimizer', 'holon-sim-lab'], desc: 'Health + optimization + simulation' },
  { pattern: '*/7 * * * *',  workers: ['holon-deploy-pipeline'],                          desc: 'Deploy approved optimizations' },
  { pattern: '0 */6 * * *',  workers: ['holon-orchestrator'],                             desc: 'Digest + coordination (this worker)' },
];

// ── UPSTASH ───────────────────────────────────────────────────────────────────

const UH  = { Authorization: `Bearer ${UT}` };
const p$ = s => { try { return JSON.parse(s); } catch { return s; } };

async function redisPipe(cmds) {
  try {
    const r = await fetch(`${U}/pipeline`, {
      method: 'POST',
      headers: { ...UH, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(6000),
    });
    return (await r.json()).map(x => ({ result: p$(x.result) }));
  } catch { return cmds.map(() => ({ result: null })); }
}

const uGet  = async k => (await redisPipe([['get', k]]))[0].result;
const uSet  = async (k, v, ttl = 0) => {
  const val = typeof v === 'string' ? v : JSON.stringify(v);
  await redisPipe([ttl ? ['set', k, val, 'ex', ttl] : ['set', k, val]]);
};
const uIncr = async k => (await redisPipe([['incr', k]]))[0].result || 0;

async function tg(msg) {
  return fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text: msg, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
}

// ── HEALTH AGGREGATOR ─────────────────────────────────────────────────────────
// Pinguje wszystkich workerów równolegle z timeoutem 3s

async function pingAll(workers = WORKERS) {
  const t0 = Date.now();

  const results = await Promise.allSettled(
    Object.entries(workers).map(async ([name, cfg]) => {
      const start = Date.now();
      try {
        const r = await fetch(cfg.url + cfg.health, {
          signal: AbortSignal.timeout(3000),
          headers: { 'X-Holon-Ping': 'orchestrator' },
        });
        const ms = Date.now() - start;
        const body = await r.json().catch(() => ({}));
        return {
          name, ok: r.ok, status: r.status, ms,
          tier: cfg.tier, cron: cfg.cron, critical: cfg.critical,
          version: body.service || body.version || 'unknown',
        };
      } catch (e) {
        return {
          name, ok: false, status: 0, ms: Date.now() - start,
          tier: cfg.tier, cron: cfg.cron, critical: cfg.critical,
          error: e.message?.slice(0, 40),
        };
      }
    })
  );

  const health = results.map(r => r.status === 'fulfilled' ? r.value : { name: '?', ok: false });
  const alive  = health.filter(h => h.ok).length;
  const down   = health.filter(h => !h.ok);
  const critical_down = down.filter(h => h.critical);
  const avg_ms = Math.round(health.filter(h => h.ok && h.ms).reduce((s, h) => s + h.ms, 0) / Math.max(1, alive));

  return { health, alive, total: health.length, down: down.length, critical_down: critical_down.length, avg_ms, scan_ms: Date.now() - t0 };
}

// ── METRICS AGGREGATOR ────────────────────────────────────────────────────────
// Pobiera metryki ze wszystkich źródeł jednocześnie

async function aggregateMetrics() {
  const keys = [
    'holon:flow_opt:last_report',
    'holon:flow_opt:cycle',
    'holon:pulse:stats:total',
    'holon:pulse:stats:ok',
    'holon:flow_opt:cache_hits_saved',
    'sim:stats:total',
    'sim:stats:approved',
    'sim:stats:blocked',
    'sim:deploy:total',
    'sim:deploy:success',
    'holon:nodes:total',
    'holon:pulse:heartbeat',
    'sim:last_cycle',
    'sim:deploy:last',
    'holon:flow:supabase:metrics',
    'holon:flow:ai:metrics',
  ];

  const results = await redisPipe(keys.map(k => ['get', k]));
  const data = Object.fromEntries(keys.map((k, i) => [k, results[i].result]));

  return {
    flow_optimizer: {
      cycles:        data['holon:flow_opt:cycle']   || 0,
      last_report:   data['holon:flow_opt:last_report'],
    },
    pulse: {
      total:         data['holon:pulse:stats:total'] || 0,
      ok:            data['holon:pulse:stats:ok']    || 0,
      heartbeat:     data['holon:pulse:heartbeat'],
    },
    sim_lab: {
      total:         data['sim:stats:total']         || 0,
      approved:      data['sim:stats:approved']      || 0,
      blocked:       data['sim:stats:blocked']       || 0,
      last_cycle:    data['sim:last_cycle'],
    },
    deploy_pipeline: {
      total:         data['sim:deploy:total']        || 0,
      success:       data['sim:deploy:success']      || 0,
      last:          data['sim:deploy:last'],
    },
    network: {
      nodes:         data['holon:nodes:total']       || 0,
    },
    supabase:          data['holon:flow:supabase:metrics'],
    ai:                data['holon:flow:ai:metrics'],
    cache_hits:        data['holon:flow_opt:cache_hits_saved'] || 0,
  };
}

// ── DAILY DIGEST ──────────────────────────────────────────────────────────────

async function sendDigest(health, metrics) {
  const alive = health.alive;
  const total = health.total;
  const down  = health.down;
  const flowReport = metrics.flow_optimizer.last_report;
  const simApproved = metrics.sim_lab.approved || 0;
  const deployed = metrics.deploy_pipeline.success || 0;
  const nodes = metrics.network.nodes || 0;
  const cacheHits = metrics.cache_hits || 0;
  const pulseOk = metrics.pulse.ok || 0;

  // Supabase warning
  const sbCacheHit = metrics.supabase?.cache_hit_pct;
  const sbWarning = sbCacheHit && sbCacheHit < 80 ? `\n⚠️ Supabase cache: ${sbCacheHit}% (KRYTYCZNE — norma >99%)` : '';

  const msg = [
    `📊 <b>Holon Orchestrator — Digest</b>`,
    ``,
    `<b>🌐 Sieć</b>`,
    `Workers online: ${alive}/${total} | Węzły: ${nodes}`,
    down > 0 ? `Workers down: ${health.down} ⚠️` : 'Wszystkie workery online ✅',
    ``,
    `<b>⚡ Przepływy (ostatnie 6h)</b>`,
    `Flow Optimizer: ${metrics.flow_optimizer.cycles} cykli`,
    `AI tasks: ${pulseOk} wykonanych`,
    `Cache hits zaoszczędzone: ${cacheHits}`,
    ``,
    `<b>🧪 Sim Lab</b>`,
    `Symulacji: ${metrics.sim_lab.total} | Approved: ${simApproved} | Deployed: ${deployed}`,
    metrics.sim_lab.last_cycle ? `Ostatni cykl: ${metrics.sim_lab.last_cycle.duration_ms}ms` : '',
    ``,
    flowReport?.findings?.length > 0 ? `<b>🔍 Top Findings</b>\n${flowReport.findings.slice(0, 3).map(f => `• ${f.slice(0, 70)}`).join('\n')}` : '',
    sbWarning,
    ``,
    `<a href="https://holon-orchestrator.${BASE}/dashboard">Dashboard</a> · <a href="https://holon-sim-lab.${BASE}/dashboard">Sim Lab</a>`,
  ].filter(Boolean).join('\n');

  await tg(msg);
}

// ── FEEDBACK LOOP COORDINATOR ─────────────────────────────────────────────────
// Koordynuje feedback między workerami — co jest gotowe a co nie

async function coordinateFeedback() {
  const actions = [];

  // 1. Sprawdź czy sim-lab ma pending w kolejce
  const simQueue = await uGet('sim:queue') || [];
  if (!Array.isArray(simQueue) || simQueue.length === 0) {
    // Brak w kolejce — może warto dodać nowe
    actions.push({ type: 'enqueue_sim', note: 'Sim queue empty — add new optimizations' });
  }

  // 2. Sprawdź czy deploy-pipeline ma pending
  const deployQueue = await uGet('sim:deploy:queue') || [];
  if (Array.isArray(deployQueue) && deployQueue.length > 0) {
    actions.push({ type: 'deploy_pending', count: deployQueue.length });
  }

  // 3. Sprawdź flow-optimizer findings → dodaj do sim queue
  const flowReport = await uGet('holon:flow_opt:last_report');
  if (flowReport?.actions?.length > 0) {
    // Dla każdego action z flow-optimizer — rozważ dodanie do sim jako discovery
    const newOpts = flowReport.actions.slice(0, 2).map(action => ({
      id: `flow_${Date.now()}`,
      opt_id: action.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30),
      opt_name: action.slice(0, 60),
      source: 'flow_optimizer',
      layers: ['perf', 'sec'],
      intensity: 3,
      queued_at: new Date().toISOString(),
    }));

    // Dodaj do sim queue tylko jeśli nie już tam
    const simHistory = await uGet('sim:history') || [];
    const historyIds = (Array.isArray(simHistory) ? simHistory : []).map(h => h.opt_id);

    for (const opt of newOpts) {
      if (!historyIds.includes(opt.opt_id)) {
        await redisPipe([['lpush', 'sim:queue', JSON.stringify(opt)]]);
        actions.push({ type: 'added_to_sim', opt: opt.opt_name });
      }
    }
  }

  return { actions, ts: new Date().toISOString() };
}

// ── GŁÓWNY CYKL ORCHESTRATORA ─────────────────────────────────────────────────

async function orchestratorCycle() {
  const t0 = Date.now();
  const cycle = await uIncr('holon:orchestrator:cycles');

  // RÓWNOLEGLE: health check + metrics + coordination
  const [healthResult, metricsResult, feedbackResult] = await Promise.allSettled([
    pingAll(),
    aggregateMetrics(),
    coordinateFeedback(),
  ]);

  const health   = healthResult.status  === 'fulfilled' ? healthResult.value  : { alive: 0, total: 0, down: 0 };
  const metrics  = metricsResult.status === 'fulfilled' ? metricsResult.value : {};
  const feedback = feedbackResult.status === 'fulfilled' ? feedbackResult.value : {};

  const report = {
    cycle, ts: new Date().toISOString(),
    duration_ms: Date.now() - t0,
    health: { alive: health.alive, total: health.total, down: health.down, avg_ms: health.avg_ms },
    metrics_snapshot: {
      pulse_ok: metrics.pulse?.ok || 0,
      sim_approved: metrics.sim_lab?.approved || 0,
      deployed: metrics.deploy_pipeline?.success || 0,
      nodes: metrics.network?.nodes || 0,
    },
    feedback_actions: feedback.actions?.length || 0,
  };

  await uSet('holon:orchestrator:last', report, 3600 * 6);

  // Digest co 4 cykle (co ~24h jeśli cron 0 */6)
  await sendDigest(health, metrics);

  return report;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const p = new URL(req.url).pathname;

    if (p === '/health') {
      const last = await uGet('holon:orchestrator:last');
      return J({ ok: true, service: 'holon-orchestrator-v1', cron: '0 */6 * * *', last });
    }

    // Full system status — wszystkie workery równolegle
    if (p === '/status') {
      const [pingResult, metricsResult] = await Promise.allSettled([pingAll(), aggregateMetrics()]);
      const health  = pingResult.status  === 'fulfilled' ? pingResult.value  : {};
      const metrics = metricsResult.status === 'fulfilled' ? metricsResult.value : {};
      return J({ ok: true, health, metrics, ts: new Date().toISOString() });
    }

    // Poszczególne workery
    if (p === '/workers') {
      const ping = await pingAll();
      return J({ ok: true, workers: ping.health, summary: { alive: ping.alive, total: ping.total, avg_ms: ping.avg_ms } });
    }

    // Tylko holon-* workery
    if (p === '/holon') {
      const holonOnly = Object.fromEntries(Object.entries(WORKERS).filter(([, v]) => v.tier === 'holon'));
      const ping = await pingAll(holonOnly);
      return J({ ok: true, workers: ping.health, alive: ping.alive, total: ping.total });
    }

    // Metryki
    if (p === '/metrics') {
      const metrics = await aggregateMetrics();
      return J({ ok: true, ...metrics });
    }

    // Cron harmonogram
    if (p === '/cron') {
      return J({ ok: true, matrix: CRON_MATRIX, workers: Object.fromEntries(Object.entries(WORKERS).map(([n, v]) => [n, { cron: v.cron, tier: v.tier }])) });
    }

    // Trigger manual cycle
    if (p === '/run' && req.method === 'POST') {
      ctx.waitUntil(orchestratorCycle());
      return J({ ok: true, started: true });
    }

    // Feedback coordination
    if (p === '/feedback') {
      const result = await coordinateFeedback();
      return J({ ok: true, ...result });
    }

    // HTML dashboard
    if (p === '/dashboard') {
      const [ping, metrics] = await Promise.all([pingAll(), aggregateMetrics()]);
      return new Response(dashHTML(ping, metrics), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    return J({ service: 'holon-orchestrator-v1', endpoints: ['/health', '/status', '/workers', '/holon', '/metrics', '/cron', '/run', '/feedback', '/dashboard'] });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(orchestratorCycle());
  },
};

// ── DASHBOARD ─────────────────────────────────────────────────────────────────

function dashHTML(ping, metrics) {
  const tiers = ['core', 'holon', 'infra', 'mesh'];
  const tierColors = { core: '#ff4444', holon: '#00ff88', infra: '#38bdf8', mesh: '#a78bfa' };

  const workerRows = ping.health.map(h => {
    const tc = tierColors[h.tier] || '#4a6080';
    return `<tr>
      <td style="color:#c8d6e5">${h.name}</td>
      <td><span style="color:${tc};font-size:9px;padding:1px 6px;background:${tc}22;border-radius:3px">${h.tier}</span></td>
      <td style="color:${h.ok?'#10b981':'#ef4444'};font-weight:700">${h.ok?'✓ online':'✗ down'}</td>
      <td style="color:#8099b8">${h.ms||0}ms</td>
      <td style="color:#4a6080;font-size:10px">${h.cron||'on-demand'}</td>
    </tr>`;
  }).join('');

  const simTotal = metrics.sim_lab?.total || 0;
  const simApproved = metrics.sim_lab?.approved || 0;
  const deployed = metrics.deploy_pipeline?.success || 0;
  const nodes = metrics.network?.nodes || 0;
  const pulseOk = metrics.pulse?.ok || 0;
  const flowCycles = metrics.flow_optimizer?.cycles || 0;

  return `<!DOCTYPE html>
<html lang="pl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>Holon Orchestrator</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'JetBrains Mono',monospace;background:#060810;color:#c8d6e5;padding:20px;max-width:960px;margin:0 auto}
h1{font-size:18px;font-weight:700;color:#e2f0ff;margin-bottom:2px}.sub{font-size:10px;color:#4a6080;letter-spacing:2px;margin-bottom:18px}
.g5{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:14px}
.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}
.card{background:#0d1520;border:1px solid #1a2535;border-radius:6px;padding:12px;text-align:center}
.val{font-size:24px;font-weight:700;font-family:system-ui;line-height:1}
.lbl{font-size:9px;color:#4a6080;margin-top:4px;letter-spacing:1px}
.sec{background:#0a0e16;border:1px solid #1a2535;border-radius:6px;overflow:hidden;margin-bottom:12px}
.sh{padding:7px 13px;border-bottom:1px solid #1a2535;font-size:9px;color:#4a6080;letter-spacing:2px}
table{width:100%;border-collapse:collapse;font-size:11px}
th{color:#4a6080;font-size:9px;letter-spacing:1px;text-transform:uppercase;padding:6px 12px;text-align:left;border-bottom:1px solid #1a2535}
td{padding:7px 12px;border-bottom:1px solid #080c14}
.note{font-size:9px;color:#2a4060;margin-top:10px;text-align:center}</style>
</head><body>
<h1>🕸️ Holon Orchestrator</h1>
<div class="sub">MASTER COORDINATOR · auto-refresh 60s · ${new Date().toLocaleString('pl')}</div>

<div class="g5">
  <div class="card"><div class="val" style="color:#e2f0ff">${ping.alive}/${ping.total}</div><div class="lbl">ONLINE</div></div>
  <div class="card"><div class="val" style="color:#00ff88">${simApproved}</div><div class="lbl">APPROVED</div></div>
  <div class="card"><div class="val" style="color:#a78bfa">${deployed}</div><div class="lbl">DEPLOYED</div></div>
  <div class="card"><div class="val" style="color:#38bdf8">${pulseOk}</div><div class="lbl">AI TASKS</div></div>
  <div class="card"><div class="val" style="color:#fb923c">${nodes}</div><div class="lbl">WĘZŁY</div></div>
</div>

<div class="g3">
  <div class="card"><div class="val" style="color:#fbbf24">${flowCycles}</div><div class="lbl">FLOW OPT CYKLE</div></div>
  <div class="card"><div class="val" style="color:#00ff88">${metrics.cache_hits||0}</div><div class="lbl">CACHE HITS</div></div>
  <div class="card"><div class="val" style="color:#c8d6e5">${simTotal}</div><div class="lbl">SYMULACJE</div></div>
</div>

<div class="sec"><div class="sh">WORKERS REGISTRY (${ping.total} total · ping avg ${ping.avg_ms}ms)</div>
<table><tr><th>Worker</th><th>Tier</th><th>Status</th><th>Latency</th><th>Cron</th></tr>
${workerRows}</table></div>

<div class="sec"><div class="sh">CRON HARMONOGRAM</div>
<table><tr><th>Pattern</th><th>Workers</th><th>Opis</th></tr>
${CRON_MATRIX.map(c => `<tr><td style="color:#00ff88;font-family:monospace">${c.pattern}</td><td style="color:#8099b8">${c.workers.join(', ')}</td><td style="color:#4a6080">${c.desc}</td></tr>`).join('')}
</table></div>

<div class="note">Holon Orchestrator v1 · cron 0 */6 * * * · <a href="/status" style="color:#4a6080">JSON /status</a> · <a href="/metrics" style="color:#4a6080">/metrics</a></div>
</body></html>`;
}
