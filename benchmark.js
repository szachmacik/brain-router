// HOLON-META: {
//   purpose: "brain-router",
//   morphic_field: "agent-state:4c67a2b1-6830-44ec-97b1-7c8f93722add",
//   startup_protocol: "READ morphic_field + biofield_external + em_grid",
//   wiki: "32d6d069-74d6-8164-a6d5-f41c3d26ae9b"
// }

const CORS = {"Access-Control-Allow-Origin":"*"};

const HTML = `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Benchmark — ofshore.dev vs Genspark</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  :root{--a:#6366f1;--b:#10b981;--c:#f59e0b;--bg:#09090f;--s:#12121a;--b2:#1a1a26;--t:#e8e8f0;--m:#6b6b8a;--d:#3a3a52}
  body{background:var(--bg);color:var(--t);font-family:'JetBrains Mono',monospace}
  .card{background:var(--s);border-radius:12px;border:1px solid var(--d)}
  .bar{height:5px;border-radius:3px;background:var(--d);overflow:hidden}
  .barfill{height:100%;border-radius:3px;transition:width .8s cubic-bezier(.4,0,.2,1)}
  .pill{padding:2px 10px;border-radius:20px;font-size:10px;font-weight:700;letter-spacing:1px}
  .tab{padding:9px 14px;border:none;background:transparent;cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;border-bottom:2px solid transparent;transition:all .2s;color:var(--m)}
  .tab.on{color:var(--t);border-color:var(--a)}
  .tier-btn{padding:8px 16px;border-radius:8px;border:1px solid var(--d);background:transparent;cursor:pointer;font-family:inherit;font-size:12px;color:var(--m);transition:all .2s}
  .tier-btn.on{border-color:var(--a);background:rgba(99,102,241,.15);color:#a5b4fc}
  .cost-row{display:grid;grid-template-columns:130px 1fr 1fr 1fr;gap:8px;align-items:center;padding:10px 14px;border-radius:8px;border:1px solid var(--d);margin-bottom:6px;background:rgba(255,255,255,.02)}
  .cost-row:hover{background:rgba(255,255,255,.04)}
  .feat-row{display:grid;grid-template-columns:140px 1fr 1fr 1fr;gap:10px;margin-bottom:12px}
  .stack-row{display:grid;grid-template-columns:130px 1fr 1fr 1fr;gap:8px;margin-bottom:6px;border-radius:8px;overflow:hidden;border:1px solid var(--d)}
  .stack-cell{padding:10px 12px;background:rgba(0,0,0,.2);border-left:1px solid var(--d)}
  .stack-cell:first-child{border-left:none;background:rgba(255,255,255,.02)}
  .va{color:var(--a)}.vb{color:var(--b)}.vc{color:var(--c)}
  h1{font-size:clamp(18px,4vw,28px);font-weight:900;line-height:1.2}
  @media(max-width:640px){.cost-row,.feat-row,.stack-row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div style="max-width:1000px;margin:0 auto;padding:20px 16px 60px">

<!-- HEADER -->
<div style="border-bottom:1px solid var(--d);padding-bottom:20px;margin-bottom:24px">
  <div style="font-size:10px;color:var(--a);letter-spacing:3px;text-transform:uppercase;margin-bottom:6px;font-weight:700">ofshore.dev · live benchmark</div>
  <h1>Genspark 1:1 vs Best-of-Breed<br><span style="color:var(--c)">vs ofshore Mesh AI</span></h1>
  <p style="color:var(--m);font-size:12px;margin-top:6px">Realny cennik Q1 2026 · GPT-5.2, Groq, fal.ai, Twilio, Together.ai</p>
</div>

<!-- TIER -->
<div style="margin-bottom:20px">
  <div style="font-size:10px;color:var(--m);letter-spacing:2px;text-transform:uppercase;margin-bottom:10px">Tier użytkownika</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap">
    <button class="tier-btn on" onclick="setTier('light',this)">
      <div style="font-weight:700">Light</div>
      <div style="font-size:10px;opacity:.6">50 chat / 5 slides / 2 img</div>
    </button>
    <button class="tier-btn" onclick="setTier('medium',this)">
      <div style="font-weight:700">Medium</div>
      <div style="font-size:10px;opacity:.6">200 chat / 20 slides / 10 img / 5 calls</div>
    </button>
    <button class="tier-btn" onclick="setTier('heavy',this)">
      <div style="font-weight:700">Heavy</div>
      <div style="font-size:10px;opacity:.6">1000 chat / 100 slides / 50 img / 20 calls</div>
    </button>
  </div>
</div>

<!-- SUMMARY CARDS -->
<div id="cards" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px"></div>

<!-- SAVINGS -->
<div id="savings" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px"></div>

<!-- TABS -->
<div style="display:flex;gap:0;border-bottom:1px solid var(--d);margin-bottom:24px">
  <button class="tab on" onclick="showTab('costs',this)">💰 Koszty</button>
  <button class="tab" onclick="showTab('features',this)">📊 Features</button>
  <button class="tab" onclick="showTab('stack',this)">🔧 Stack</button>
  <button class="tab" onclick="showTab('market',this)">📈 Market Value</button>
</div>

<div id="tab-costs"></div>
<div id="tab-features" style="display:none"></div>
<div id="tab-stack" style="display:none"></div>
<div id="tab-market" style="display:none"></div>

<div style="margin-top:32px;padding:14px;border-radius:10px;background:rgba(255,255,255,.02);font-size:11px;color:#4a4a6a;line-height:1.7">
  <strong style="color:var(--m)">Źródła:</strong> OpenAI Q1 2026 (GPT-5.2 $1.75/$14/MTok) · Groq Llama 3.3 70B $0.59/$0.79/MTok · fal.ai Kling 2.5 $0.07/s, Wan 2.5 $0.05/s · Together FLUX.1-Free $0.00 · Twilio Voice $0.013/min · Genspark Pro $20/mies
</div>
</div>

<script>
const V={
  A:{label:"Genspark 1:1",sub:"Oficjalni dostawcy",c:"var(--a)",stack:{llm:{n:"GPT-5.2",pi:1.75,po:14},lf:{n:"GPT-5 mini",pi:.25,po:2},img:{n:"GPT-image-1",p:.04},vid:{n:"Kling 2.5",p:.07},voice:{n:"OpenAI Realtime",p:.06},phone:{n:"Twilio",p:.013},srch:{n:"Tavily",p:.005},infra:{n:"Genspark Pro",p:20}}},
  B:{label:"Best-of-Breed",sub:"Rekomendowane alternatywy",c:"var(--b)",stack:{llm:{n:"Groq 70B",pi:.59,po:.79},lf:{n:"Groq 8B",pi:.05,po:.08},img:{n:"FLUX.1-Free",p:0},vid:{n:"Wan 2.5",p:.05},voice:{n:"Groq Whisper",p:0},phone:{n:"Twilio",p:.013},srch:{n:"Tavily",p:.001},infra:{n:"CF+Supabase",p:0}}},
  C:{label:"ofshore Mesh",sub:"57 Workers mesh",c:"var(--c)",stack:{llm:{n:"Groq 70B",pi:.59,po:.79},lf:{n:"Groq 8B free",pi:0,po:0},img:{n:"FLUX.1-Free",p:0},vid:{n:"Wan 2.5",p:.05},voice:{n:"Groq Whisper",p:0},phone:{n:"Twilio",p:.013},srch:{n:"mcp-gateway",p:0},infra:{n:"DigitalOcean+CF",p:12}}}
};
const T={
  light:{chat:50,slides:5,sheets:3,spark:2,srch:20,img:2,vid:0,calls:0},
  medium:{chat:200,slides:20,sheets:10,spark:10,srch:80,img:10,vid:2,calls:5},
  heavy:{chat:1000,slides:100,sheets:50,spark:50,srch:300,img:50,vid:10,calls:20}
};
const FEATS=[
  {l:"LLM Quality",A:96,B:82,C:82,n:"GPT-5.2 vs Llama 3.3 70B"},
  {l:"Speed / Latency",A:72,B:95,C:97,n:"Groq 276T/s vs OpenAI 50T/s"},
  {l:"Image Quality",A:95,B:70,C:70,n:"GPT-image-1 vs FLUX.1-schnell"},
  {l:"Video Quality",A:90,B:85,C:85,n:"Kling 2.5 vs Wan 2.5"},
  {l:"Phone Calls",A:94,B:30,C:20,n:"Twilio+OpenAI Realtime vs brak"},
  {l:"Search Quality",A:88,B:80,C:65,n:"Tavily vs mcp-gateway"},
  {l:"Reliability SLA",A:99,B:96,C:93,n:"Genspark SLA vs własny stack"},
  {l:"Privacy",A:40,B:72,C:95,n:"OpenAI retention vs własne serwery"},
  {l:"Cost Efficiency",A:15,B:85,C:98,n:"GPT-5.2 vs Groq free tier"},
  {l:"Customizability",A:5,B:70,C:100,n:"SaaS lock-in vs własny stack"},
  {l:"Autonomia / Mesh",A:10,B:60,C:100,n:"0 vs 57+ Workers + brain-router"},
];
let tier='light';

function cost(v,t){
  const s=V[v].stack,tk=T[t];
  const fi=s.lf.pi||0,fo=s.lf.po||0,mi=s.llm.pi||0,mo=s.llm.po||0;
  const br={
    "LLM Chat":   +(tk.chat  *(.0005*fi+.0005*fo)).toFixed(3),
    "LLM Slides": +(tk.slides*(.0005*mi+.002*mo)).toFixed(3),
    "LLM Sheets": +(tk.sheets*(.0003*mi+.0015*mo)).toFixed(3),
    "SparkPage":  +(tk.spark *(.0004*mi+.003*mo)).toFixed(3),
    "Search":     +(tk.srch  *(s.srch.p||0)).toFixed(3),
    "Images":     +(tk.img   *(s.img.p||0)).toFixed(3),
    "Video":      +(tk.vid   *5*(s.vid.p||0)).toFixed(3),
    "Calls":      +(tk.calls *3*((s.voice.p||0)+(s.phone.p||0))).toFixed(3),
    "Infra/Sub":  +(s.infra.p||0).toFixed(2)
  };
  const total=+Object.values(br).reduce((a,b)=>a+b,0).toFixed(2);
  return{br,total};
}

function fmt(n){return n<0.005?"FREE":"$"+n.toFixed(2)}
function fmtS(n){return n===0?"FREE":"$"+n.toFixed(3)}
function pct(v,max){return max>0?Math.min(v/max*100,100):0}
function bar(val,max,col,h=5){
  return \`<div class="bar" style="height:\${h}px"><div class="barfill" style="width:\${pct(val,max)}%;background:\${col}"></div></div>\`;
}
function scoreBar(val,col){
  return \`<div style="display:flex;align-items:center;gap:6px"><div class="bar" style="flex:1;height:5px"><div class="barfill" style="width:\${val}%;background:\${col}"></div></div><span style="font-size:11px;font-weight:700;color:\${col};min-width:24px">\${val}</span></div>\`;
}

function render(){
  const costs={A:cost('A',tier),B:cost('B',tier),C:cost('C',tier)};
  const maxC=Math.max(costs.A.total,costs.B.total,costs.C.total,.01);
  const gPro=tier==='light'?15:tier==='medium'?20:100;
  const savBA=((costs.A.total-costs.B.total)/Math.max(costs.A.total,.01)*100).toFixed(0);
  const savCA=((costs.A.total-costs.C.total)/Math.max(costs.A.total,.01)*100).toFixed(0);

  // Cards
  document.getElementById('cards').innerHTML=Object.entries(V).map(([k,p])=>{
    const c=costs[k];
    const isLow=c.total<=Math.min(costs.A.total,costs.B.total,costs.C.total)+.01;
    return \`<div style="background:rgba(255,255,255,.03);border:1px solid \${p.c}44;border-radius:12px;padding:16px;position:relative;box-shadow:\${isLow?\`0 0 20px \${p.c}22\`:''}\">
      \${isLow?\`<div style="position:absolute;top:8px;right:10px;font-size:9px;color:\${p.c};font-weight:700;letter-spacing:1px">NAJTAŃSZY ★</div>\`:''}
      <div style="font-size:9px;color:\${p.c};letter-spacing:2px;font-weight:700;margin-bottom:4px">WARIANT \${k}</div>
      <div style="font-size:14px;font-weight:800;color:#fff;margin-bottom:2px">\${p.label}</div>
      <div style="font-size:10px;color:var(--m);margin-bottom:12px">\${p.sub}</div>
      <div style="font-size:clamp(20px,4vw,28px);font-weight:900;color:\${p.c}">\${fmt(c.total)}</div>
      <div style="font-size:10px;color:var(--m);margin-bottom:10px">/miesiąc</div>
      \${bar(c.total,maxC,p.c)}
    </div>\`;
  }).join('');

  // Savings
  document.getElementById('savings').innerHTML=\`
    <div style="background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);border-radius:10px;padding:12px 16px">
      <div style="font-size:9px;color:var(--b);letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Best-of-Breed vs 1:1</div>
      <div style="font-size:24px;font-weight:900;color:var(--b)">-\${savBA}%</div>
      <div style="font-size:11px;color:var(--m)">oszczędność · \${fmt(costs.A.total-costs.B.total)}/mies</div>
    </div>
    <div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:10px;padding:12px 16px">
      <div style="font-size:9px;color:var(--c);letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Mesh ofshore vs 1:1</div>
      <div style="font-size:24px;font-weight:900;color:var(--c)">-\${savCA}%</div>
      <div style="font-size:11px;color:var(--m)">oszczędność · \${fmt(costs.A.total-costs.C.total)}/mies</div>
    </div>
  \`;

  // COSTS tab
  const cats=Object.keys(costs.A.br);
  document.getElementById('tab-costs').innerHTML=cats.map(cat=>{
    const vals={A:costs.A.br[cat],B:costs.B.br[cat],C:costs.C.br[cat]};
    const maxV=Math.max(...Object.values(vals),.001);
    return \`<div class="cost-row">
      <span style="font-size:11px;color:var(--m)">\${cat}</span>
      \${['A','B','C'].map(v=>\`<div>
        <div style="display:flex;align-items:center;gap:6px">
          \${bar(vals[v],maxV,V[v].c)}
          <span style="font-size:11px;font-weight:700;min-width:46px;text-align:right;color:\${vals[v]===0?'#4a4a6a':V[v].c}">\${fmtS(vals[v])}</span>
        </div>
      </div>\`).join('')}
    </div>\`;
  }).join('')+\`
    <div style="display:grid;grid-template-columns:130px 1fr 1fr 1fr;gap:8px;margin-top:12px;padding:14px;background:rgba(255,255,255,.02);border-radius:10px;border:1px solid var(--d)">
      <span style="font-size:11px;color:var(--m);font-weight:700">TOTAL /mies</span>
      \${['A','B','C'].map(v=>\`<div style="text-align:center">
        <div style="font-size:9px;color:\${V[v].c};letter-spacing:2px;margin-bottom:4px">WARIANT \${v}</div>
        <div style="font-size:clamp(18px,3vw,26px);font-weight:900;color:\${V[v].c}">\${fmt(costs[v].total)}</div>
      </div>\`).join('')}
    </div>
  \`;

  // FEATURES tab
  const weights={llm_quality:2,speed:1.5,image_q:1,video_q:1,calls:1,search:1,reliability:1.5,privacy:1,cost_eff:2,customization:1.5,autonomy:2};
  const scores={A:0,B:0,C:0};
  let maxW=0;
  FEATS.forEach((f,i)=>{
    const w=Object.values(weights)[i]||1;
    ['A','B','C'].forEach(v=>scores[v]+=f[v]*w);
    maxW+=100*w;
  });
  ['A','B','C'].forEach(v=>scores[v]=(scores[v]/maxW*100).toFixed(0));

  document.getElementById('tab-features').innerHTML=FEATS.map(f=>\`
    <div class="feat-row">
      <div>
        <div style="font-size:12px;font-weight:600;color:#c0c0d0">\${f.l}</div>
        <div style="font-size:10px;color:#4a4a6a;margin-top:2px">\${f.n}</div>
      </div>
      \${['A','B','C'].map(v=>\`<div>
        <div style="font-size:9px;color:\${V[v].c};font-weight:700;margin-bottom:3px">V\${v}</div>
        \${scoreBar(f[v],V[v].c)}
      </div>\`).join('')}
    </div>
  \`).join('')+\`
    <div style="padding:16px;background:rgba(255,255,255,.02);border-radius:12px;border:1px solid var(--d);margin-top:16px">
      <div style="font-size:10px;color:var(--m);letter-spacing:2px;text-transform:uppercase;font-weight:700;margin-bottom:12px">Weighted Score (z wagami)</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
        \${['A','B','C'].map(v=>\`<div style="text-align:center">
          <div style="font-size:9px;color:\${V[v].c};letter-spacing:2px;margin-bottom:6px">\${v}</div>
          <div style="font-size:36px;font-weight:900;color:\${V[v].c}">\${scores[v]}</div>
          <div style="font-size:10px;color:#4a4a6a">/100 · \${V[v].label}</div>
        </div>\`).join('')}
      </div>
    </div>
  \`;

  // STACK tab
  const stackKeys=[
    {k:'llm',l:'🧠 LLM (główny)'},
    {k:'lf',l:'⚡ LLM (szybki)'},
    {k:'img',l:'🎨 Image Gen'},
    {k:'vid',l:'🎬 Video Gen'},
    {k:'voice',l:'🎤 Voice/STT'},
    {k:'phone',l:'📞 Telephony'},
    {k:'srch',l:'🔍 Search'},
    {k:'infra',l:'🏗️ Infra/Sub'},
  ];
  document.getElementById('tab-stack').innerHTML=stackKeys.map(row=>\`
    <div class="stack-row">
      <div class="stack-cell" style="font-size:11px;color:#c0c0d0;font-weight:600">\${row.l}</div>
      \${['A','B','C'].map(v=>{
        const s=V[v].stack[row.k];
        if(!s)return\`<div class="stack-cell"></div>\`;
        const pr=s.p!=null?fmtS(s.p):s.pi!=null?\`\$\${s.pi}/\$\${s.po}/MTok\`:'—';
        return\`<div class="stack-cell">
          <div style="font-size:9px;color:\${V[v].c};font-weight:700;margin-bottom:3px">WARIANT \${v}</div>
          <div style="font-size:11px;color:#c0c0d0;margin-bottom:4px">\${s.n}</div>
          <div style="font-size:12px;font-weight:700;color:\${s.p===0||(s.pi===0&&s.po===0)?'#10b981':V[v].c}">\${pr}</div>
        </div>\`;
      }).join('')}
    </div>
  \`).join('');

  // MARKET tab
  const gPro2=tier==='light'?15:tier==='medium'?20:100;
  document.getElementById('tab-market').innerHTML=\`
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">
      \${['A','B','C'].map(v=>{
        const c=costs[v];
        const save=gPro2-c.total;
        return\`<div style="background:rgba(255,255,255,.03);border:1px solid \${V[v].c}44;border-radius:12px;padding:16px">
          <div style="font-size:9px;color:\${V[v].c};letter-spacing:2px;font-weight:700;margin-bottom:8px">\${v}</div>
          <div style="font-size:14px;font-weight:800;margin-bottom:14px">\${V[v].label}</div>
          <div style="margin-bottom:10px">
            <div style="font-size:10px;color:var(--m);margin-bottom:3px">Twój koszt /mies</div>
            <div style="font-size:24px;font-weight:900;color:\${V[v].c}">\${fmt(c.total)}</div>
          </div>
          <div style="margin-bottom:10px">
            <div style="font-size:10px;color:var(--m);margin-bottom:3px">Genspark Pro ekwiwalent</div>
            <div style="font-size:18px;font-weight:700;color:var(--m)">\$\${gPro2}</div>
          </div>
          <div style="padding:10px;background:rgba(0,0,0,.25);border-radius:8px">
            <div style="font-size:10px;color:var(--m);margin-bottom:3px">\${save>=0?'💰 Oszczędność':'💸 Nadpłata'}</div>
            <div style="font-size:20px;font-weight:900;color:\${save>=0?'#10b981':'#ef4444'}">\${save>=0?'+':''}\${fmt(Math.abs(save))}</div>
            <div style="font-size:10px;color:#4a4a6a;margin-top:4px">ROI: \${(gPro2/Math.max(c.total,.01)).toFixed(1)}× vs Genspark Pro</div>
          </div>
        </div>\`;
      }).join('')}
    </div>
    <div style="padding:16px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.2);border-radius:12px">
      <div style="font-size:13px;font-weight:700;margin-bottom:10px;color:#a5b4fc">📋 Verdict · Tier: \${tier.charAt(0).toUpperCase()+tier.slice(1)}</div>
      <div style="font-size:12px;line-height:1.8;color:#9090a0">
        <span style="color:var(--a);font-weight:700">Wariant A:</span> Najwyższa jakość LLM+Image (GPT-5.2). Przy \${tier} tier koszt \${fmt(costs.A.total)}/mies. Wybierz gdy klient wymaga "brand OpenAI".<br>
        <span style="color:var(--b);font-weight:700">Wariant B:</span> Groq 276 T/s vs OpenAI 50 T/s. FLUX free. -\${savBA}% vs A. Optymalny dla większości produktów.<br>
        <span style="color:var(--c);font-weight:700">Wariant C:</span> Twój mesh. 57 Workers, brain-router, sentinel, fnn-orchestrator. Jedyna opcja z pełną autonomią i zero vendor lock-in. Infra \${fmt(V.C.stack.infra.p)}/mies stały koszt.
      </div>
    </div>
  \`;
}

function setTier(t,btn){
  tier=t;
  document.querySelectorAll('.tier-btn').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  render();
}

function showTab(id,btn){
  ['costs','features','stack','market'].forEach(t=>{
    document.getElementById('tab-'+t).style.display=t===id?'block':'none';
  });
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
}

render();
</script>
</body>
</html>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ok:true,service:"genspark-benchmark",version:"2.0"});
    }
    return new Response(HTML, {
      headers: {"Content-Type":"text/html; charset=utf-8","Cache-Control":"public,max-age=300"}
    });
  }
};
