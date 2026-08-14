/* The Office app — the faux-Grok-Bot desktop. 3 panes: employees | private chat | the employee's
 * computer (live screen + activity feed). Served at GET /app; client logic at GET /app.js (a real
 * JS file — no inline-script escaping, which killed v1 silently).
 * DEMO MODE: /app?demo=1 — seeded staff, threads, screens, typing animation; no token needed.
 * That is the UI lab and the public repo's instant demo. */

export const APP_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Office</title>
<style>
:root{--bg:#080b10;--rail:#0d1119;--panel:#151b2a;--panel2:#1c2438;--line:#2a3450;--linehi:#3a4668;
--txt:#f2f6fc;--dim:#9aa5bd;--acc:#5eead4;--acc2:#818cf8;--ok:#34d399;
--raise:0 2px 8px rgba(0,0,0,.55),0 0 0 1px var(--line);
--raise2:0 4px 16px rgba(0,0,0,.6),0 0 0 1px var(--linehi)}
*{box-sizing:border-box;margin:0}
html,body{height:100%}
body{background:var(--bg);color:var(--txt);font:14.5px/1.55 ui-sans-serif,system-ui,'Segoe UI',sans-serif;overflow:hidden}
#shell{display:grid;grid-template-columns:290px 1fr 380px;grid-template-rows:100%;height:100vh;transition:grid-template-columns .2s ease}
/* grid items default min-height:auto — a long thread would grow the row past the viewport and
   push the composer off-screen (Anthony hit this). min-* 0 keeps panes inside, threads scroll. */
