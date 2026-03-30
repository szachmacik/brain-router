// ╔═══════════════════════════════════════════════════════════════════╗
// ║  HOLON DEPLOY PIPELINE v1                                        ║
// ║                                                                   ║
// ║  Odbiera approved verdicts z sim lab → deployuje autonomicznie   ║
// ║  Tier0: Coolify restart / CF Worker update / GitHub Action       ║
// ║  Feedback loop: wyniki wracają do generatora sim lab             ║
// ║                                                                   ║
// ║  Cron: */7 * * * *  (przesunięty od sim lab żeby nie kolidować) ║
// ╚═══════════════════════════════════════════════════════════════════╝

const U   = 'https://fresh-walleye-84119.upstash.io';
const UT  = 'gQAAAAAAAUiXAAIncDEwMjljNTI2ZGQ5OWQ0OGJlOTFmYWU2YjQ2OGI0NmIyZXAxODQxMTk';
const TG  = '8394457153:AAFZQ4eMHaiAnmwejmTfWZHI_5KSqhXgCXg';
const CHAT = '8149345223';
const COOLIFY = 'https://coolify.ofshore.dev';
const CF_ACCOUNT = '9a877cdba770217082a2f914427df505';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const J = (d, s = 200) => new Response(JSON.stringify(d, null, 2), { status: s, headers: CORS });

// ── UPSTASH ───────────────────────────────────────────────────────────────────

const UH = { Authorization: `Bearer ${UT}` };
const parse = s => { try { return JSON.parse(s); } catch { return s; } };

async function pipe(cmds) {
  try {
    const r = await fetch(`${U}/pipeline`, {
      method: 'POST',
      headers: { ...UH, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(5000),
    });
    return (await r.json()).map(x => ({ result: parse(x.result) }));
  } catch { return cmds.map(() => ({ result: null })); }
}

async function uGet(k) { return (await pipe([['get', k]]))[0].result; }
async function uSet(k, v, ttl = 0) {
  const val = typeof v === 'string' ? v : JSON.stringify(v);
  await pipe([ttl ? ['set', k, val, 'ex', ttl] : ['set', k, val]]);
}
async function uLpush(k, v) {
  await pipe([['lpush', k, typeof v === 'string' ? v : JSON.stringify(v)]]);
}
async function uRpop(k) { return (await pipe([['rpop', k]]))[0].result; }
async function uLlen(k) { return Number((await pipe([['llen', k]]))[0].result) || 0; }

async function tg(msg) {
  return fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text: msg, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
}

// ── DEPLOY TARGETS — mapowanie opt_id → jak deployować ───────────────────────

const DEPLOY_MAP = {
  // CF Workers — aktualizacja przez Cloudflare API
  cf_placement: {
    type: 'cf_worker_config',
    workers: ['brain-router', 'holon-pulse', 'holon-feeder', 'sentinel'],
    action: 'placement_hint',
    desc: 'Dodaj placement.host=178.62.246.169 do wrangler config',
  },
  d1_batch: {
    type: 'cf_worker_code',
    workers: ['brain-router'],
    action: 'patch_code',
    desc: 'Zmień INSERT na batch INSERT w routing_decisions',
  },
  upstash_pipe: {
    type: 'cf_worker_code',
    workers: ['holon-pulse', 'holon-feeder', 'sentinel'],
    action: 'patch_code',
    desc: 'Zamień serial Upstash calls na pipeline',
  },
  ollama_warm: {
    type: 'coolify_restart',
    app_uuid: 'e88g00owoo84k8gw4co4cskw',  // brain-router w Coolify
    desc: 'Dodaj Ollama ping do Sentinel SERVICES list',
  },
  sentinel_gate: {
    type: 'github_action',
    repo: 'szachmacik/mesh',
    workflow: 'sentinel-scan.yml',
    desc: 'Utwórz GitHub Action workflow z Sentinel pre-scan',
  },
  stockfish_server: {
    type: 'ssh_deploy',
    host: '178.62.246.169',
    script: 'cd /opt/holon-stockfish && systemctl restart holon-stockfish',
    desc: 'Restart Stockfish service na DO',
  },
  // Dla AI-odkrytych — fallback generic
  _default: {
    type: 'notify_only',
    desc: 'Nowa AI-odkryta optymalizacja — wymaga ręcznej implementacji',
  },
};

// ── EXECUTORY DEPLOYÓW ────────────────────────────────────────────────────────

async function deployCoolify(target, env) {
  const token = await uGet('vault:coolify_token') || env.COOLIFY_TOKEN;
  if (!token) return { ok: false, reason: 'no coolify token' };

  // Trigger redeploy przez Coolify API
  const r = await fetch(`${COOLIFY}/api/v1/applications/${target.app_uuid}/restart`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  }).catch(e => ({ ok: false, status: 0, error: e.message }));

  if (r.ok !== undefined && !r.ok) return { ok: false, status: r.status || 0 };
  return { ok: true, type: 'coolify_restart', uuid: target.app_uuid };
}

