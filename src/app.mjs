/* Staffroom app — the desk view. Three panes: staff | private chat | that staffer's computer
 * (live screen + activity feed). Served at GET /app; client logic at GET /app.js as a real JS
 * file rather than an inline <script> — inline scripts inside a template literal need double
 * escaping, which broke the page silently the first time round.
 * DEMO MODE: /app?demo=1 — seeded staff, threads, screens and typing animation, no account
 * needed. It is both the UI lab and the instant demo for anyone who just cloned the repo. */

export const APP_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Staffroom</title>
<style>
:root{--bg:#080b10;--rail:#0d1119;--panel:#151b2a;--panel2:#1c2438;--line:#2a3450;--linehi:#3a4668;
--txt:#f2f6fc;--dim:#9aa5bd;--acc:#5eead4;--acc2:#818cf8;--ok:#34d399;
--raise:0 2px 8px rgba(0,0,0,.55),0 0 0 1px var(--line);
--raise2:0 4px 16px rgba(0,0,0,.6),0 0 0 1px var(--linehi)}
*{box-sizing:border-box;margin:0}
html,body{height:100%}
body{background:var(--bg);color:var(--txt);font:14.5px/1.55 ui-sans-serif,system-ui,'Segoe UI',sans-serif;overflow:hidden}
#shell{display:grid;grid-template-columns:290px 1fr 380px;height:100vh;transition:grid-template-columns .2s ease}
#shell.norail{grid-template-columns:0 1fr 380px}
#shell.nopc{grid-template-columns:290px 1fr 0}
#shell.norail.nopc{grid-template-columns:0 1fr 0}
#shell.norail #rail,#shell.nopc #pc{display:none}
.paneltoggle{width:34px;height:34px;border-radius:9px;border:1px solid var(--line);background:var(--panel);
color:var(--dim);cursor:pointer;display:grid;place-items:center;font-size:15px;box-shadow:var(--raise);flex:none}
.paneltoggle:hover{color:var(--txt);border-color:var(--linehi)}
@media (max-width:1150px){#shell{grid-template-columns:290px 1fr 0}#shell #pc{display:none}
#shell.showpc{grid-template-columns:0 1fr 380px}#shell.showpc #rail{display:none}#shell.showpc #pc{display:block}}
@media (max-width:760px){#shell{grid-template-columns:0 1fr 0}#shell #rail{display:none}
#shell.showrail{grid-template-columns:100vw 0 0}#shell.showrail #rail{display:flex}}
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
<nav id="rail"><div class="brand"><div class="logo"></div><div><b>Staffroom</b><span>your AI staff, always on</span></div><span id="demobadge">DEMO</span></div><div id="emps"></div></nav>
<section id="chat"><div id="empty">Pick a staffer.<br><br>They answer here, and their computer<br>opens on the right so you can watch them work.</div></section>
<aside id="pc"></aside>
</div>
<div id="gate"><div class="card"><b>Sign in to the staffroom</b><div style="color:var(--dim);font-size:13px;margin-top:6px" id="gerr">Your team is already at their desks.</div><input id="em" type="email" placeholder="email" autocomplete="username"><input id="tk" type="password" placeholder="password" autocomplete="current-password"><button id="gbtn">Clock in</button><div class="demo"><a href="?demo=1">or walk through the demo staffroom &rarr;</a></div></div></div>
<script src="/app.js"></script>
</body></html>`;

export const APP_JS = String.raw`
const DEMO = new URLSearchParams(location.search).has('demo');
const PAL = [['#5eead4','#0e7490'],['#818cf8','#4338ca'],['#fbbf24','#b45309'],['#f472b6','#9d174d'],['#34d399','#065f46'],['#f87171','#991b1b'],['#38bdf8','#075985'],['#c084fc','#6b21a8']];
const pal = n => PAL[[...n].reduce((a,c)=>a+c.charCodeAt(0),0)%PAL.length];
const tok = () => localStorage.getItem('office_token');
// Who "you" are in the thread. Set from the login response; the server decides the real name
// from the session, so this is only used to align your own bubbles to the right.
const me = () => localStorage.getItem('office_name') || 'You';
const $ = id => document.getElementById(id);
const esc = s => String(s??'').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
let sel=null, roster=[], feedsAt={}, timer=null, lastKey='';

// ── demo world ────────────────────────────────────────────────────────────────
const DEMO_STAFF=[
 {screen_name:'Ada',emoji:'📊',bio:'ops lead - plans the work, splits it up, reports back',online:true},
 {screen_name:'Patch',emoji:'🔧',bio:'fixes what breaks - bugs, deploys, drift',online:true},
 {screen_name:'Quill',emoji:'✍️',bio:'writes - docs, release notes, replies that go out',online:true},
 {screen_name:'Scout',emoji:'🔭',bio:'research - sources, comparisons, competitor reads',online:false},
 {screen_name:'Probe',emoji:'🧪',bio:'the skeptic - verifies claims, breaks things on purpose',online:false}];
const DEMO_THREADS={
 ada:[{from:'You',body:'morning - where are we on the import job?',created_at:new Date(Date.now()-52*60000).toISOString()},
      {from:'Ada',body:'Parser is done and the fixtures pass. Patch is on the failing health check; I will have the summary in shared/reports/ tonight.',created_at:new Date(Date.now()-51*60000).toISOString()},
      {from:'You',body:'good. keep the retry budget small, it hammered the API last time',created_at:new Date(Date.now()-50*60000).toISOString()},
      {from:'Ada',body:'Capped at 3 with backoff. Watching Patch now.',created_at:new Date(Date.now()-49*60000).toISOString()}],
 patch:[{from:'Ada',body:'Health check on the API worker went red 20m ago - log tail is in shared/logs/health.txt. Yours.',created_at:new Date(Date.now()-48*60000).toISOString()},
      {from:'Patch',body:'On it. Reproduced - stale KV binding after the rename. Fix deploying, watch my screen.',created_at:new Date(Date.now()-41*60000).toISOString()},
      {from:'Patch',body:'Green. 3 checks passing, and I added a regression probe so this class can not silently return.',created_at:new Date(Date.now()-33*60000).toISOString()}],
 quill:[{from:'Quill',body:'Release notes for 0.4 drafted in shared/docs/release-0.4.md - two breaking changes called out at the top. Want a shorter version for the changelog?',created_at:new Date(Date.now()-190*60000).toISOString()}]};
const DEMO_FEED={
 ada:[{t:new Date(Date.now()-4*60000).toISOString(),action:'Split the import job into 4 tasks',detail:'parser, fixtures, retry budget, summary - two are already claimed'},
      {t:new Date(Date.now()-16*60000).toISOString(),action:'Capped the retry budget at 3',detail:'exponential backoff; the old code retried until the API throttled us'},
      {t:new Date(Date.now()-38*60000).toISOString(),action:'Reviewed the parser diff',detail:'caught an off-by-one on the header row before it shipped'}],
 patch:[{t:new Date(Date.now()-31*60000).toISOString(),action:'Deployed fix for the API worker',detail:'stale KV binding after rename - regression probe added'},
      {t:new Date(Date.now()-40*60000).toISOString(),action:'Reproduced the red health check',detail:'log tail pointed at the 09:12 deploy'}],
 quill:[{t:new Date(Date.now()-185*60000).toISOString(),action:'Drafted release notes for 0.4',detail:'breaking changes pulled to the top'}]};
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
function renderRoster(){
 $('emps').innerHTML=roster.map(a=>{
  const act=feedsAt[(a.screen_name||'').toLowerCase()];
  const on=a.online||(act&&(Date.now()-new Date(act))<600000);
  return '<div class="emp'+(sel===a.screen_name?' sel':'')+(on?' on':'')+'" data-n="'+esc(a.screen_name)+'">'+orb(a.screen_name,a.emoji)+'<div class="m"><div class="n">'+esc(a.screen_name)+'</div><div class="b">'+esc(a.bio||'')+'</div></div></div>';
 }).join('');
 document.querySelectorAll('.emp').forEach(el=>el.onclick=()=>pick(el.dataset.n));}

async function pick(n){
 sel=n;clearInterval(timer);lastKey='';renderRoster();
 const a=roster.find(x=>x.screen_name===n)||{};
 $('chat').innerHTML='<div id="chead"><button class="paneltoggle" id="tgrail" title="staff">☰</button>'+orb(n,a.emoji)+'<div style="flex:1;min-width:0"><div class="n">'+esc(n)+'</div><div class="b">'+esc(a.bio||'')+'</div></div><button class="paneltoggle" id="tgpc" title="their computer">🖥</button></div><div id="thread"></div><div id="composer"><textarea id="box" placeholder="Message '+esc(n)+'…"></textarea><button id="send">Send</button></div>';
 $('send').onclick=send;
 $('tgrail').onclick=()=>{const s=$('shell');if(innerWidth<=760){s.classList.toggle('showrail');}else s.classList.toggle('norail');};
 $('tgpc').onclick=()=>{const s=$('shell');if(innerWidth<=1150){s.classList.toggle('showpc');}else s.classList.toggle('nopc');};
 $('box').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}};
 await refresh();if(!DEMO)timer=setInterval(refresh,5000);}