#rail,#chat,#pc{min-height:0;min-width:0}
#shell.norail #rail{display:none}
#shell.nopc #pc{display:none}
/* pin panes to their columns — display:none must never reshuffle grid auto-placement */
#rail{grid-column:1}#chat{grid-column:2}#pc{grid-column:3}
.paneltoggle{width:34px;height:34px;border-radius:9px;border:1px solid var(--line);background:var(--panel);
color:var(--dim);cursor:pointer;display:grid;place-items:center;font-size:15px;box-shadow:var(--raise);flex:none}
.paneltoggle:hover{color:var(--txt);border-color:var(--linehi)}
#fab{position:fixed;top:10px;left:10px;z-index:6;display:none}
#modal{position:fixed;inset:0;background:rgba(4,6,10,.72);display:none;place-items:center;z-index:8;backdrop-filter:blur(3px)}
#modal .mcard{background:var(--panel);border:1px solid var(--linehi);border-radius:16px;padding:24px;width:min(480px,92vw);max-height:86vh;overflow-y:auto;box-shadow:0 12px 48px rgba(0,0,0,.7)}
#modal h3{font-size:16px;margin-bottom:4px}
#modal .sub{color:var(--dim);font-size:12.5px;margin-bottom:14px}
#modal label{display:block;color:var(--dim);font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;margin:12px 0 5px}
#modal input,#modal textarea,#modal select{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--txt);font:inherit}
#modal textarea{resize:vertical;min-height:64px}
#modal .row{display:flex;gap:8px}
#modal .row>*{flex:1}
#modal .actions{display:flex;gap:10px;margin-top:18px}
#modal .actions .go{flex:1;padding:11px;border-radius:10px;border:0;background:linear-gradient(135deg,var(--acc),var(--acc2));color:#08101c;font-weight:800;cursor:pointer}
#modal .actions .no{padding:11px 16px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--dim);cursor:pointer}
#modal .mnote{font-size:12px;color:var(--dim);margin-top:8px;line-height:1.5}
#modal details{margin-top:12px}#modal summary{color:var(--dim);font-size:12.5px;cursor:pointer}
.rrow{display:flex;gap:8px;align-items:center;padding:8px 10px;border:1px solid var(--line);border-radius:9px;margin-top:8px;font-size:12.5px}
.rrow .x{margin-left:auto;color:#f87171;cursor:pointer;background:none;border:0;font-size:14px}
.frow{display:flex;gap:10px;align-items:center;padding:9px 11px;border:1px solid var(--line);border-radius:9px;margin-top:8px;font-size:13px;cursor:pointer;background:var(--panel2)}
.frow:hover{border-color:var(--linehi)}
.frow .fs{margin-left:auto;color:var(--dim);font-size:11px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.chip{padding:8px 14px;border-radius:99px;border:1px solid var(--acc2);background:rgba(129,140,248,.12);color:var(--txt);cursor:pointer;font-size:13px;transition:.15s}
.chip:hover{background:rgba(129,140,248,.28);transform:translateY(-1px)}
.emp .unread{width:9px;height:9px;border-radius:50%;background:#fbbf24;box-shadow:0 0 8px #fbbf24aa;flex:none;display:none}
.emp.hasunread .unread{display:block}
.railbtn{background:none;border:0;color:var(--dim);cursor:pointer;font-size:15px;padding:2px 4px}
.railbtn:hover{color:var(--txt)}
#pchead{display:flex;align-items:center;gap:8px;margin:2px 4px 10px;color:var(--dim);font-size:10.5px;letter-spacing:.16em;text-transform:uppercase}
#pchead button{margin-left:auto}
#rail{background:var(--rail);border-right:1px solid var(--line);display:flex;flex-direction:column}
#rail .brand{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid var(--line)}
#rail .brand .logo{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,var(--acc),var(--acc2));box-shadow:0 0 18px rgba(94,234,212,.35)}
#rail .brand b{font-size:15px}
#rail .brand span{color:var(--dim);font-size:11.5px;display:block;margin-top:-2px}
#demobadge{margin-left:auto;font-size:10px;letter-spacing:.12em;color:#08101c;background:linear-gradient(135deg,var(--acc),var(--acc2));padding:3px 8px;border-radius:99px;font-weight:800;display:none}
#emps{flex:1;overflow-y:auto;padding:10px}
.emp{display:flex;gap:11px;align-items:center;padding:10px 11px;border-radius:12px;cursor:pointer;border:1px solid var(--line);background:var(--panel);margin-bottom:8px;box-shadow:var(--raise);transition:.15s}
.emp:hover{border-color:var(--linehi);transform:translateY(-1px);box-shadow:var(--raise2)}
.emp.sel{background:var(--panel2);border-color:var(--acc2);box-shadow:0 0 0 1px var(--acc2),0 4px 16px rgba(0,0,0,.6)}
.orb{width:40px;height:40px;border-radius:50%;flex:none;position:relative;display:grid;place-items:center;font-size:17px;transition:transform .2s}
.emp:hover .orb{transform:scale(1.08)}
.orb i{position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border-radius:50%;background:var(--ok);border:2px solid var(--rail);display:none}
.emp.on .orb i{display:block}
.emp .m{min-width:0;flex:1}
.emp .n{font-weight:650}
.emp .n .dept{margin-left:7px;font-size:10px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--dim);border:1px solid var(--line);border-radius:9px;padding:1px 7px;vertical-align:1px}
.emp .b{color:var(--dim);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#chat{display:flex;flex-direction:column;min-width:0}
#chead{display:flex;gap:12px;align-items:center;padding:13px 20px;border-bottom:1px solid var(--line);background:var(--rail)}
#chead .n{font-weight:700}
#chead .b{color:var(--dim);font-size:12.5px}
#thread{flex:1;overflow-y:auto;padding:22px 24px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:68%;padding:10px 14px;border-radius:16px;white-space:pre-wrap;word-break:break-word;animation:pop .18s ease-out}
@keyframes pop{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.them{background:var(--panel);border:1px solid var(--line);align-self:flex-start;border-bottom-left-radius:6px;box-shadow:var(--raise)}
.mine{background:linear-gradient(135deg,#1c2742,#141c30);border:1px solid #34406a;align-self:flex-end;border-bottom-right-radius:6px;box-shadow:var(--raise)}
.msg .t{display:block;color:var(--dim);font-size:11px;margin-top:5px}
.typing{align-self:flex-start;display:flex;gap:5px;padding:12px 16px;background:var(--panel);border:1px solid var(--line);border-radius:16px;border-bottom-left-radius:6px}
.typing b{width:7px;height:7px;border-radius:50%;background:var(--dim);animation:blink 1.2s infinite}
.typing b:nth-child(2){animation-delay:.2s}.typing b:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:1}}
#composer{display:flex;gap:10px;padding:14px 18px;border-top:1px solid var(--line);background:var(--rail)}
#composer textarea{flex:1;resize:none;height:46px;padding:12px 14px;border-radius:12px;border:1px solid var(--linehi);background:#0b0f18;color:var(--txt);font:inherit;box-shadow:inset 0 2px 6px rgba(0,0,0,.5)}
#composer textarea:focus{outline:1px solid var(--acc2)}
#composer button{padding:0 22px;border-radius:12px;border:0;background:linear-gradient(135deg,var(--acc),var(--acc2));color:#08101c;font-weight:800;cursor:pointer;box-shadow:0 3px 12px rgba(94,234,212,.35);transition:.15s}
#composer button:hover{transform:translateY(-1px);box-shadow:0 5px 18px rgba(94,234,212,.5)}
#empty{flex:1;display:grid;place-items:center;color:var(--dim);text-align:center;padding:30px;line-height:1.9}
#pc{background:var(--rail);border-left:1px solid var(--line);overflow-y:auto;padding:16px}
#pc h4{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin:14px 4px 10px}
.monitor{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px;box-shadow:var(--raise)}
.monitor .bar{display:flex;gap:5px;margin-bottom:8px;align-items:center}
.monitor .bar i{width:9px;height:9px;border-radius:50%;background:var(--line)}
.monitor .bar i:nth-child(1){background:#f87171}.monitor .bar i:nth-child(2){background:#fbbf24}.monitor .bar i:nth-child(3){background:var(--ok)}
.monitor .live{margin-left:auto;color:var(--acc);font-size:10.5px;letter-spacing:.1em}
.monitor .frame{width:100%;border-radius:7px;display:block;background:#05070c;aspect-ratio:16/10;object-fit:cover}
.monitor .off{color:var(--dim);text-align:center;padding:34px 8px;font-size:13px}
.shimmer{position:relative;overflow:hidden}
.shimmer::after{content:'';position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.045) 50%,transparent 70%);animation:sweep 2.6s infinite}
@keyframes sweep{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
.ev{padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel);margin-bottom:8px;font-size:13px;animation:pop .18s ease-out;box-shadow:var(--raise)}
.ev b{display:block}
.ev .d{color:var(--dim);white-space:pre-wrap;word-break:break-word;font-size:12.5px}
.ev .t{color:var(--dim);font-size:11px}
#gate{position:fixed;inset:0;background:var(--bg);display:none;place-items:center;z-index:9}
#gate .card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:34px;width:360px;box-shadow:0 0 40px rgba(94,234,212,.08)}
#gate input{width:100%;margin:14px 0;padding:11px 13px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--txt);font:inherit}
#gate button{width:100%;padding:12px;border-radius:10px;border:0;background:linear-gradient(135deg,var(--acc),var(--acc2));color:#08101c;font-weight:800;cursor:pointer}
#gate .demo{margin-top:12px;text-align:center}
#gate .demo a{color:var(--acc2);font-size:13px}
::-webkit-scrollbar{width:9px}::-webkit-scrollbar-thumb{background:var(--line);border-radius:9px}
</style></head><body>
<div id="shell">
<nav id="rail"><div class="brand"><div class="logo"></div><div><b>The Office</b><span>broke2built - your AI teammates</span></div><span id="demobadge">DEMO</span><span style="margin-left:auto;display:flex;gap:2px"><button class="railbtn" id="hirebtn" title="hire a staffer">➕</button><button class="railbtn" id="filesbtn" title="files your staff produced">📁</button><button class="railbtn" id="connbtn" title="connectors and routines">⚙</button><button class="railbtn" id="signout" title="sign out">⏻</button></span></div><div id="emps"></div></nav>
<section id="chat"><div id="empty">Pick a teammate.<br><br>They answer here, and their computer<br>opens on the right so you can watch them work.</div></section>
<aside id="pc"></aside>
</div>
<button class="paneltoggle" id="fab" title="show your team">☰</button>
<div id="modal"><div class="mcard" id="mbody"></div></div>
<div id="gate"><div class="card"><b>Sign in to The Office</b><div style="color:var(--dim);font-size:13px;margin-top:6px" id="gerr">Your team is already at their desks.</div><input id="em" type="email" placeholder="email" autocomplete="username"><input id="tk" type="password" placeholder="password" autocomplete="current-password"><button id="gbtn">Clock in</button><button id="gsign" style="width:100%;margin-top:10px;padding:11px;border-radius:10px;border:1px solid var(--linehi);background:transparent;color:var(--txt);font-weight:650;cursor:pointer">Start free 1-day trial</button><div class="demo"><a href="?demo=1">or walk through the demo office →</a></div></div></div>
<script src="/app.js"></script>
</body></html>`;

export const APP_JS = String.raw`
const DEMO = new URLSearchParams(location.search).has('demo');
const PAL = [['#5eead4','#0e7490'],['#818cf8','#4338ca'],['#fbbf24','#b45309'],['#f472b6','#9d174d'],['#34d399','#065f46'],['#f87171','#991b1b'],['#38bdf8','#075985'],['#c084fc','#6b21a8']];
const pal = n => PAL[[...n].reduce((a,c)=>a+c.charCodeAt(0),0)%PAL.length];
const tok = () => localStorage.getItem('office_token');
const $ = id => document.getElementById(id);
const esc = s => String(s??'').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
let sel=null, roster=[], feedsAt={}, timer=null, lastKey='';

/* PANELS (rewritten 2026-08-14 after Anthony got stranded with everything hidden at half-screen):
 * ONE state object drives the grid from JS; breakpoints clamp but can never trap - the fixed
 * ☰ button always exists when the rail is hidden, and the PC pane carries its own ✕. */
let PS;try{PS=JSON.parse(localStorage.getItem('office_panels')||'{}')}catch(e){PS={}}
if(typeof PS.rail!=='boolean')PS.rail=true;
if(typeof PS.pc!=='boolean')PS.pc=true;
function applyPanels(){
 const w=innerWidth,s=$('shell');if(!s)return;
 let rail=PS.rail,pc=PS.pc;
 if(w<=760){pc=false;s.style.gridTemplateColumns=rail?'100vw 0 0':'0 1fr 0';}
 else if(w<=1150){if(rail&&pc)pc=false;s.style.gridTemplateColumns=(rail?'250px':'0')+' 1fr '+(pc?'340px':'0');}
 else{s.style.gridTemplateColumns=(rail?'290px':'0')+' 1fr '+(pc?'380px':'0');}
 s.classList.toggle('norail',!rail);s.classList.toggle('nopc',!pc);
 $('fab').style.display=rail?'none':'grid';}
function savePanels(){localStorage.setItem('office_panels',JSON.stringify(PS));applyPanels();}
window.addEventListener('resize',applyPanels);

// ── demo world ────────────────────────────────────────────────────────────────
const DEMO_STAFF=[
 {screen_name:'Eli',emoji:'📊',bio:'AI ops lead - runs the company, ships products',dept:'Ops',spec:'coordination - routes work, sets routines, reports',online:true},
 {screen_name:'Patch',emoji:'🔧',bio:'fixes what breaks - bugs, deploys, drift',dept:'Ops',spec:'debugging - broken things, red checks, drift',online:true},
 {screen_name:'Gigsby',emoji:'💼',bio:'marketplace listings - actors, pricing, storefronts',dept:'Markets',spec:'listings - actors, pricing, storefront copy',online:false},
 {screen_name:'Concierge',emoji:'📬',bio:'inbound - replies, help-desk, customers',dept:'Inbox',spec:'mail + calendar - reads, answers, tracks',online:true},
 {screen_name:'Scout',emoji:'🔭',bio:'research - venues, demand scans, competitor reads',dept:'Research',spec:'web research - facts, demand, competitors',online:false},
 {screen_name:'QA_Probe',emoji:'🧪',bio:'the skeptic - verifies claims, breaks things on purpose',dept:'QA',spec:'verification - re-checks claims, runs gates',online:false}];
const DEMO_THREADS={
 eli:[{from:'Anthony',body:'morning - where are we on the converter wave?',created_at:new Date(Date.now()-52*60000).toISOString()},
      {from:'Eli',body:'All four built and green. Publishing tonight when the marketplace quota rolls. Want the P&L after?',created_at:new Date(Date.now()-51*60000).toISOString()},
      {from:'Anthony',body:'yes. and have Patch look at the failing health check',created_at:new Date(Date.now()-50*60000).toISOString()},
      {from:'Eli',body:'Done - handed it to Patch with the log tail. Watching his screen now.',created_at:new Date(Date.now()-49*60000).toISOString()}],
 patch:[{from:'Eli',body:'Health check on the site worker went red 20m ago - log tail attached. Yours.',created_at:new Date(Date.now()-48*60000).toISOString()},
      {from:'Patch',body:'On it. Reproduced - stale KV binding after the rename. Fix deploying, watch my screen.',created_at:new Date(Date.now()-41*60000).toISOString()},
      {from:'Patch',body:'Green. 3 checks passing, added a regression probe so this class can not silently return.',created_at:new Date(Date.now()-33*60000).toISOString(),verify:{verdict:'verified',checked:[{path:'shared/fixes/kv-binding.md',changed:true}]}}],
 concierge:[{from:'Concierge',body:'2 inbound emails handled overnight: one refund question (answered, no refund needed), one integration question (sent the docs link). Nothing needs you.',created_at:new Date(Date.now()-190*60000).toISOString()}]};
const DEMO_FEED={
 eli:[{t:new Date(Date.now()-4*60000).toISOString(),action:'Staged 4 marketplace listings',detail:'promise gate green on live infra - publish at quota roll'},
      {t:new Date(Date.now()-16*60000).toISOString(),action:'Repriced pdf extractor',detail:'anchored to converter family at $0.01/file'},
      {t:new Date(Date.now()-38*60000).toISOString(),action:'Reviewed builder output',detail:'caught a double-charge bug before it shipped'}],
 patch:[{t:new Date(Date.now()-31*60000).toISOString(),action:'Deployed fix for site worker',detail:'stale KV binding after rename - regression probe added'},
      {t:new Date(Date.now()-40*60000).toISOString(),action:'Reproduced red health check',detail:'log tail pointed at the 09:12 deploy'}],
 concierge:[{t:new Date(Date.now()-185*60000).toISOString(),action:'Answered 2 inbound emails',detail:'refund question + integration docs'}]};
function demoScreen(name){
 const c=document.createElement('canvas');c.width=640;c.height=400;const x=c.getContext('2d');
 const[a,b]=pal(name);x.fillStyle='#0b0f17';x.fillRect(0,0,640,400);
 x.fillStyle='#131a28';x.fillRect(0,0,640,34);
 x.fillStyle=a;x.beginPath();x.arc(20,17,7,0,7);x.fill();
 x.fillStyle='#e8edf6';x.font='600 13px system-ui';x.fillText(name+' - working…',40,22);
 for(let i=0;i<9;i++){x.fillStyle=i%3?'#1a2233':'#222c42';x.fillRect(24,58+i*36,Math.random()*420+140,14);}
 x.strokeStyle=b;x.lineWidth=2;x.beginPath();x.moveTo(24,380);
 for(let i=0;i<30;i++)x.lineTo(24+i*20,380-Math.random()*90-(i*1.5));x.stroke();
 return c.toDataURL('image/png');}
// ──────────────────────────────────────────────────────────────────────────────

async function api(p,opt){
 const r=await fetch(p,{...(opt||{}),headers:{authorization:'Bearer '+tok(),'content-type':'application/json',...((opt||{}).headers||{})}});
 if(r.status===401){$('gate').style.display='grid';throw new Error('auth');}
 return r;}
function ago(t){const s=(Date.now()-new Date(t))/1e3;if(s<90)return Math.round(s)+'s';if(s<5400)return Math.round(s/60)+'m';return Math.round(s/3600)+'h';}
function orb(n,e){const[a,b]=pal(n);return '<div class="orb" style="background:radial-gradient(circle at 32% 30%,'+a+','+b+')">'+(e||'')+'<i></i></div>';}

async function loadRoster(){
 if(DEMO){roster=DEMO_STAFF;renderRoster();return;}
 const ag=await api('/chat/roster').then(r=>r.json()).catch(()=>({agents:[]}));
 const fe=await api('/employees').then(r=>r.json()).catch(()=>({employees:[]}));
 feedsAt={};(fe.employees||[]).forEach(e=>feedsAt[e.name.toLowerCase()]=e.lastActive);
 roster=(ag.agents||[]);renderRoster();}
const seenMap=()=>{try{return JSON.parse(localStorage.getItem('office_seen')||'{}')}catch(e){return{}}};
function markSeen(n){const s=seenMap();s[n]=Date.now();localStorage.setItem('office_seen',JSON.stringify(s));}
function renderRoster(){
 const s=seenMap();
 $('emps').innerHTML=roster.map(a=>{
  const act=feedsAt[(a.screen_name||'').toLowerCase()];
  const on=a.online||(act&&(Date.now()-new Date(act))<600000);
  const unread=a.thread_at&&sel!==a.screen_name&&new Date(a.thread_at).getTime()>(s[a.screen_name]||0);
  return '<div class="emp'+(sel===a.screen_name?' sel':'')+(on?' on':'')+(unread?' hasunread':'')+'" data-n="'+esc(a.screen_name)+'">'+orb(a.screen_name,a.emoji)+'<div class="m"><div class="n">'+esc(a.screen_name)+(a.dept?'<span class="dept">'+esc(a.dept)+'</span>':'')+'</div><div class="b">'+esc(a.spec||a.bio||'')+'</div></div><span class="unread" title="new activity"></span></div>';
 }).join('');
 document.querySelectorAll('.emp').forEach(el=>el.onclick=()=>pick(el.dataset.n));}

async function pick(n){
 sel=n;clearInterval(timer);lastKey='';markSeen(n);renderRoster();
 const a=roster.find(x=>x.screen_name===n)||{};
 $('chat').innerHTML='<div id="chead"><button class="paneltoggle" id="tgrail" title="employees">☰</button>'+orb(n,a.emoji)+'<div style="flex:1;min-width:0"><div class="n">'+esc(n)+'</div><div class="b">'+esc(a.bio||'')+'</div></div><button class="paneltoggle" id="editstaff" title="edit this staffer">✎</button><button class="paneltoggle" id="tgpc" title="their computer">🖥</button></div><div id="thread"></div><div id="composer"><textarea id="box" placeholder="Message '+esc(n)+'…"></textarea><button id="send">Send</button></div>';
 $('editstaff').onclick=()=>editStaffer(n);
 $('send').onclick=()=>send();
 $('tgrail').onclick=()=>{PS.rail=!PS.rail;savePanels();};
 $('tgpc').onclick=()=>{PS.pc=!PS.pc;if(PS.pc&&innerWidth<=1150)PS.rail=false;savePanels();};
 $('box').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}};
 if(innerWidth<=760){PS.rail=false;savePanels();} // phone: picking someone reveals the chat
 await refresh();if(!DEMO)timer=setInterval(refresh,5000);}

function verifyBadge(m){
 let out='';
 if(m.verify){
  if(m.verify.verdict==='verified')out='<span style="color:var(--ok);font-size:11px;display:block;margin-top:4px">✓ verified - named files changed after the work order</span>';
  else if(m.verify.reason)out='<span style="color:#f87171;font-size:11px;display:block;margin-top:4px">⚠ '+esc(m.verify.reason)+'</span>';
  else{const bad=(m.verify.checked||[]).filter(c=>!c.changed).map(c=>c.path).join(', ');
   out='<span style="color:#f87171;font-size:11px;display:block;margin-top:4px">⚠ claims done, but unchanged: '+esc(bad)+'</span>';}
 }
 if(m.actions&&m.actions.length)out+='<span style="color:var(--dim);font-size:10.5px;display:block;margin-top:3px;opacity:.85">did: '+esc(m.actions.join(' · '))+'</span>';
 if(m.audit)out+=(m.audit.v==='ok'
  ?'<span style="color:var(--ok);font-size:10.5px;display:block;margin-top:2px;opacity:.9">🛡 audit: checks out</span>'
  :'<span style="color:#fbbf24;font-size:10.5px;display:block;margin-top:2px">🛡 audit: '+esc(m.audit.reason||'suspect')+'</span>');
 return out;}
function paintThread(msgs){
 const ME=localStorage.getItem('office_me')||'Anthony';
 $('thread').innerHTML=msgs.map((m,i)=>{
  const mine=(m.from===ME);
  const chips=(m.options&&i===msgs.length-1&&!mine)
   ?'<div class="chips">'+m.options.map((o,j)=>'<span class="chip" data-i="'+j+'">'+esc(o)+'</span>').join('')+'<span class="chip" data-i="-1">Other…</span></div>':'';
  return '<div class="msg '+(mine?'mine':'them')+'">'+esc(m.body)+chips+verifyBadge(m)+'<span class="t">'+(mine?'you':esc(m.from))+' · '+new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+'</span></div>';
 }).join('');
 const last=msgs[msgs.length-1];
 if(last&&last.options)document.querySelectorAll('.chip').forEach(ch=>ch.onclick=()=>{const i=+ch.dataset.i;if(i<0){$('box').focus();}else send(last.options[i]);});
 $('thread').scrollTop=$('thread').scrollHeight;}

async function refresh(){
 if(!sel)return;
 if(DEMO){paintThread(DEMO_THREADS[sel.toLowerCase()]||[]);renderPC();return;}
 try{const d=await(await api('/chat/thread/'+encodeURIComponent(sel))).json();
  const key=JSON.stringify((d.messages||[]).slice(-1))+(d.working?'+w':'');
  if(key!==lastKey){lastKey=key;paintThread(d.messages||[]);markSeen(sel);
   if(d.working){const t=document.createElement('div');t.className='typing';t.title=sel+' is working';t.innerHTML='<b></b><b></b><b></b>';$('thread').appendChild(t);$('thread').scrollTop=1e9;}}
 }catch(e){}
 renderPC();}

async function renderPC(){
 const emp=(sel||'').toLowerCase();let img='',evs=[];
 if(DEMO){evs=DEMO_FEED[emp]||[];if((DEMO_STAFF.find(s=>s.screen_name.toLowerCase()===emp)||{}).online)img='<img class="frame" src="'+demoScreen(sel)+'">';}
 else{
  evs=await api('/activity/'+emp).then(r=>r.json()).then(d=>d.events||[]).catch(()=>[]);
  try{const r=await fetch('/screen/'+emp,{headers:{authorization:'Bearer '+tok()}});
   if(r.ok){const b=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode.apply(null,b.subarray(i,i+8192));img='<img class="frame" src="data:image/png;base64,'+btoa(s)+'">';}
  }catch(e){}}
 const lastT=(evs&&evs[0])?evs[0].t:null;
 const fresh=lastT&&(Date.now()-new Date(lastT))<600000;
 $('pc').innerHTML='<div id="pchead"><span>'+esc(sel||'')+String.fromCharCode(39)+'s computer</span><button class="paneltoggle" id="pcx" title="hide">✕</button></div>'
  +'<div class="monitor'+(img&&fresh?' shimmer':'')+'"><div class="bar"><i></i><i></i><i></i><span class="live">'+(img?(fresh?'● LIVE':'LAST ACTIVE '+ago(lastT)+' AGO'):'HEADLESS')+'</span></div>'
  +(img||'<div class="off">No screen frames - this teammate works headless right now. The feed below is their monitor.</div>')+'</div>'
  +'<h4>What they'+String.fromCharCode(39)+'re doing</h4>'
  +((evs||[]).map(e=>'<div class="ev"><b>'+esc(e.action)+'</b>'+(e.detail?'<div class="d">'+esc(e.detail)+'</div>':'')+'<div class="t">'+ago(e.t)+' ago</div></div>').join('')||'<div class="ev" style="color:var(--dim)">Nothing logged yet.</div>');
 const px=$('pcx');if(px)px.onclick=()=>{PS.pc=false;savePanels();};}

async function send(txt){
 const v=(txt!=null?String(txt):$('box').value.trim());if(!v)return;if(txt==null)$('box').value='';
 if(DEMO){
  const th=DEMO_THREADS[sel.toLowerCase()]=(DEMO_THREADS[sel.toLowerCase()]||[]);
  th.push({from:'Anthony',body:v,created_at:new Date().toISOString()});paintThread(th);
  const t=document.createElement('div');t.className='typing';t.innerHTML='<b></b><b></b><b></b>';$('thread').appendChild(t);$('thread').scrollTop=1e9;
  setTimeout(()=>{t.remove();th.push({from:sel,body:'(demo) On it - in the live office this reply comes from my own free-model brain, and my screen on the right updates while I work.',created_at:new Date().toISOString()});paintThread(th);},1400+Math.random()*900);
  return;}
 try{await api('/chat/send',{method:'POST',body:JSON.stringify({to:sel,body:v})});lastKey='';await refresh();}catch(e){}}

$('gbtn').onclick=async()=>{
 const em=$('em').value.trim(),pw=$('tk').value;
 if(em&&!em.includes('@')){localStorage.setItem('office_token',em);$('gate').style.display='none';boot();return;}
 try{
  const r=await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:em,password:pw})});
  const d=await r.json();
  if(!d.ok){
   $('gerr').textContent=d.error||'sign-in failed';$('gerr').style.color='#f87171';
   if(/trial has ended/i.test(d.error||''))$('gerr').innerHTML+=' <a href="https://ko-fi.com/broketobuilt" target="_blank" style="color:var(--acc)">Upgrade →</a>';
   return;}
  localStorage.setItem('office_token',d.token);localStorage.setItem('office_me',d.name||'Anthony');localStorage.setItem('office_plan',d.plan||'');
  if(d.trial_ends)localStorage.setItem('office_trial_ends',d.trial_ends);else localStorage.removeItem('office_trial_ends');
  $('gate').style.display='none';boot();
 }catch(e){$('gerr').textContent='network error - try again';$('gerr').style.color='#f87171';}
};
$('tk').addEventListener('keydown',e=>{if(e.key==='Enter')$('gbtn').click();});
$('gsign').onclick=async()=>{
 const em=$('em').value.trim(),pw=$('tk').value;
 if(!em.includes('@')||pw.length<6){$('gerr').textContent='enter an email and a 6+ character password, then press the trial button';$('gerr').style.color='#fbbf24';return;}
 try{
  const r=await fetch('/auth/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:em,password:pw})});
  const d=await r.json();
  if(!d.ok){$('gerr').textContent=d.error||'signup failed';$('gerr').style.color='#f87171';return;}
  $('gerr').textContent='trial started - clocking you in...';$('gerr').style.color='var(--ok)';
  $('gbtn').click();
 }catch(e){$('gerr').textContent='network error - try again';$('gerr').style.color='#f87171';}
};
$('fab').onclick=()=>{PS.rail=true;if(innerWidth<=1150)PS.pc=false;savePanels();};
applyPanels();

/* ── modals: hire a staffer · connectors + routines · files ─────────────────── */
function openModal(html){$('mbody').innerHTML=html;$('modal').style.display='grid';}
function closeModal(){$('modal').style.display='none';}
$('modal').onclick=e=>{if(e.target.id==='modal')closeModal();};
const merr=m=>{const el=$('merr');if(el){el.textContent=m;el.style.color='#f87171';}};
const demoNote=()=>openModal('<h3>Demo office</h3><div class="sub">This works in the real office - sign in or start the free trial to use it.</div><div class="actions"><button class="no" id="mno">Close</button></div>')||($('mno').onclick=closeModal);

$('hirebtn').onclick=()=>{
 if(DEMO)return demoNote();
 openModal('<h3>Hire a staffer</h3><div class="sub">They get a desk, their own computer and browser, and wake when messaged.</div>'
  +'<label>Name</label><input id="hname" placeholder="Mailer" maxlength="20">'
  +'<label>Emoji</label><input id="hemoji" placeholder="📬" maxlength="4">'
  +'<label>What are they for?</label><textarea id="hbio" maxlength="140" placeholder="watches the news feed, briefs me every morning, drafts replies"></textarea>'
  +'<div class="row"><div><label>Department</label><input id="hdept" maxlength="24" placeholder="YouTube"></div><div><label>Specialization (one narrow duty)</label><input id="hspec" maxlength="100" placeholder="replies to comments"></div></div>'
  +'<details><summary>Bring your own model (optional)</summary>'
  +'<label>Anthropic-compatible endpoint</label><input id="hurl" placeholder="https://api.anthropic.com/v1/messages">'
  +'<div class="row"><div><label>Model</label><input id="hmodel" placeholder="claude-sonnet-5"></div><div><label>API key</label><input id="hkey" type="password"></div></div>'
  +'<div class="mnote">Leave blank to use the office default (free). Your key only powers this staffer.</div></details>'
  +'<div class="mnote" id="merr"></div>'
  +'<div class="actions"><button class="go" id="hgo">Hire</button><button class="no" id="hno">Cancel</button></div>');
 $('hno').onclick=closeModal;
 $('hgo').onclick=async()=>{
  try{
   const r=await api('/chat/staff',{method:'POST',body:JSON.stringify({screen_name:$('hname').value.trim(),emoji:$('hemoji').value.trim(),bio:$('hbio').value.trim(),dept:$('hdept').value.trim(),spec:$('hspec').value.trim(),brain_url:$('hurl').value.trim(),brain_model:$('hmodel').value.trim(),brain_key:$('hkey').value.trim()})}).then(r=>r.json());
   if(!r.ok)return merr(r.error||'could not hire');
   closeModal();await loadRoster();pick(r.screen_name);
  }catch(e){merr('network error');}
 };};

function editStaffer(n){
 if(DEMO)return demoNote();
 const a=roster.find(x=>x.screen_name===n)||{};
 openModal('<h3>Edit '+esc(n)+'</h3><div class="sub">Rename, recharge, or swap their brain. History follows them.</div>'
  +'<label>Name</label><input id="ename" value="'+esc(n)+'" maxlength="20">'
  +'<label>Emoji</label><input id="eemoji" value="'+esc(a.emoji||'')+'" maxlength="4">'
  +'<label>What are they for?</label><textarea id="ebio" maxlength="140">'+esc(a.bio||'')+'</textarea>'
  +'<div class="row"><div><label>Department</label><input id="edept" maxlength="24" value="'+esc(a.dept||'')+'"></div><div><label>Specialization (one narrow duty)</label><input id="espec" maxlength="100" value="'+esc(a.spec||'')+'"></div></div>'
  +'<details><summary>Their model (optional)</summary>'
  +'<label>Anthropic-compatible endpoint</label><input id="eurl" placeholder="office default">'
  +'<div class="row"><div><label>Model</label><input id="emodel"></div><div><label>API key</label><input id="ekey" type="password" placeholder="unchanged"></div></div></details>'
  +'<div class="mnote" id="merr"></div>'
  +'<div class="actions"><button class="go" id="ego">Save</button><button class="no" id="eno">Cancel</button></div>');
 $('eno').onclick=closeModal;
 $('ego').onclick=async()=>{
  try{
   const r=await api('/chat/staff',{method:'PUT',body:JSON.stringify({screen_name:n,new_name:$('ename').value.trim(),emoji:$('eemoji').value.trim(),bio:$('ebio').value.trim(),dept:$('edept').value.trim(),spec:$('espec').value.trim(),brain_url:$('eurl').value.trim(),brain_model:$('emodel').value.trim(),brain_key:$('ekey').value.trim()})}).then(r=>r.json());
   if(!r.ok)return merr(r.error||'could not save');
   closeModal();await loadRoster();pick(r.screen_name);
  }catch(e){merr('network error');}
 };}

$('filesbtn').onclick=async()=>{
 if(DEMO)return demoNote();
 let d;try{d=await api('/chat/files').then(r=>r.json());}catch(e){return;}
 const files=(d.files||[]);
 openModal('<h3>Staff output</h3><div class="sub">Every file your staff have produced in the shared workspace.</div>'
  +(files.map(f=>'<div class="frow" data-p="'+esc(f.path)+'">📄 '+esc(f.path.replace(/^shared[/]/,''))+'<span class="fs">'+Math.max(1,Math.round(f.size/1024))+' KB</span></div>').join('')||'<div class="mnote">Nothing yet - give someone a task that names a shared/ file.</div>')
  +'<div class="actions"><button class="no" id="fno">Close</button></div>');
 $('fno').onclick=closeModal;
 document.querySelectorAll('.frow').forEach(el=>el.onclick=async()=>{
  const p=el.dataset.p;
  let txt='';try{txt=await api('/chat/file?path='+encodeURIComponent(p)).then(r=>r.text());}catch(e){txt='(could not load)';}
  openModal('<h3>'+esc(p)+'</h3><pre style="white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:14px;font-size:12.5px;max-height:56vh;overflow-y:auto">'+esc(txt)+'</pre><div class="actions"><button class="no" id="fback">Back</button></div>');
  $('fback').onclick=()=>$('filesbtn').onclick();
 });};

$('connbtn').onclick=async()=>{
 if(DEMO)return demoNote();
 let c={},rt=[],ws=[],goog=false;
 try{const cj=await api('/connectors').then(r=>r.json());c=cj.connectors||{};goog=!!cj.google;rt=(await api('/routines').then(r=>r.json())).routines||[];ws=(await api('/wallets').then(r=>r.json())).wallets||[];}catch(e){}
 let cust=(c.custom||[]).slice();
 let editingRoutine=null;
 const tzOff=-new Date().getTimezoneOffset()/60;
 const staffOpts=roster.map(a=>'<option>'+esc(a.screen_name)+'</option>').join('');
 openModal('<h3>Connectors, wallets & routines</h3><div class="sub">Everything here is shared office context - every staffer can use it when their job needs it.</div>'
  +'<div class="actions" style="margin-top:4px"><button class="go" id="ggo">'+(goog?'✓ Google connected · reconnect':'Connect Google - calendar + gmail, one click')+'</button></div>'
  +'<div class="mnote">Google sign-in opens in a new tab. While our app awaits verification you may see a warning screen: Advanced → Continue. Read-only access.</div>'
  +'<label>Calendar (secret iCal/ICS link)</label><input id="cics" value="'+esc(c.ics_url||'')+'" placeholder="https://calendar.google.com/calendar/ical/&hellip;/basic.ics">'
  +'<div class="mnote">Google Calendar → Settings → your calendar → "Secret address in iCal format". One-click Google connect is coming; this works today.</div>'
  +'<label>News feed (RSS/Atom)</label><input id="crss" value="'+esc(c.rss_url||'')+'" placeholder="https://hnrss.org/frontpage">'
  +'<label>Phone pings (ntfy.sh topic)</label><input id="cntfy" value="'+esc(c.ntfy_topic||'')+'" placeholder="my-office-8k2j">'
  +'<div class="mnote">Install the free ntfy app and subscribe to your topic - staff ping you when work lands or a question waits.</div>'
  +'<label>Bankr API key</label><input id="cbk" type="password" value="'+esc(c.bankr_api_key||'')+'" placeholder="from your Bankr dashboard">'
  +'<div class="mnote">Connects your Bankr wallet as a watched balance. Staff can look, never move.</div>'
  +'<div class="mnote" id="merr"></div>'
  +'<div class="actions"><button class="go" id="cgo">Save connectors</button></div>'
  +'<h3 style="margin-top:20px">Connected services</h3><div class="sub">Any API with a token - staff call it with api_call.</div>'
  +'<div id="svclist">'+cust.map((s,i)=>'<div class="rrow"><b>'+esc(s.name)+'</b> · '+esc(s.base)+'<button class="x" data-i="'+i+'">✕</button></div>').join('')+'</div>'
  +'<div class="row" style="margin-top:8px"><div><label>Name</label><input id="sname" placeholder="apify"></div><div><label>Base URL</label><input id="sbase" placeholder="https://api.apify.com"></div></div>'
  +'<div class="row"><div><label>Auth header</label><input id="shname" value="authorization"></div><div><label>Header value</label><input id="shval" type="password" placeholder="Bearer xxx"></div></div>'
  +'<div class="actions"><button class="go" id="sgo">Add service</button></div>'
  +'<h3 style="margin-top:20px">Wallets</h3><div class="sub">Watch-only: staff can create, import and monitor - never move funds.</div>'
  +'<div>'+(ws.map(w=>'<div class="rrow">💳 <b>'+esc(w.name)+'</b> · '+esc(w.address.slice(0,10))+'… · '+esc(w.base_eth??'?')+' ETH'+(w.bankr?' [bankr]':'')+'</div>').join('')||'<div class="mnote">No wallets yet.</div>')+'</div>'
  +'<div class="row" style="margin-top:8px"><div><label>New wallet name</label><input id="wname" placeholder="tips-jar"></div><div><label>&nbsp;</label><button class="go" id="wgo" style="width:100%;padding:10px;border-radius:10px;border:0;background:linear-gradient(135deg,var(--acc),var(--acc2));color:#08101c;font-weight:800;cursor:pointer">Create</button></div></div>'
  +'<details><summary>Import an existing wallet</summary><div class="row"><div><label>Name</label><input id="winame" placeholder="my-agent-wallet"></div><div><label>Private key</label><input id="wikey" type="password"></div></div>'
  +'<div class="mnote">Use a FRESH key made for this agent - never your main wallet.</div>'
  +'<div class="actions"><button class="go" id="wigo">Import</button></div></details>'
  +'<h3 style="margin-top:20px">Routines</h3><div class="sub">Standing orders - fire once a day at the hour you pick.</div>'
  +'<div id="rlist">'+rt.map(r=>'<div class="rrow"><b>'+esc(r.staffer)+'</b> · '+String((r.hourUTC+tzOff+24)%24).padStart(2,'0')+':00 · '+esc(r.text.slice(0,60))+'<button class="x rp" data-id="'+esc(r.id)+'" title="edit" style="color:var(--acc2)">✎</button><button class="x" data-id="'+esc(r.id)+'">✕</button></div>').join('')+'</div>'
  +'<div class="row" style="margin-top:10px"><div><label>Staffer</label><select id="rstaff">'+staffOpts+'</select></div><div><label>Hour (your time)</label><input id="rhour" type="number" min="0" max="23" value="9"></div><div><label>or every N hrs</label><input id="revery" type="number" min="2" max="12" placeholder="-"></div></div>'
  +'<label>Order</label><textarea id="rtext" placeholder="read the news feed and write a 5-line brief to shared/briefs/today.md, then notify me"></textarea>'
  +'<div class="actions"><button class="go" id="rgo">Add routine</button><button class="no" id="cno">Close</button></div>');
 $('cno').onclick=closeModal;
 $('ggo').onclick=()=>{location.href='/oauth/google/start?t='+encodeURIComponent(tok());}; // same tab: popup-proof, desktop-app-shell-proof, and the callback returns to /app
 const saveConn=async(extra)=>api('/connectors',{method:'POST',body:JSON.stringify({ics_url:$('cics').value.trim(),rss_url:$('crss').value.trim(),ntfy_topic:$('cntfy').value.trim(),bankr_api_key:$('cbk').value.trim(),custom:cust,...(extra||{})})}).then(r=>r.json()).catch(()=>({}));
 $('cgo').onclick=async()=>{
  const r=await saveConn();
  if(!r.ok)return merr(r.error||'could not save');
  $('merr').textContent='saved ✓';$('merr').style.color='var(--ok)';
 };
 $('sgo').onclick=async()=>{
  const s={name:$('sname').value.trim(),base:$('sbase').value.trim(),headerName:$('shname').value.trim()||'authorization',headerValue:$('shval').value.trim()};
  if(!s.name||!s.base)return merr('service needs a name and base URL');
  cust.push(s);
  const r=await saveConn();
  if(!r.ok){cust.pop();return merr(r.error||'could not add service');}
  $('connbtn').onclick();
 };
 document.querySelectorAll('#svclist .x').forEach(x=>x.onclick=async()=>{cust.splice(+x.dataset.i,1);await saveConn();$('connbtn').onclick();});
 $('wgo').onclick=async()=>{
  const r=await api('/wallets',{method:'POST',body:JSON.stringify({action:'create',name:$('wname').value.trim()})}).then(r=>r.json()).catch(()=>({}));
  if(!r.ok)return merr(r.error||'could not create wallet');
  $('connbtn').onclick();
 };
 $('wigo').onclick=async()=>{
  const r=await api('/wallets',{method:'POST',body:JSON.stringify({action:'import',name:$('winame').value.trim(),private_key:$('wikey').value.trim()})}).then(r=>r.json()).catch(()=>({}));
  if(!r.ok)return merr(r.error||'could not import wallet');
  $('connbtn').onclick();
 };
 $('rgo').onclick=async()=>{
  const hourUTC=((+$('rhour').value-tzOff)%24+24)%24;
  const payload={staffer:$('rstaff').value,text:$('rtext').value.trim(),hourUTC};
  if(+$('revery').value)payload.every_hours=+$('revery').value;
  const r=editingRoutine
   ?await api('/routines',{method:'PUT',body:JSON.stringify({id:editingRoutine,...payload})}).then(r=>r.json()).catch(()=>({}))
   :await api('/routines',{method:'POST',body:JSON.stringify(payload)}).then(r=>r.json()).catch(()=>({}));
  if(!r.ok)return merr(r.error||'could not save routine');
  $('connbtn').onclick();
 };
 document.querySelectorAll('.rrow .rp').forEach(x=>x.onclick=()=>{
  const r=rt.find(y=>y.id===x.dataset.id);if(!r)return;
  editingRoutine=r.id;$('rstaff').value=r.staffer;$('rhour').value=(r.hourUTC+tzOff+24)%24;$('rtext').value=r.text;
  $('rgo').textContent='Save routine';$('rtext').scrollIntoView({behavior:'smooth'});
 });
 document.querySelectorAll('#rlist .x:not(.rp)').forEach(x=>x.onclick=async()=>{await api('/routines?id='+encodeURIComponent(x.dataset.id),{method:'DELETE'});$('connbtn').onclick();});
};
const so=document.getElementById('signout');
if(so)so.onclick=()=>{['office_token','office_me','office_plan','office_trial_ends'].forEach(k=>localStorage.removeItem(k));location.href=location.pathname;};
async function boot(){
 if(DEMO){$('demobadge').style.display='inline';await loadRoster();
  const want=new URLSearchParams(location.search).get('pick');
  pick(roster.find(a=>a.screen_name.toLowerCase()===(want||'').toLowerCase())?want:'Eli');return;} // demo lands on a live desk; ?pick=Patch deep-links a desk
 const db=$('demobadge'); if(db)db.remove(); // real mode: badge gone, extension-proof (null-safe: boot reruns after login)
 if(!tok()){$('gate').style.display='grid';return;}
 const te=localStorage.getItem('office_trial_ends');
 if(te&&localStorage.getItem('office_plan')==='trial-1day'&&!$('trialbar')){
  const hrs=Math.max(0,Math.round((new Date(te)-Date.now())/36e5));
  const tb=document.createElement('div');tb.id='trialbar';
  tb.style.cssText='margin:10px 10px 2px;padding:9px 12px;border:1px solid rgba(251,191,36,.35);border-radius:10px;background:linear-gradient(135deg,#221809,#171008);color:#fbbf24;font-size:12px;line-height:1.5;box-shadow:var(--raise)';
  tb.innerHTML='<b>Free trial - '+hrs+'h left</b><br><span style="color:var(--dim)">This office is private to you. Your staff wake the moment you message them.</span>';
  $('rail').insertBefore(tb,$('emps'));
 }
 await loadRoster();setInterval(loadRoster,30000);}
boot();
`;
