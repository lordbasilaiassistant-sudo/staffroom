/* The floor — a read-only wall view of everyone working at once. Served at GET /office.
 * The shell is public; the page asks for a token once, keeps it in localStorage, and every data
 * call it makes is bearer-gated. Lighter than /app: no chat, just roster + screen + feed.
 * One file, no dependencies. Polls /employees, /activity/<name>, /screen/<name>. */
export const OFFICE_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Staffroom — the floor</title>
<style>
:root{--bg:#0b0e14;--panel:#11151f;--panel2:#161b28;--line:#232a3a;--txt:#e6ebf4;--dim:#8b94a7;
--acc:#5eead4;--acc2:#818cf8;--warn:#fbbf24;--glow:0 0 24px rgba(94,234,212,.15)}
*{box-sizing:border-box;margin:0}
body{background:radial-gradient(1200px 600px at 70% -10%,#131a2b 0%,var(--bg) 55%);color:var(--txt);
font:15px/1.5 ui-sans-serif,system-ui,'Segoe UI',sans-serif;min-height:100vh}
header{display:flex;align-items:center;gap:14px;padding:18px 26px;border-bottom:1px solid var(--line)}
header .dot{width:10px;height:10px;border-radius:50%;background:var(--acc);box-shadow:var(--glow);animation:pulse 2.4s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
header h1{font-size:17px;font-weight:650;letter-spacing:.02em}
header .sub{color:var(--dim);font-size:13px}
main{display:grid;grid-template-columns:280px 1fr;gap:0;min-height:calc(100vh - 62px)}
#roster{border-right:1px solid var(--line);padding:16px;overflow-y:auto}
#roster h2{font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--dim);margin:6px 6px 12px}
.emp{display:flex;gap:12px;align-items:center;padding:11px 12px;border-radius:12px;cursor:pointer;
border:1px solid transparent;transition:.15s}
.emp:hover{background:var(--panel)}
.emp.sel{background:var(--panel2);border-color:var(--line);box-shadow:var(--glow)}
.emp .avatar{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;font-weight:700;
font-size:15px;color:#0b0e14;flex:none}
.emp .meta{min-width:0}
.emp .name{font-weight:600;text-transform:capitalize}
.emp .when{font-size:12px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#stage{padding:22px 26px;overflow-y:auto}
#stage .placeholder{color:var(--dim);display:grid;place-items:center;height:60vh;text-align:center}
.screenwrap{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:14px;margin-bottom:18px}
.screenwrap .bar{display:flex;gap:6px;margin-bottom:10px}
.screenwrap .bar i{width:10px;height:10px;border-radius:50%;background:var(--line)}
.screenwrap .bar i:first-child{background:#f87171}.screenwrap .bar i:nth-child(2){background:var(--warn)}
.screenwrap .bar i:nth-child(3){background:#34d399}
.screenwrap img{width:100%;border-radius:8px;display:block;background:#000}
.screenwrap .noscreen{color:var(--dim);padding:48px 0;text-align:center;font-size:14px}
.feed h3{font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--dim);margin:0 0 12px}
.ev{display:grid;grid-template-columns:16px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
.ev .tick{width:8px;height:8px;border-radius:50%;background:var(--acc2);margin-top:7px}
.ev .action{font-weight:600}
.ev .detail{color:var(--dim);font-size:13.5px;white-space:pre-wrap;word-break:break-word}
.ev .t{color:var(--dim);font-size:12px;margin-top:2px}
#gate{display:grid;place-items:center;height:70vh}
#gate .card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:32px;max-width:380px;box-shadow:var(--glow)}
#gate input{width:100%;margin:14px 0;padding:11px 13px;border-radius:10px;border:1px solid var(--line);
background:var(--bg);color:var(--txt);font:inherit}
#gate button{width:100%;padding:11px;border-radius:10px;border:0;background:linear-gradient(135deg,var(--acc),var(--acc2));
color:#0b0e14;font-weight:700;cursor:pointer}
.live{color:var(--acc);font-size:12px;letter-spacing:.08em}
</style></head><body>
<header><span class="dot"></span><h1>The floor</h1><span class="sub">watch your AI staff work</span></header>
<div id="app"></div>
<script>
const P=['#5eead4','#818cf8','#fbbf24','#f472b6','#34d399','#f87171','#38bdf8','#c084fc'];
const col=n=>P[[...n].reduce((a,c)=>a+c.charCodeAt(0),0)%P.length];
const tok=()=>localStorage.getItem('office_token');
const app=document.getElementById('app');
let sel=null,timer=null;
function gate(){app.innerHTML='<div id="gate"><div class="card"><b>Staffroom key</b><div style="color:var(--dim);font-size:13px;margin-top:6px">Paste your machine token (COMPUTER_TOKEN) or a session token. Stored only in this browser.</div><input id="tk" type="password" placeholder="token"><button onclick="localStorage.setItem(\\'office_token\\',document.getElementById(\\'tk\\').value.trim());boot()">Enter</button></div></div>';}
async function api(p){const r=await fetch(p,{headers:{authorization:'Bearer '+tok()}});if(r.status===401){gate();throw 0}return r;}
function ago(t){const s=(Date.now()-new Date(t))/1e3;if(s<90)return Math.round(s)+'s ago';if(s<5400)return Math.round(s/60)+'m ago';if(s<172800)return Math.round(s/3600)+'h ago';return Math.round(s/86400)+'d ago';}
async function boot(){if(!tok())return gate();
app.innerHTML='<main><nav id="roster"><h2>Staff</h2><div id="list"></div></nav><section id="stage"><div class="placeholder">Pick a staffer to open their screen.<br><br>They post what they are doing as they work;<br>browser-driving staffers attach live screenshots.</div></section></main>';
await roster();}
async function roster(){try{const d=await(await api('/employees')).json();
const list=document.getElementById('list');if(!list)return;
list.innerHTML=d.employees.sort((a,b)=>new Date(b.lastActive)-new Date(a.lastActive)).map(e=>
'<div class="emp'+(sel===e.name?' sel':'')+'" onclick="pick(\\''+e.name+'\\')"><div class="avatar" style="background:'+col(e.name)+'">'+e.name[0].toUpperCase()+'</div><div class="meta"><div class="name">'+e.name+'</div><div class="when">active '+ago(e.lastActive)+'</div></div></div>').join('')||'<div style="color:var(--dim);padding:8px">No one has clocked in yet.</div>';}catch(e){}}
async function pick(n){sel=n;clearInterval(timer);await render();timer=setInterval(render,5000);roster();}
async function render(){if(!sel)return;const st=document.getElementById('stage');if(!st)return;
let ev=[];try{ev=(await(await api('/activity/'+sel)).json()).events||[]}catch(e){}
const shot=await fetch('/screen/'+sel,{headers:{authorization:'Bearer '+tok()}});
const screen=shot.ok?'<img src="data:image/png;base64,'+btoa(String.fromCharCode(...new Uint8Array(await shot.arrayBuffer())))+'">':'<div class="noscreen">No screen frames yet — this staffer works headless. The action feed below is their monitor.</div>';
st.innerHTML='<div class="screenwrap"><div class="bar"><i></i><i></i><i></i><span style="margin-left:auto" class="live">● LIVE · '+sel.toUpperCase()+"'S SCREEN</span></div>"+screen+'</div><div class="feed"><h3>What they are doing</h3>'+(ev.map(e=>'<div class="ev"><div class="tick"></div><div><div class="action">'+esc(e.action)+'</div>'+(e.detail?'<div class="detail">'+esc(e.detail)+'</div>':'')+'<div class="t">'+new Date(e.t).toLocaleString()+'</div></div></div>').join('')||'<div style="color:var(--dim)">No events yet.</div>')+'</div>';}
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
window.pick=pick;window.boot=boot;boot();
</script></body></html>`;