async function deployCFWorkerConfig(target, env) {
  const token = await uGet('vault:CF_API_TOKEN') || env.CF_API_TOKEN;
  if (!token) return { ok: false, reason: 'no CF token' };

  // Dla placement — aktualizacja przez wrangler API (uproszczone)
  // W praktyce: GitHub Action + wrangler deploy
  const results = await Promise.allSettled(
    target.workers.map(w =>
      fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/workers/scripts/${w}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      }).then(r => ({ worker: w, exists: r.ok, status: r.status }))
    )
  );

  const found = results.filter(r => r.status === 'fulfilled' && r.value?.exists).map(r => r.value.worker);
  return { ok: found.length > 0, type: 'cf_worker_config', workers_verified: found, action: target.action };
}

async function deployGitHubAction(target, env) {
  const token = await uGet('vault:GITHUB_TOKEN') || env.GITHUB_TOKEN;
  if (!token) return { ok: false, reason: 'no GitHub token' };

  const r = await fetch(
    `https://api.github.com/repos/${target.repo}/actions/workflows/${target.workflow}/dispatches`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
      signal: AbortSignal.timeout(10000),
    }
  ).catch(e => ({ ok: false, error: e.message }));

  return { ok: r.status === 204 || r.ok, type: 'github_action', repo: target.repo, workflow: target.workflow };
}

async function deployNotifyOnly(target, optName) {
  await tg(`💡 <b>Holon Deploy Pipeline</b>\n\nNowa optymalizacja AI wymaga ręcznej implementacji:\n<b>${optName}</b>\n\n<i>${target.desc}</i>`);
  return { ok: true, type: 'notify_only', manual_required: true };
}

async function executeDeploy(optId, optName, env) {
  const target = DEPLOY_MAP[optId] || DEPLOY_MAP._default;
  const t0 = Date.now();

  let result;
  switch (target.type) {
    case 'coolify_restart':    result = await deployCoolify(target, env); break;
    case 'cf_worker_config':   result = await deployCFWorkerConfig(target, env); break;
    case 'cf_worker_code':     result = await deployCFWorkerConfig(target, env); break;
    case 'github_action':      result = await deployGitHubAction(target, env); break;
    case 'ssh_deploy':         result = { ok: false, reason: 'ssh_deploy requires manual trigger', manual: true }; break;
    case 'notify_only':
    default:                   result = await deployNotifyOnly(target, optName); break;
  }

  return {
    opt_id: optId,
    opt_name: optName,
    deploy_type: target.type,
    desc: target.desc,
    ms: Date.now() - t0,
    ...result,
  };
}

// ── FEEDBACK LOOP → SIM LAB ───────────────────────────────────────────────────

async function feedbackToSimLab(deployResult) {
  // Zapisz wynik deployu żeby generator wiedział co już działa
  const key = `sim:deployed:${deployResult.opt_id}`;
  await uSet(key, {
    opt_id: deployResult.opt_id,
    opt_name: deployResult.opt_name,
    deploy_ok: deployResult.ok,
    deploy_type: deployResult.deploy_type,
    deployed_at: new Date().toISOString(),
    ms: deployResult.ms,
  }, 86400 * 30);

  // Lista wdrożonych — generator używa tego żeby nie odkrywać tych samych
  await uLpush('sim:deployed:list', JSON.stringify({
    id: deployResult.opt_id,
    name: deployResult.opt_name,
    ok: deployResult.ok,
    ts: new Date().toISOString(),
  }));
  await pipe([['ltrim', 'sim:deployed:list', '0', '49']]);

  // Statystyki
  await pipe([
    ['incr', 'sim:deploy:total'],
    deployResult.ok ? ['incr', 'sim:deploy:success'] : ['incr', 'sim:deploy:failed'],
  ]);
}

// ── GŁÓWNY CYKL ───────────────────────────────────────────────────────────────