function verifyBadge(m){
 if(!m.verify)return '';
 if(m.verify.verdict==='verified')return '<span style="color:var(--ok);font-size:11px;display:block;margin-top:4px">✓ verified - named files changed after the work order</span>';
 const bad=(m.verify.checked||[]).filter(c=>!c.changed).map(c=>c.path).join(', ');
 return '<span style="color:#f87171;font-size:11px;display:block;margin-top:4px">⚠ claims done, but unchanged: '+esc(bad)+'</span>';}
function paintThread(msgs){
 const you=me();
 $('thread').innerHTML=msgs.map(m=>{
  const mine=(m.from===you);
  return '<div class="msg '+(mine?'mine':'them')+'">'+esc(m.body)+verifyBadge(m)+'<span class="t">'+(mine?'you':esc(m.from))+' · '+new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+'</span></div>';
 }).join('');
 $('thread').scrollTop=$('thread').scrollHeight;}

async function refresh(){
 if(!sel)return;
 if(DEMO){paintThread(DEMO_THREADS[sel.toLowerCase()]||[]);renderPC();return;}
 try{const d=await(await api('/chat/thread/'+encodeURIComponent(sel))).json();
  const key=JSON.stringify((d.messages||[]).slice(-1));
  if(key!==lastKey){lastKey=key;paintThread(d.messages||[]);}
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
 $('pc').innerHTML='<h4>'+esc(sel||'')+String.fromCharCode(39)+'s computer</h4>'
  +'<div class="monitor'+(img?' shimmer':'')+'"><div class="bar"><i></i><i></i><i></i><span class="live">'+(img?'● LIVE':'HEADLESS')+'</span></div>'
  +(img||'<div class="off">No screen frames - this staffer works headless right now. The feed below is their monitor.</div>')+'</div>'
  +'<h4>What they'+String.fromCharCode(39)+'re doing</h4>'
  +((evs||[]).map(e=>'<div class="ev"><b>'+esc(e.action)+'</b>'+(e.detail?'<div class="d">'+esc(e.detail)+'</div>':'')+'<div class="t">'+ago(e.t)+' ago</div></div>').join('')||'<div class="ev" style="color:var(--dim)">Nothing logged yet.</div>');}

async function send(){
 const v=$('box').value.trim();if(!v)return;$('box').value='';
 if(DEMO){
  const th=DEMO_THREADS[sel.toLowerCase()]=(DEMO_THREADS[sel.toLowerCase()]||[]);
  th.push({from:me(),body:v,created_at:new Date().toISOString()});paintThread(th);
  const t=document.createElement('div');t.className='typing';t.innerHTML='<b></b><b></b><b></b>';$('thread').appendChild(t);$('thread').scrollTop=1e9;
  setTimeout(()=>{t.remove();th.push({from:sel,body:'(demo) On it - in a live staffroom this reply comes from my own model, and my screen on the right updates while I work.',created_at:new Date().toISOString()});paintThread(th);},1400+Math.random()*900);
  return;}
 try{await api('/chat/send',{method:'POST',body:JSON.stringify({to:sel,body:v})});lastKey='';await refresh();}catch(e){}}

$('gbtn').onclick=async()=>{
 const em=$('em').value.trim(),pw=$('tk').value;
 // Escape hatch for self-hosters: paste the machine key in the email box to get straight in.
 if(em&&!em.includes('@')){localStorage.setItem('office_token',em);localStorage.setItem('office_name','You');$('gate').style.display='none';boot();return;}
 try{
  const r=await fetch('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:em,password:pw})});
  const d=await r.json();
  if(!d.ok){$('gerr').textContent=d.error||'sign-in failed';$('gerr').style.color='#f87171';return;}
  localStorage.setItem('office_token',d.token);localStorage.setItem('office_name',d.name||'You');
  $('gate').style.display='none';boot();
 }catch(e){$('gerr').textContent='network error - try again';$('gerr').style.color='#f87171';}
};
$('tk').addEventListener('keydown',e=>{if(e.key==='Enter')$('gbtn').click();});
async function boot(){
 if(DEMO){$('demobadge').style.display='inline';await loadRoster();return;}
 if(!tok()){$('gate').style.display='grid';return;}
 await loadRoster();setInterval(loadRoster,30000);}
boot();
`;