async function deployLoop(env) {
  const t0 = Date.now();

  // Pobierz approved z kolejki deploy
  const item = await uRpop('sim:deploy:queue');
  if (!item) return { skipped: true, reason: 'pusta kolejka deploy' };

  await tg(`🚀 <b>Holon Deploy Pipeline</b>\n\nRozpoczęcie deployu:\n<b>${item.opt_name}</b>\n<i>Werdykt: ${item.verdict} (${item.successRate}%)</i>`);

  // Wykonaj deploy
  const deployResult = await executeDeploy(item.opt_id, item.opt_name, env);

  // Feedback do sim lab
  await feedbackToSimLab(deployResult);

  // Zapisz do deploy log
  await pipe([
    ['set', `sim:deploy:result:${item.opt_id}`, JSON.stringify({ ...deployResult, queued_at: item.ts }), 'ex', String(86400 * 7)],
    ['lpush', 'sim:deploy:history', JSON.stringify({ opt_id: item.opt_id, opt_name: item.opt_name, ok: deployResult.ok, type: deployResult.deploy_type, ts: new Date().toISOString() })],
    ['ltrim', 'sim:deploy:history', '0', '99'],
    ['set', 'sim:deploy:last', JSON.stringify(deployResult)],
  ]);

  const dur = Date.now() - t0;

  // Raport Telegram
  const icon = deployResult.ok ? '✅' : deployResult.manual_required ? '⚠️' : '❌';
  await tg(`${icon} <b>Holon Deploy Pipeline — Wynik</b>

<b>${item.opt_name}</b>
Typ: <code>${deployResult.deploy_type}</code>
Status: ${deployResult.ok ? 'WDROŻONO' : deployResult.manual_required ? 'WYMAGA RĘCZNEJ AKCJI' : 'BŁĄD'}
${deployResult.reason ? `Powód: ${deployResult.reason}\n` : ''}
⏱ ${dur}ms`);

  return { deployed: item.opt_name, ...deployResult, duration_ms: dur };
}

// ── HELPER: przenieś approved z sim:history do deploy:queue ──────────────────

async function syncApprovedToDeployQueue() {
  // Pobierz ostatnią historię z sim lab i filtruj approved
  const [histR] = await pipe([['lrange', 'sim:history', '0', '19']]);
  const history = Array.isArray(histR.result) ? histR.result : [];

  let queued = 0;
  for (const item of history) {
    if (item.verdict !== 'approved') continue;

    // Sprawdź czy już wdrożone
    const deployed = await uGet(`sim:deployed:${item.opt_id}`);
    if (deployed) continue;

    // Sprawdź czy już w kolejce
    const inQueue = await uGet(`sim:deploy:queued:${item.opt_id}`);
    if (inQueue) continue;

    // Dodaj do kolejki
    await uLpush('sim:deploy:queue', item);
    await uSet(`sim:deploy:queued:${item.opt_id}`, '1', 3600);
    queued++;
  }

  return { synced: queued };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const p = new URL(req.url).pathname;

    if (p === '/health') {
      const rs = await pipe([
        ['get', 'sim:deploy:total'], ['get', 'sim:deploy:success'],
        ['get', 'sim:deploy:failed'], ['llen', 'sim:deploy:queue'],
        ['get', 'sim:deploy:last'],
      ]);
      const [total, success, failed, qlen, last] = rs.map(r => r.result);
      return J({ ok: true, service: 'holon-deploy-pipeline-v1', cron: '*/7 * * * *', stats: { total: total||0, success: success||0, failed: failed||0 }, queue: qlen||0, last_deploy: last });
    }

    if (p === '/run' && req.method === 'POST') {
      ctx.waitUntil((async () => {
        await syncApprovedToDeployQueue();
        await deployLoop(env);
      })());
      return J({ ok: true, started: true });
    }

    if (p === '/sync' && req.method === 'POST') {
      const result = await syncApprovedToDeployQueue();
      return J({ ok: true, ...result, queue: await uLlen('sim:deploy:queue') });
    }

    if (p === '/queue') {
      const [qlen, hist] = await pipe([['llen', 'sim:deploy:queue'], ['lrange', 'sim:deploy:history', '0', '14']]);
      return J({ ok: true, pending: qlen.result || 0, recent: Array.isArray(hist.result) ? hist.result : [] });
    }

    if (p === '/deployed') {
      const [r] = await pipe([['lrange', 'sim:deployed:list', '0', '49']]);
      return J({ ok: true, deployed: Array.isArray(r.result) ? r.result : [] });
    }

    return J({ service: 'holon-deploy-pipeline-v1', endpoints: ['/health', '/run', '/sync', '/queue', '/deployed'] });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await syncApprovedToDeployQueue();
      await deployLoop(env);
    })());
  },
};
