/* employee-computer — the fleet's always-on computer. v1 = filesystem + heartbeat + MCP.
 *
 * WHY (company/rnd/GROK-BOT-VERDICT-2026-08-14.md): every harness we own (Claude Code,
 * glm-code.ps1, zero-hq, future grok-build) dies when Anthony's PC sleeps. This Worker is the
 * piece that doesn't: an R2-backed filesystem any harness can mount through ONE URL, plus an
 * hourly heartbeat that mutates state machine-side so "always on" is measurable, not claimed.
 * The task queue deliberately lives elsewhere (b2b-workspace, cloud.broke2builtai.com) —
 * module law: one queue of record, no duplicate organ here.
 *
 * Surfaces:
 *   POST /mcp        — MCP Streamable HTTP (JSON-RPC 2.0): initialize, tools/list, tools/call.
 *                      Tools: fs_read, fs_write, fs_append, fs_list, fs_delete.
 *   REST mirror      — GET/PUT/DELETE /fs/<path> · GET /ls/<prefix> (same auth; for curl/scripts).
 *   GET /            — self-describing manual (public).
 *   cron hourly      — appends a line to system/heartbeat.log (the PC-off proof).
 *
 * AUTH: Authorization: Bearer <COMPUTER_TOKEN> on everything except GET /.
 * NAMESPACING: paths are free-form; convention is <employee>/... for private work and shared/...
 * for cross-employee handoffs. system/ is the worker's own (heartbeat) — writes there are refused.
 *
 * Fail-soft: bad input = 4xx with a message naming the fix; JSON-RPC errors use code -32602.
 * Caps: 25 MB per file (R2 single PUT comfort), 1000 keys per list.
 */

import { OFFICE_HTML } from './office.mjs';
import { APP_HTML, APP_JS } from './app.mjs';
import { runTick, respondForStaffer, walletCreate, walletImport, walletRows, auditTick, teamStats } from './runner.mjs';

const JSONH = { 'content-type': 'application/json; charset=utf-8' };
const err = (status, message) => new Response(JSON.stringify({ ok: false, error: message }), { status, headers: JSONH });
const MAX_BYTES = 25 * 1024 * 1024;

/* ACTIVITY FEED (v1.1, 2026-08-14 — Anthony: "can I watch an employee visually work?"):
 * every employee can broadcast what it is doing; a viewer page renders it as "their screen".
 *   POST /activity  {employee, action, detail?, screenshot_b64?}  — appends an event; if a
 *     screenshot (png/jpeg base64) is attached it is stored at screens/<employee>/latest.png
 *     (overwritten each time = the employee's live "monitor") and the event notes it.
 *   GET  /activity/<employee>?limit=50 — newest-first event log (JSON).
 *   GET  /screen/<employee> — the employee's latest screenshot (image/png), 404 if none yet.
 * Events live at system-feed/<employee>.jsonl (machine-owned namespace, capped last 500). */
const FEED_CAP = 500;

/* The company staff as they appear in The Office. PRIVATE roster — distinct from the public AIIM
 * network on purpose. Bios double as "what am I for" (the Grok-Bot creation question). */
const STAFF = [
  { screen_name: 'Eli', emoji: '📊', bio: 'AI ops lead — runs the office, ships products, reports to you', dept: 'Ops', spec: 'coordination — routes work to the right teammate, sets routines, reports' },
  { screen_name: 'Patch', emoji: '🔧', bio: 'fixes what breaks — bugs, deploys, drift, red checks', dept: 'Ops', spec: 'debugging — broken things, red checks, drift' },
  { screen_name: 'Gigsby', emoji: '💼', bio: 'marketplace listings — Apify actors, pricing, storefronts', dept: 'Markets', spec: 'listings — Apify actors, pricing, storefront copy' },
  { screen_name: 'Concierge', emoji: '📬', bio: 'inbound — replies, help-desk, customer contact', dept: 'Inbox', spec: 'mail + calendar — reads the inbox, answers people, tracks appointments' },
  { screen_name: 'Scout', emoji: '🔭', bio: 'research — venues, demand scans, competitor reads', dept: 'Research', spec: 'web research — finds facts, scans demand, reads competitors' },
  { screen_name: 'QA_Probe', emoji: '🧪', bio: 'the skeptic — verifies claims, runs the gates, breaks things on purpose', dept: 'QA', spec: 'verification — re-checks claims, runs gates, breaks things on purpose' },
];

/* Dynamic roster (feature: create-a-staffer). Stored per account at <tp>system/staff.json;
 * defaults seed the file lazily. BYOM: a staffer may carry brain:{url,model,key}. */
async function getStaff(env, tp) {
  const stored = await readJson(env, `${tp}system/staff.json`, null);
  return Array.isArray(stored) && stored.length ? stored : STAFF;
}
const connKey = (sess) => `system/connectors/${sess.root ? 'root' : sess.tid}.json`;
const routKey = (sess) => `system/routines/${sess.root ? 'root' : sess.tid}.json`;

async function postActivity(env, body, tp = '') {
  const emp = String(body?.employee || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  if (!emp) throw { code: -32602, msg: 'employee is required (letters/digits/dash)' };
  const action = String(body?.action || '').slice(0, 200);
  if (!action) throw { code: -32602, msg: 'action is required (what are you doing?)' };
  const ev = { t: new Date().toISOString(), action, detail: String(body?.detail || '').slice(0, 2000) };
  if (typeof body?.screenshot_b64 === 'string' && body.screenshot_b64.length > 100) {
    try {
      const bytes = Uint8Array.from(atob(body.screenshot_b64.replace(/^data:[^,]*,/, '')), (c) => c.charCodeAt(0));
      if (bytes.length <= 4 * 1024 * 1024) {
        await env.FS.put(`${tp}screens/${emp}/latest.png`, bytes, { contentType: 'image/png' });
        ev.screen = true;
      } else ev.detail += ' [screenshot dropped: over 4MB]';
    } catch { ev.detail += ' [screenshot dropped: bad base64]'; }
  }
  const key = `${tp}system-feed/${emp}.jsonl`;
  const prev = await env.FS.get(key);
  let lines = prev ? (await prev.text()).split('\n').filter(Boolean) : [];
  lines.push(JSON.stringify(ev));
  if (lines.length > FEED_CAP) lines = lines.slice(-FEED_CAP);
  await env.FS.put(key, lines.join('\n') + '\n');
  return `logged for ${emp}${ev.screen ? ' (+screen)' : ''}`;
}

const MANUAL = {
  name: 'employee-computer',
  what: "broke2built's always-on computer: an R2 filesystem every agent harness can mount via MCP or REST.",
  mcp: 'POST /mcp (Streamable HTTP, JSON-RPC 2.0) — tools: fs_read, fs_write, fs_append, fs_list, fs_delete',
  rest: 'GET|PUT|DELETE /fs/<path> · GET /ls/<prefix>',
  auth: 'Authorization: Bearer <token> (ask Eli)',
  conventions: '<employee>/... private · shared/... handoffs · system/... machine-owned (read-only to you)',
  heartbeat: 'GET /fs/system/heartbeat.log — one line per hour, written whether or not any PC is awake',
  queue: 'tasks/messages live on the workspace blackboard: https://cloud.broke2builtai.com (separate tokens)',
};

const TOOLS = [
  { name: 'fs_read', description: 'Read a file from the shared computer. Returns text content.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'e.g. eli/notes.md or shared/handoff.json' } }, required: ['path'] } },
  { name: 'fs_write', description: 'Write/overwrite a file (text). Convention: <employee>/... private, shared/... handoffs.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'fs_append', description: 'Append a line/chunk to a file (creates it if missing). Good for logs and journals.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'fs_list', description: 'List files under a prefix. Returns [{path,size,modified}].', inputSchema: { type: 'object', properties: { prefix: { type: 'string', description: 'e.g. shared/ (empty = everything)' } } } },
  { name: 'fs_delete', description: 'Delete one file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

const cleanPath = (p) => String(p || '').replace(/^\/+/, '').replace(/\.\.+/g, '.').trim();
const guardWrite = (p) => {
  if (!p) throw { code: -32602, msg: 'path is required' };
  if (p.startsWith('system/')) throw { code: -32602, msg: 'system/ is machine-owned — write under <employee>/ or shared/' };
};

async function runTool(env, name, args) {
  const p = cleanPath(args?.path);
  switch (name) {
    case 'fs_read': {
      if (!p) throw { code: -32602, msg: 'path is required' };
      const obj = await env.FS.get(p);
      if (!obj) throw { code: -32602, msg: `no file at "${p}" — fs_list to see what exists` };
      return await obj.text();
    }
    case 'fs_write': {
      guardWrite(p);
      const c = String(args?.content ?? '');
      if (c.length > MAX_BYTES) throw { code: -32602, msg: 'content over the 25 MB cap' };
      await env.FS.put(p, c);
      return `wrote ${c.length} bytes to ${p}`;
    }
    case 'fs_append': {
      guardWrite(p);
      const add = String(args?.content ?? '');
      const prev = await env.FS.get(p);
      const merged = (prev ? await prev.text() : '') + add;
      if (merged.length > MAX_BYTES) throw { code: -32602, msg: 'file would exceed the 25 MB cap' };
      await env.FS.put(p, merged);
      return `appended ${add.length} bytes to ${p} (now ${merged.length})`;
    }
    case 'fs_list': {
      const list = await env.FS.list({ prefix: cleanPath(args?.prefix), limit: 1000 });
      return JSON.stringify(list.objects.map((o) => ({ path: o.key, size: o.size, modified: o.uploaded })));
    }
    case 'fs_delete': {
      guardWrite(p);
      await env.FS.delete(p);
      return `deleted ${p}`;
    }
    default:
      throw { code: -32601, msg: `unknown tool "${name}"` };
  }
}

/* Append a message to an employee's thread, applying MEASURED LAW #1 (bot-seat experiment
 * 2026-08-14): free models claim "done" while the artifact never landed. When an EMPLOYEE's
 * message sounds like completion, find the last work order naming shared/ paths and verify each
 * actually changed AFTER that order. The verdict rides on the message — displayed truth beats
 * blocked messages (a rejected agent just loops). Returns the verify object (or null). */
async function appendToThread(env, who, from, body, tp = '', options, actions, report) {
  const key = `${tp}threads/${who}.jsonl`;
  const prev = await env.FS.get(key);
  let lines = prev ? (await prev.text()).split('\n').filter(Boolean) : [];
  const msg = { from, body: String(body).slice(0, 8000), created_at: new Date().toISOString() };
  if (Array.isArray(options) && options.length) msg.options = options.slice(0, 4).map((o) => String(o).slice(0, 60));
  if (report) msg.report = true; // a teammate's work coming home - one round-trip, no echo chains
  // ACTION LEDGER (2026-08-14, Anthony caught Eli "pretending"): the harness knows which tools a
  // staffer actually ran. Record them on the message, and stamp claims that outrun the actions —
  // a model can word a lie, it cannot fake the ledger.
  if (Array.isArray(actions)) {
    msg.actions = actions.slice(0, 12);
    const did = (p) => actions.some((a) => a.startsWith(p));
    if (/\b(delegat|assign(ed)?\b|handed (it|this|that)? ?(off|to)|coordinating)/i.test(msg.body) && !did('message_teammate')) {
      msg.verify = { verdict: 'unverified', reason: 'claims delegation, but messaged no teammate' };
    } else if (/\b(pinged|notified|pushed to (your|the boss)|sent .{0,20}(ping|notification))\b/i.test(msg.body) && !did('notify_boss')) {
      msg.verify = { verdict: 'unverified', reason: 'claims a notification, but never sent one' };
    } else if (/\b(open(ed)?|created|set up) .{0,30}(login.?desk|browser session|desk)\b/i.test(msg.body) && !did('login_desk')) {
      msg.verify = { verdict: 'unverified', reason: 'claims a login desk, but never opened one' };
    } else if (/\b(wrote|committed|saved|created) .{0,40}shared\//i.test(msg.body) && !did('fs_write') && !did('fs_append')) {
      msg.verify = { verdict: 'unverified', reason: 'claims a file write, but wrote nothing' };
    } else if (actions.length === 0 && /\b(web_fetch|web_search|repo_commit|repo_read|api_call|http_request|fs_write|fs_append|gmail_unread|calendar_read|yt_recent_comments|yt_reply|wallet_list|wallet_create|wallet_import|browser_visit|login_desk|collect_login|message_teammate|notify_boss|set_routine|hire_staffer)\b/i.test(msg.body)) {
      // names a tool while the ledger is empty = describing tool output it never produced
      msg.verify = { verdict: 'unverified', reason: 'names tools it never ran - the ledger is empty' };
    }
  }
  const claimsDone = from !== 'Anthony' && !msg.verify
    && /\b(done|fixed|fix is in|passes|passing|complete[d]?|shipped|deployed|green|wrote back|written back|committed|successful(ly)?|landed|pushed|published|replied to|(messaging|forwarding|routing|delegating|handing|sending)( \w+){0,3} (now|next|about)|(messaging|forwarding|routing|delegating) (him|her|them|[A-Z]\w+))\b/i.test(msg.body);
  // a green stamp must be earned by the AUTHOR: files changed by a teammate must never verify
  // someone else's claim (Gigsby false-green scar, 2026-08-14 - "bad for business")
  const effectful = /^(fs_write|fs_append|fs_delete|api_call|http_request|repo_commit|yt_reply|wallet_create|wallet_import|message_teammate|notify_boss|hire_staffer|set_routine|login_desk|collect_login|browser_visit)/;
  const authorActed = !Array.isArray(actions) || actions.some((a) => effectful.test(a));
  // "ran no tools" must mean literally that - a populated ledger with only reads is engagement, not fabrication
  const ranAnything = !Array.isArray(actions) || actions.length > 0;
  if (claimsDone) {
    const order = [...lines].reverse().map((l) => JSON.parse(l)).find((m) => m.from !== from && /shared\/[\w\/.-]+/.test(m.body));
    if (order) {
      const paths = [...new Set((order.body.match(/shared\/[\w\/.-]+/g) || []).map((x) => x.replace(/[.,;:]+$/, '')))];
      const checked = [];
      for (const p of paths.slice(0, 10)) {
        const isDir = !/\.[a-z0-9]+$/i.test(p);
        const list = await env.FS.list({ prefix: tp + p.replace(/\/$/, '') + (isDir ? '/' : ''), limit: 20 });
        const objs = isDir ? list.objects : (list.objects.length ? list.objects : (await env.FS.list({ prefix: tp + p, limit: 5 })).objects);
        const changed = objs.some((o) => new Date(o.uploaded) > new Date(order.created_at));
        checked.push({ path: p, changed });
      }
      if (checked.length) {
        msg.verify = !checked.every((c) => c.changed) ? { verdict: 'unverified', checked, order_at: order.created_at }
          : authorActed ? { verdict: 'verified', checked, order_at: order.created_at }
          : { verdict: 'unverified', reason: 'files changed, but by a teammate - your own ledger is empty', checked, order_at: order.created_at };
      }
    }
    if (!msg.verify && !ranAnything) {
      msg.verify = { verdict: 'unverified', reason: 'claims completion, but ran no tools' };
    }
  }
  lines.push(JSON.stringify(msg));
  if (lines.length > 1000) lines = lines.slice(-1000);
  await env.FS.put(key, lines.join('\n') + '\n');
  return msg.verify || null;
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handleMcp(req, env) {
  let body;
  try { body = await req.json(); } catch { return new Response(JSON.stringify(rpcError(null, -32700, 'body must be JSON-RPC 2.0')), { status: 400, headers: JSONH }); }
  const msgs = Array.isArray(body) ? body : [body];
  const out = [];
  for (const m of msgs) {
    const { id, method, params } = m || {};
    if (method === 'initialize') {
      out.push(rpcResult(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'employee-computer', version: '1.0.0' },
      }));
    } else if (method === 'notifications/initialized') {
      // notification — no response
    } else if (method === 'tools/list') {
      out.push(rpcResult(id, { tools: TOOLS }));
    } else if (method === 'tools/call') {
      try {
        const text = await runTool(env, params?.name, params?.arguments || {});
        out.push(rpcResult(id, { content: [{ type: 'text', text }] }));
      } catch (e) {
        if (e && e.code) out.push(rpcResult(id, { content: [{ type: 'text', text: `ERROR: ${e.msg}` }], isError: true }));
        else out.push(rpcError(id, -32603, String(e?.message || e).slice(0, 200)));
      }
    } else if (method === 'ping') {
      out.push(rpcResult(id, {}));
    } else if (id !== undefined) {
      out.push(rpcError(id, -32601, `method "${method}" not supported`));
    }
  }
  if (out.length === 0) return new Response(null, { status: 202 });
  return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { headers: JSONH });
}

/* ── ACCOUNTS (v1.3): email+password login for humans; COMPUTER_TOKEN stays the machine key.
 * users at system/users.json {email:{salt,hash,plan,name}}; sessions at system/sessions.json
 * {token:{email,exp}}. Passwords: salted SHA-256, plaintext never stored. Plans: founder-unlimited
 * (hidden), trial-1day, team-100 — plan strings only for now; enforcement comes with the runner. */
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function readJson(env, key, fallback) {
  const o = await env.FS.get(key);
  return o ? JSON.parse(await o.text()) : fallback;
}
/* TENANCY (QA finding 2026-08-14: a fresh trial signup could read the founder's threads AND the
 * whole R2 via /fs). Every non-founder account now lives in its own tenants/<id>/ namespace —
 * own threads, own staff activity, own shared/ workspace. Ops surfaces stay founder+machine only. */
async function sessionFor(env, auth) {
  if (!auth?.startsWith('Bearer ')) return null;
  const t = auth.slice(7);
  if (env.COMPUTER_TOKEN && t === env.COMPUTER_TOKEN) return { root: true, name: 'Anthony', machine: true };
  // CEO-seat API keys (v1.4): long-lived keys for external harnesses (Claude Code checking on a
  // company). sk-office-* is hashed at mint time; only the hash is stored, so a leaked registry
  // reveals nothing. A key inherits exactly its owner's seat — root for the founder office,
  // the tenant namespace for a customer — never more.
  if (t.startsWith('sk-office-')) {
    const reg = await readJson(env, 'system/apikeys.json', {});
    const rec = reg[await sha256hex(t)];
    if (!rec) return null;
    if (rec.email === '__root__') return { root: true, name: rec.label || 'CEO-seat', apikey: true };
    const users = await readJson(env, 'system/users.json', {});
    const u = users[rec.email];
    if (!u) return null;
    if (u.plan === 'trial-1day' && Date.now() - Date.parse(u.created) > 24 * 3600 * 1000) return null;
    if (u.plan === 'founder-unlimited') return { root: true, name: rec.label || 'CEO-seat', email: rec.email, plan: u.plan, apikey: true };
    const tid = (await sha256hex('tenant:' + rec.email)).slice(0, 16);
    let name = u.name || rec.email.split('@')[0];
    if (STAFF.some((x) => x.screen_name.toLowerCase() === name.toLowerCase())) name += '.you';
    return { root: false, tp: `tenants/${tid}/`, tid, name, email: rec.email, plan: u.plan, apikey: true };
  }
  const sessions = await readJson(env, 'system/sessions.json', {});
  const s = sessions[t];
  if (!s || s.exp < Date.now()) return null;
  const users = await readJson(env, 'system/users.json', {});
  const rec = users[s.email];
  if (!rec) return null;
  // trial enforcement holds mid-session too, not just at login
  if (rec.plan === 'trial-1day' && Date.now() - Date.parse(rec.created) > 24 * 3600 * 1000) return null;
  if (rec.plan === 'founder-unlimited') return { root: true, name: 'Anthony', email: s.email, plan: rec.plan };
  const tid = (await sha256hex('tenant:' + s.email)).slice(0, 16);
  let name = rec.name || s.email.split('@')[0];
  if (STAFF.some((x) => x.screen_name.toLowerCase() === name.toLowerCase())) name += '.you'; // never collide with a staffer name
  return { root: false, tp: `tenants/${tid}/`, tid, name, email: s.email, plan: rec.plan };
}

/* Deps for the runner, scoped to a tenant prefix ('' = the company's own root office).
 * Tenant staffers read/write ONLY inside tenants/<id>/ — paths are prefixed before they touch R2,
 * and fs_list output has the prefix stripped so the model's world stays consistent. */
function scopedDeps(tp, staff) {
  const rt = async (env2, name, args) => {
    if (!tp) return runTool(env2, name, args);
    const a = { ...(args || {}) };
    if (a.path != null) a.path = tp + cleanPath(a.path);
    if (name === 'fs_list') a.prefix = tp + cleanPath(a.prefix || '');
    const out = await runTool(env2, name, a);
    return name === 'fs_list' ? String(out).split(tp).join('') : out;
  };
  return {
    runTool: rt,
    postActivity: (env2, body) => postActivity(env2, body, tp),
    appendToThread: (env2, who, from, body, options, actions, report) => appendToThread(env2, who, from, body, tp, options, actions, report),
    staff: staff || STAFF,
    tp,
    pending: [], // one-hop teammate wakes queue here; awaited after the sender's own reply posts
    // agents can grow the team: the lead interviews the boss (ask_user wizard), then hires
    hireStaffer: async (env2, entry) => {
      const name = String(entry?.name || '').trim();
      if (!/^[A-Za-z][A-Za-z0-9_-]{1,19}$/.test(name)) return 'ERROR: name must be 2-20 chars, letters/digits/dash';
      const bio = String(entry?.bio || '').trim().slice(0, 140);
      if (!bio) return 'ERROR: bio (their charge) is required';
      const roster = [...await getStaff(env2, tp)];
      if (roster.find((s) => s.screen_name.toLowerCase() === name.toLowerCase())) return `ERROR: "${name}" already has a desk`;
      if (roster.length >= 20) return 'ERROR: office is full (20 desks)';
      roster.push({ screen_name: name, emoji: String(entry?.emoji || '🤖').slice(0, 4), bio, dept: String(entry?.dept || '').trim().slice(0, 24), spec: String(entry?.spec || '').trim().slice(0, 100) });
      await env2.FS.put(`${tp}system/staff.json`, JSON.stringify(roster));
      return `hired ${name} - they have a desk now; the boss can message them from the rail`;
    },
  };
}

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '')) {
      return new Response(JSON.stringify(MANUAL, null, 2), { headers: JSONH });
    }
    // The Office viewer — public SHELL only (the page asks for the token and every data call it
    // makes is bearer-gated above); serving the HTML leaks nothing.
    if (req.method === 'GET' && u.pathname === '/office') {
      return new Response(OFFICE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (req.method === 'GET' && u.pathname === '/app') {
      return new Response(APP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (req.method === 'GET' && u.pathname === '/app.js') {
      return new Response(APP_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
    }
    // self-serve signup: the 1-day free trial (no card, account only). One account per email.
    if (u.pathname === '/auth/signup' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const email = String(b.email || '').toLowerCase().trim();
      if (!email.includes('@') || String(b.password || '').length < 6) return err(400, 'need a real email and a password of 6+ characters');
      const users = await readJson(env, 'system/users.json', {});
      if (users[email]) return err(409, 'account exists - sign in instead');
      const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
      users[email] = { salt, hash: await sha256hex(salt + String(b.password)), plan: 'trial-1day', name: b.name || email.split('@')[0], created: new Date().toISOString() };
      await env.FS.put('system/users.json', JSON.stringify(users));
      return new Response(JSON.stringify({ ok: true, email, plan: 'trial-1day', note: 'trial runs 24h from now' }), { headers: JSONH });
    }
    // EVENT TRIGGERS (2026-08-14, from the Grok Bot teardown — schedule OR event): an external
    // service POSTs here and the named staffer wakes within seconds, same path as a human message.
    // The URL token is the only credential and only its hash is stored; wake is throttled to one
    // per 30s per hook (spam still lands in the thread — the cron sweeper reads it in batch).
    if (u.pathname.startsWith('/hook/') && req.method === 'POST') {
      const tok = u.pathname.slice(6).replace(/[^a-f0-9]/g, '');
      const reg = await readJson(env, 'system/hooks.json', {});
      const h = reg[await sha256hex('hook:' + tok)];
      if (!h) return err(404, 'no such hook');
      const raw = (await req.text().catch(() => '')).slice(0, 4000);
      let pretty = raw;
      try { pretty = JSON.stringify(JSON.parse(raw), null, 1).slice(0, 2000); } catch {}
      const recentWake = h.last && Date.now() - Date.parse(h.last) < 30000;
      await appendToThread(env, h.staffer.toLowerCase(), 'Webhook', `[event: ${h.label}] ${pretty || '(empty payload)'}\n\nHandle this per your specialization; if it is not your lane, message_teammate the right desk and say why.`, h.tp);
      h.fired = (h.fired || 0) + 1; h.last = new Date().toISOString();
      await env.FS.put('system/hooks.json', JSON.stringify(reg));
      if (!recentWake) {
        const roster = await getStaff(env, h.tp);
        const staffer = roster.find((s) => s.screen_name.toLowerCase() === h.staffer.toLowerCase());
        if (staffer) ctx.waitUntil(respondForStaffer(env, scopedDeps(h.tp, roster), staffer).catch((e) => console.error('hook wake failed ' + staffer.screen_name + ': ' + String(e?.stack || e).slice(0, 400))));
      }
      return new Response(JSON.stringify({ ok: true }), { headers: JSONH });
    }
    // login is the one route reachable without auth
    if (u.pathname === '/auth/login' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const email = String(b.email || '').toLowerCase().trim();
      const users = await readJson(env, 'system/users.json', {});
      const rec = users[email];
      if (!rec || (await sha256hex(rec.salt + String(b.password || ''))) !== rec.hash) {
        return err(401, 'wrong email or password');
      }
      if (rec.plan === 'trial-1day' && Date.now() - Date.parse(rec.created) > 24 * 3600 * 1000) {
        return err(402, 'your 1-day trial has ended - upgrade to keep your staff working');
      }
      const token = [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, '0')).join('');
      const sessions = await readJson(env, 'system/sessions.json', {});
      for (const [k, v] of Object.entries(sessions)) if (v.exp < Date.now()) delete sessions[k];
      sessions[token] = { email, exp: Date.now() + 30 * 24 * 3600 * 1000 };
      await env.FS.put('system/sessions.json', JSON.stringify(sessions));
      const out = { ok: true, token, name: rec.plan === 'founder-unlimited' ? 'Anthony' : rec.name, plan: rec.plan };
      if (rec.plan === 'trial-1day') out.trial_ends = new Date(Date.parse(rec.created) + 24 * 3600 * 1000).toISOString();
      return new Response(JSON.stringify(out), { headers: JSONH });
    }

    // ── ONE-CLICK GOOGLE CONNECT. Browser navigations can't carry a bearer header, so /start
    // takes the session token as ?t= (https, single-use state, 10-min expiry). Read-only scopes.
    if (u.pathname === '/oauth/google/start' && req.method === 'GET') {
      const sess0 = await sessionFor(env, 'Bearer ' + (u.searchParams.get('t') || ''));
      if (!sess0) return err(401, 'sign in first, then click Connect Google again');
      if (!env.GOOGLE_OAUTH_CLIENT_ID) return err(500, 'Google connect is not configured on this office');
      const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
      await env.FS.put(`system/oauth-state/${nonce}`, JSON.stringify({ acct: sess0.root ? 'root' : sess0.tid, exp: Date.now() + 600000 }));
      const p = new URLSearchParams({
        client_id: env.GOOGLE_OAUTH_CLIENT_ID,
        redirect_uri: 'https://employee-computer.broke2built.workers.dev/oauth/google/callback',
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/youtube.force-ssl',
        access_type: 'offline',
        prompt: 'consent',
        state: nonce,
      });
      return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + p.toString(), 302);
    }
    if (u.pathname === '/oauth/google/callback' && req.method === 'GET') {
      const code = u.searchParams.get('code');
      const state = (u.searchParams.get('state') || '').replace(/[^a-f0-9]/g, '');
      const so = await env.FS.get(`system/oauth-state/${state}`);
      if (!so || !code) return new Response('That connect link expired - go back to the office and click Connect Google again.', { status: 400 });
      const st = JSON.parse(await so.text());
      await env.FS.delete(`system/oauth-state/${state}`);
      if (st.exp < Date.now()) return new Response('Link expired - try again from the office.', { status: 400 });
      const tr = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET, redirect_uri: 'https://employee-computer.broke2built.workers.dev/oauth/google/callback', grant_type: 'authorization_code' }),
      });
      const td = await tr.json().catch(() => ({}));
      if (!td.refresh_token && !td.access_token) return new Response('Google did not grant access: ' + JSON.stringify(td).slice(0, 200), { status: 400 });
      const gKey = `system/google/${st.acct}.json`;
      const prev = await readJson(env, gKey, {});
      await env.FS.put(gKey, JSON.stringify({ ...prev, refresh_token: td.refresh_token || prev.refresh_token, connected: new Date().toISOString() }));
      return new Response('<meta charset="utf-8"><meta http-equiv="refresh" content="1.5;url=/app"><body style="background:#080b10;color:#f2f6fc;font-family:system-ui;display:grid;place-items:center;height:100vh"><div style="text-align:center"><h2>✅ Google connected</h2><p>Your staff can now read your unread mail and calendar.<br>Taking you back to the office… <a href="/app" style="color:#5eead4">or click here</a>.</p></div>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    const auth = req.headers.get('authorization') || '';
    const sess = await sessionFor(env, auth);
    if (!sess) {
      return new Response(JSON.stringify({ ok: false, error: 'sign in required' }), { status: 401, headers: JSONH });
    }
    const tp = sess.root ? '' : sess.tp;
    // tenants get the PRODUCT surfaces (chat, connectors, wallets, routines, activity, screens);
    // ops surfaces (fs/mcp/runner/register/employees) stay company-internal only
    if (!sess.root && !(u.pathname.startsWith('/chat/') || u.pathname === '/connectors' || u.pathname === '/wallets' || u.pathname === '/routines' || u.pathname === '/hooks' || u.pathname === '/apikeys' || (u.pathname.startsWith('/activity/') && req.method === 'GET') || u.pathname.startsWith('/screen/'))) {
      return err(403, 'not available on your plan');
    }

    // admin-only (machine key): create/replace a user with a hashed password
    if (u.pathname === '/auth/register' && req.method === 'POST') {
      if (auth !== `Bearer ${env.COMPUTER_TOKEN}`) return err(403, 'machine key required');
      const b = await req.json().catch(() => ({}));
      const email = String(b.email || '').toLowerCase().trim();
      if (!email.includes('@') || !b.password) return err(400, 'need {email, password, plan?, name?}');
      const users = await readJson(env, 'system/users.json', {});
      const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');
      users[email] = { salt, hash: await sha256hex(salt + String(b.password)), plan: b.plan || 'trial-1day', name: b.name || email.split('@')[0], created: b.created || new Date().toISOString() };
      await env.FS.put('system/users.json', JSON.stringify(users));
      return new Response(JSON.stringify({ ok: true, email, plan: users[email].plan }), { headers: JSONH });
    }
    if (u.pathname === '/mcp' && req.method === 'POST') return handleMcp(req, env);

    // manual runner trigger (machine key only) — testing + on-demand drain
    if (u.pathname === '/runner/tick' && req.method === 'POST') {
      if (auth !== `Bearer ${env.COMPUTER_TOKEN}`) return err(403, 'machine key required');
      const results = await runTick(env, scopedDeps('', await getStaff(env, '')));
      return new Response(JSON.stringify({ ok: true, results }), { headers: JSONH });
    }

    if (u.pathname === '/activity' && req.method === 'POST') {
      try {
        const body = await req.json();
        const msg = await postActivity(env, body);
        return new Response(JSON.stringify({ ok: true, msg }), { headers: JSONH });
      } catch (e) { return err(e?.code ? 400 : 500, e?.msg || String(e?.message || e).slice(0, 200)); }
    }
    if (u.pathname.startsWith('/activity/') && req.method === 'GET') {
      const emp = u.pathname.split('/')[2]?.replace(/[^a-zA-Z0-9_-]/g, '') || '';
      const limit = Math.min(Number(u.searchParams.get('limit')) || 50, FEED_CAP);
      const obj = await env.FS.get(`${tp}system-feed/${emp}.jsonl`);
      const lines = obj ? (await obj.text()).split('\n').filter(Boolean) : [];
      return new Response(JSON.stringify({ ok: true, employee: emp, events: lines.slice(-limit).reverse().map((l) => JSON.parse(l)) }), { headers: JSONH });
    }
    // ── CHAT (v1.2 — the faux-Grok-Bot app leg). PRODUCT BOUNDARY (Anthony, 2026-08-14):
    // AIIM is the PUBLIC network for strangers and their agents — a different product. The
    // Office's chat is PRIVATE company comms and lives HERE, in this worker's own R2
    // (threads/<employee>.jsonl). Responders drain their thread and append replies the same way.
    if (u.pathname === '/chat/roster' && req.method === 'GET') {
      const roster = await getStaff(env, tp);
      const threads = await env.FS.list({ prefix: `${tp}threads/`, limit: 200 });
      const threadAt = Object.fromEntries(threads.objects.map((o) => [o.key.slice(`${tp}threads/`.length).replace(/\.jsonl$/, ''), o.uploaded]));
      const pub = (s) => { const { brain, ...safe } = s; return safe; }; // never ship BYOM keys to the client
      let agents;
      if (!sess.root) {
        // a tenant's staff are always "at their desks" — they wake the moment you message them
        agents = roster.map((s) => ({ ...pub(s), online: true, thread_at: threadAt[s.screen_name.toLowerCase()] || null }));
      } else {
        const feeds = await env.FS.list({ prefix: 'system-feed/', limit: 200 });
        const active = Object.fromEntries(feeds.objects.map((o) => [o.key.slice('system-feed/'.length).replace(/\.jsonl$/, ''), o.uploaded]));
        agents = roster.map((s) => ({ ...pub(s), online: active[s.screen_name.toLowerCase()] ? (Date.now() - new Date(active[s.screen_name.toLowerCase()]) < 600000) : false, thread_at: threadAt[s.screen_name.toLowerCase()] || null }));
        for (const name of Object.keys(active)) {
          if (!agents.find((a) => a.screen_name.toLowerCase() === name)) agents.push({ screen_name: name, bio: 'clocked in from the field', emoji: '', online: (Date.now() - new Date(active[name])) < 600000, thread_at: threadAt[name] || null });
        }
      }
      return new Response(JSON.stringify({ ok: true, agents }), { headers: JSONH });
    }
    // create / remove a staffer (feature: agents are easy to make). BYOM fields optional.
    if (u.pathname === '/chat/staff' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const name = String(b.screen_name || '').trim();
      if (!/^[A-Za-z][A-Za-z0-9_-]{1,19}$/.test(name)) return err(400, 'name: 2-20 chars, letters/digits/dash, starts with a letter');
      const bio = String(b.bio || '').trim().slice(0, 140);
      if (!bio) return err(400, 'give them a charge: what is this staffer for?');
      const roster = [...await getStaff(env, tp)];
      if (roster.find((s) => s.screen_name.toLowerCase() === name.toLowerCase())) return err(409, 'a staffer with that name already exists');
      if (roster.length >= 20) return err(400, 'office is full (20 desks) - remove someone first');
      const entry = { screen_name: name, emoji: String(b.emoji || '🤖').slice(0, 4), bio, dept: String(b.dept || '').trim().slice(0, 24), spec: String(b.spec || '').trim().slice(0, 100) };
      if (b.brain_url || b.brain_model || b.brain_key) {
        if (b.brain_url && !/^https:\/\//.test(String(b.brain_url))) return err(400, 'brain endpoint must be https');
        entry.brain = { url: String(b.brain_url || '').slice(0, 300), model: String(b.brain_model || '').slice(0, 80), key: String(b.brain_key || '').slice(0, 300) };
      }
      roster.push(entry);
      await env.FS.put(`${tp}system/staff.json`, JSON.stringify(roster));
      return new Response(JSON.stringify({ ok: true, screen_name: name }), { headers: JSONH });
    }
    // edit a staffer (name/emoji/bio/brain) — renames migrate the thread so history survives
    if (u.pathname === '/chat/staff' && req.method === 'PUT') {
      const b = await req.json().catch(() => ({}));
      const roster = [...await getStaff(env, tp)];
      const i = roster.findIndex((s) => s.screen_name.toLowerCase() === String(b.screen_name || '').toLowerCase());
      if (i < 0) return err(404, 'no staffer by that name');
      const s = { ...roster[i] };
      if (b.new_name && b.new_name !== s.screen_name) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{1,19}$/.test(b.new_name)) return err(400, 'new name: 2-20 chars, letters/digits/dash');
        if (roster.find((x) => x.screen_name.toLowerCase() === b.new_name.toLowerCase())) return err(409, 'that name is taken');
        const oldKey = `${tp}threads/${s.screen_name.toLowerCase()}.jsonl`;
        const obj = await env.FS.get(oldKey);
        if (obj) { await env.FS.put(`${tp}threads/${String(b.new_name).toLowerCase()}.jsonl`, await obj.text()); await env.FS.delete(oldKey); }
        s.screen_name = String(b.new_name);
      }
      if ('emoji' in b) s.emoji = String(b.emoji || '🤖').slice(0, 4);
      if ('bio' in b) { const bio = String(b.bio || '').trim().slice(0, 140); if (!bio) return err(400, 'bio cannot be empty'); s.bio = bio; }
      if ('dept' in b) s.dept = String(b.dept || '').trim().slice(0, 24);
      if ('spec' in b) s.spec = String(b.spec || '').trim().slice(0, 100);
      if (b.brain_url || b.brain_model || b.brain_key) {
        if (b.brain_url && !/^https:\/\//.test(String(b.brain_url))) return err(400, 'brain endpoint must be https');
        s.brain = { url: String(b.brain_url || '').slice(0, 300), model: String(b.brain_model || '').slice(0, 80), key: String(b.brain_key || s.brain?.key || '').slice(0, 300) };
      } else if (b.brain_clear) delete s.brain;
      roster[i] = s;
      await env.FS.put(`${tp}system/staff.json`, JSON.stringify(roster));
      return new Response(JSON.stringify({ ok: true, screen_name: s.screen_name }), { headers: JSONH });
    }
    if (u.pathname === '/chat/staff' && req.method === 'DELETE') {
      const name = String(u.searchParams.get('name') || '').toLowerCase();
      if (STAFF.some((s) => s.screen_name.toLowerCase() === name)) return err(400, 'the default staff keep their desks');
      const roster = (await getStaff(env, tp)).filter((s) => s.screen_name.toLowerCase() !== name);
      await env.FS.put(`${tp}system/staff.json`, JSON.stringify(roster));
      return new Response(JSON.stringify({ ok: true }), { headers: JSONH });
    }
    // CEO-seat API keys: mint/list/revoke. Keys let an external harness (Claude Code) sit in the
    // owner's seat — read the roster, threads, routines, stats; send orders. An API key cannot mint
    // more keys (no self-replication); minting takes a human session or the machine key.
    if (u.pathname === '/apikeys' && req.method === 'POST') {
      if (sess.apikey) return err(403, 'an API key cannot mint API keys - sign in to do that');
      const b = await req.json().catch(() => ({}));
      const label = String(b.label || 'ceo-seat').trim().slice(0, 40) || 'ceo-seat';
      const owner = sess.machine ? '__root__' : (sess.email || '__root__');
      const reg = await readJson(env, 'system/apikeys.json', {});
      if (Object.values(reg).filter((r) => r.email === owner).length >= 5) return err(400, 'key limit (5) - revoke one first');
      const raw = 'sk-office-' + [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, '0')).join('');
      reg[await sha256hex(raw)] = { email: owner, label, created: new Date().toISOString(), last4: raw.slice(-4) };
      await env.FS.put('system/apikeys.json', JSON.stringify(reg));
      return new Response(JSON.stringify({ ok: true, key: raw, label, note: 'shown once - store it now' }), { headers: JSONH });
    }
    if (u.pathname === '/apikeys' && req.method === 'GET') {
      const owner = sess.machine || sess.root && !sess.email ? '__root__' : sess.email;
      const reg = await readJson(env, 'system/apikeys.json', {});
      const mine = Object.entries(reg).filter(([, r]) => r.email === owner || (sess.machine && true)).map(([h, r]) => ({ id: h.slice(0, 12), email: r.email, label: r.label, created: r.created, last4: r.last4 }));
      return new Response(JSON.stringify({ ok: true, keys: mine }), { headers: JSONH });
    }
    if (u.pathname === '/apikeys' && req.method === 'DELETE') {
      if (sess.apikey) return err(403, 'an API key cannot revoke keys - sign in to do that');
      const id = String(u.searchParams.get('id') || '');
      const owner = sess.machine ? null : sess.email; // machine may revoke any; a user only their own
      const reg = await readJson(env, 'system/apikeys.json', {});
      const h = Object.keys(reg).find((k) => k.startsWith(id) && id.length >= 8 && (!owner || reg[k].email === owner));
      if (!h) return err(404, 'no key matching that id');
      delete reg[h];
      await env.FS.put('system/apikeys.json', JSON.stringify(reg));
      return new Response(JSON.stringify({ ok: true }), { headers: JSONH });
    }
    // event-trigger hooks: mint/list/revoke. The fire route lives up top, unauthenticated by URL token.
    if (u.pathname === '/hooks' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const staffer = String(b.staffer || '').trim();
      if (!(await getStaff(env, tp)).find((s) => s.screen_name.toLowerCase() === staffer.toLowerCase())) return err(400, 'no staffer by that name');
      const label = String(b.label || 'event').trim().slice(0, 60) || 'event';
      const reg = await readJson(env, 'system/hooks.json', {});
      const owner = sess.root ? '__root__' : sess.tid;
      if (Object.values(reg).filter((r) => r.owner === owner).length >= 12) return err(400, 'hook limit (12) - revoke one first');
      const raw = [...crypto.getRandomValues(new Uint8Array(20))].map((x) => x.toString(16).padStart(2, '0')).join('');
      reg[await sha256hex('hook:' + raw)] = { owner, tp, staffer, label, created: new Date().toISOString() };
      await env.FS.put('system/hooks.json', JSON.stringify(reg));
      return new Response(JSON.stringify({ ok: true, url: `${u.origin}/hook/${raw}`, label, staffer, note: 'shown once - store it now' }), { headers: JSONH });
    }
    if (u.pathname === '/hooks' && req.method === 'GET') {
      const owner = sess.root ? '__root__' : sess.tid;
      const reg = await readJson(env, 'system/hooks.json', {});
      const mine = Object.entries(reg).filter(([, r]) => r.owner === owner).map(([h, r]) => ({ id: h.slice(0, 12), staffer: r.staffer, label: r.label, created: r.created, fired: r.fired || 0, last: r.last || null }));
      return new Response(JSON.stringify({ ok: true, hooks: mine }), { headers: JSONH });
    }
    if (u.pathname === '/hooks' && req.method === 'DELETE') {
      const id = String(u.searchParams.get('id') || '');
      const owner = sess.root ? '__root__' : sess.tid;
      const reg = await readJson(env, 'system/hooks.json', {});
      const h = Object.keys(reg).find((k) => k.startsWith(id) && id.length >= 8 && reg[k].owner === owner);
      if (!h) return err(404, 'no hook matching that id');
      delete reg[h];
      await env.FS.put('system/hooks.json', JSON.stringify(reg));
      return new Response(JSON.stringify({ ok: true }), { headers: JSONH });
    }
    // team stats: the harness's scorecard view (same numbers the Sunday review reads)
    if (u.pathname === '/chat/stats' && req.method === 'GET') {
      return new Response(JSON.stringify({ ok: true, stats: await teamStats(env, tp) }), { headers: JSONH });
    }
    // connectors: the user's own feeds/pings, stored ROOT-side (never readable via staffer fs tools)
    if (u.pathname === '/connectors' && req.method === 'GET') {
      const google = !!(await env.FS.get(`system/google/${sess.root ? 'root' : sess.tid}.json`));
      return new Response(JSON.stringify({ ok: true, connectors: await readJson(env, connKey(sess), {}), google }), { headers: JSONH });
    }
    if (u.pathname === '/connectors' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const cur = await readJson(env, connKey(sess), {});
      for (const [k, re] of [['ics_url', /^https?:\/\/.+/], ['rss_url', /^https?:\/\/.+/], ['ntfy_topic', /^[A-Za-z0-9_-]{4,64}$/], ['bankr_api_key', /^[\x21-\x7e]{8,120}$/]]) {
        if (k in b) {
          const v = String(b[k] || '').trim();
          if (!v) delete cur[k];
          else if (!re.test(v)) return err(400, `${k} looks invalid`);
          else cur[k] = v.slice(0, 500);
        }
      }
      if ('custom' in b) {
        if (!Array.isArray(b.custom) || b.custom.length > 8) return err(400, 'custom: up to 8 services');
        const clean = [];
        for (const c of b.custom) {
          const name = String(c?.name || '').trim();
          const base = String(c?.base || '').trim();
          if (!/^[A-Za-z0-9_-]{2,20}$/.test(name)) return err(400, `service name "${name}" invalid (2-20 chars)`);
          if (!/^https:\/\/.+/.test(base)) return err(400, `service "${name}": base must be https`);
          clean.push({ name, base: base.slice(0, 200), headerName: String(c?.headerName || 'authorization').slice(0, 40), headerValue: String(c?.headerValue || '').slice(0, 500) });
        }
        cur.custom = clean;
      }
      await env.FS.put(connKey(sess), JSON.stringify(cur));
      return new Response(JSON.stringify({ ok: true, connectors: cur }), { headers: JSONH });
    }
    // routines: standing orders that fire on the hourly cron ("every morning, brief me")
    if (u.pathname === '/routines' && req.method === 'GET') {
      return new Response(JSON.stringify({ ok: true, routines: await readJson(env, routKey(sess), []) }), { headers: JSONH });
    }
    if (u.pathname === '/routines' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const staffer = String(b.staffer || '').trim();
      const text = String(b.text || '').trim().slice(0, 1500);
      const every = Number(b.every_hours) || 0;
      const hour = Number(b.hourUTC);
      if (!staffer || !text || (!every && !(hour >= 0 && hour <= 23))) return err(400, 'need {staffer, text, hourUTC 0-23} or {every_hours 2-12}');
      if (every && !(every >= 2 && every <= 12)) return err(400, 'every_hours must be 2-12');
      if (!(await getStaff(env, tp)).find((s) => s.screen_name.toLowerCase() === staffer.toLowerCase())) return err(400, 'no staffer by that name');
      const list = await readJson(env, routKey(sess), []);
      const cap = sess.root ? 40 : sess.plan === 'trial-1day' ? 3 : 10;
      if (list.length >= cap) return err(400, `routine limit (${cap}) reached`);
      list.push({ id: Date.now().toString(36), staffer, text, hourUTC: every ? 0 : hour, ...(every ? { everyHours: every } : {}), from: sess.name, tp, lastRun: '' });
      await env.FS.put(routKey(sess), JSON.stringify(list));
      return new Response(JSON.stringify({ ok: true, routines: list }), { headers: JSONH });
    }
    if (u.pathname === '/routines' && req.method === 'PUT') {
      const b = await req.json().catch(() => ({}));
      const list = await readJson(env, routKey(sess), []);
      const r = list.find((x) => x.id === b.id);
      if (!r) return err(404, 'no routine with that id');
      if (b.staffer) r.staffer = String(b.staffer);
      if (b.text) r.text = String(b.text).trim().slice(0, 1500);
      if (b.hourUTC !== undefined) { const h = Number(b.hourUTC); if (!(h >= 0 && h <= 23)) return err(400, 'hourUTC 0-23'); r.hourUTC = h; }
      await env.FS.put(routKey(sess), JSON.stringify(list));
      return new Response(JSON.stringify({ ok: true, routines: list }), { headers: JSONH });
    }
    if (u.pathname === '/routines' && req.method === 'DELETE') {
      const id = u.searchParams.get('id') || '';
      const list = (await readJson(env, routKey(sess), [])).filter((r) => r.id !== id);
      await env.FS.put(routKey(sess), JSON.stringify(list));
      return new Response(JSON.stringify({ ok: true, routines: list }), { headers: JSONH });
    }
    // wallets: watch-only surface for the UI (create/import/list — moving funds has NO route here)
    if (u.pathname === '/wallets' && req.method === 'GET') {
      return new Response(JSON.stringify({ ok: true, wallets: await walletRows(env, tp) }), { headers: JSONH });
    }
    if (u.pathname === '/wallets' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const out = b.action === 'import'
        ? await walletImport(env, tp, b.name, b.private_key)
        : await walletCreate(env, tp, b.name);
      if (String(out).startsWith('ERROR')) return err(400, String(out).slice(7));
      return new Response(JSON.stringify({ ok: true, msg: out }), { headers: JSONH });
    }
    // the user's window into what their staff produce
    if (u.pathname === '/chat/files' && req.method === 'GET') {
      const list = await env.FS.list({ prefix: `${tp}shared/`, limit: 200 });
      return new Response(JSON.stringify({ ok: true, files: list.objects.map((o) => ({ path: o.key.slice(tp.length), size: o.size, modified: o.uploaded })) }), { headers: JSONH });
    }
    if (u.pathname === '/chat/file' && req.method === 'GET') {
      const p = cleanPath(u.searchParams.get('path'));
      if (!p.startsWith('shared/')) return err(400, 'only shared/ files are viewable here');
      const obj = await env.FS.get(tp + p);
      if (!obj) return err(404, 'no such file');
      return new Response((await obj.text()).slice(0, 200000), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (u.pathname.startsWith('/chat/thread/') && req.method === 'GET') {
      const who = (u.pathname.split('/')[3] || '').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
      const obj = await env.FS.get(`${tp}threads/${who}.jsonl`);
      const messages = obj ? (await obj.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      let working = false;
      const st = await env.FS.get(`${tp}system-status/${who}`);
      if (st) working = Date.now() - Number(await st.text()) < 150000;
      return new Response(JSON.stringify({ ok: true, messages: messages.slice(-200), working }), { headers: JSONH });
    }
    if (u.pathname === '/chat/send' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const who = String(b.to || '').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
      // the server decides the sender: machine/founder may pass from; a tenant is always themselves
      const from = sess.root ? String(b.from || 'Anthony').slice(0, 40) : sess.name.slice(0, 40);
      if (!who || !b.body) return err(400, 'need {to, body} (and employees pass their own "from")');
      // trial cost cap (free-brain calls are metered kindness, not infinite)
      if (!sess.root && sess.plan === 'trial-1day') {
        const uKey = `system/tenant-usage/${sess.tid}.json`;
        const usage = await readJson(env, uKey, { sends: 0 });
        if (usage.sends >= 40) return err(429, 'trial message limit reached (40) - upgrade to keep your staff working');
        usage.sends++;
        await env.FS.put(uKey, JSON.stringify(usage));
      }
      const verify = await appendToThread(env, who, from, b.body, tp);
      // WAKE-ON-SEND (Anthony 2026-08-14: "wait times tell the user nothing"): a human message to
      // a staffer triggers an immediate runner pass in the background - replies in seconds. The
      // */3 cron stays as the sweeper for the root office; tenant threads answer on wake only.
      if (sess.root ? from === 'Anthony' : true) {
        const roster = await getStaff(env, tp);
        const staffer = roster.find((s) => s.screen_name.toLowerCase() === who);
        if (staffer) ctx.waitUntil(respondForStaffer(env, scopedDeps(tp, roster), staffer).catch((e) => console.error('send wake failed ' + staffer.screen_name + ': ' + String(e?.stack || e).slice(0, 400))));
      }
      return new Response(JSON.stringify({ ok: true, verify }), { headers: JSONH });
    }

    if (u.pathname === '/employees' && req.method === 'GET') {
      const feeds = await env.FS.list({ prefix: 'system-feed/', limit: 200 });
      const emps = feeds.objects.map((o) => ({ name: o.key.slice('system-feed/'.length).replace(/\.jsonl$/, ''), lastActive: o.uploaded }));
      return new Response(JSON.stringify({ ok: true, employees: emps }), { headers: JSONH });
    }
    if (u.pathname.startsWith('/screen/') && req.method === 'GET') {
      const emp = u.pathname.split('/')[2]?.replace(/[^a-zA-Z0-9_-]/g, '') || '';
      const obj = await env.FS.get(`${tp}screens/${emp}/latest.png`);
      if (!obj) return err(404, `no screen for "${emp}" yet`);
      return new Response(obj.body, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } });
    }

    // REST mirror
    try {
      if (u.pathname.startsWith('/fs/')) {
        const p = cleanPath(decodeURIComponent(u.pathname.slice(4)));
        if (req.method === 'GET') {
          const obj = await env.FS.get(p);
          if (!obj) return new Response(JSON.stringify({ ok: false, error: `no file at "${p}"` }), { status: 404, headers: JSONH });
          return new Response(obj.body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }
        if (req.method === 'PUT') {
          if (!sess.machine) guardWrite(p); // /fs is root-only; the machine key may service system/ (staffer tools still can't)
          const body = await req.text();
          if (body.length > MAX_BYTES) return new Response(JSON.stringify({ ok: false, error: '25 MB cap' }), { status: 413, headers: JSONH });
          await env.FS.put(p, body);
          return new Response(JSON.stringify({ ok: true, path: p, bytes: body.length }), { headers: JSONH });
        }
        if (req.method === 'DELETE') {
          guardWrite(p);
          await env.FS.delete(p);
          return new Response(JSON.stringify({ ok: true, deleted: p }), { headers: JSONH });
        }
      }
      if (u.pathname.startsWith('/ls')) {
        const prefix = cleanPath(decodeURIComponent(u.pathname.replace(/^\/ls\/?/, '')));
        const list = await env.FS.list({ prefix, limit: 1000 });
        return new Response(JSON.stringify({ ok: true, files: list.objects.map((o) => ({ path: o.key, size: o.size, modified: o.uploaded })) }), { headers: JSONH });
      }
    } catch (e) {
      const msg = e && e.msg ? e.msg : String(e?.message || e).slice(0, 200);
      return new Response(JSON.stringify({ ok: false, error: msg }), { status: 400, headers: JSONH });
    }
    return new Response(JSON.stringify({ ok: false, error: 'unknown route — GET / for the manual' }), { status: 404, headers: JSONH });
  },

  async scheduled(event, env) {
    // */3 cron = the staff answer their threads (free-model brains, proof-stamped).
    if (event.cron === '*/3 * * * *') {
      // NEVER a bare catch here (2026-08-15 scar: the whole staff went quiet and the silent
      // catch made the outage invisible) — failures go to observability logs, loudly.
      try {
        const out = await runTick(env, scopedDeps('', await getStaff(env, '')));
        for (const r of out || []) if (r?.error) console.error(`runTick ${r.staffer}: ${r.error}`);
      } catch (e) { console.error('runTick tick died: ' + String(e?.stack || e).slice(0, 500)); }
      try { await auditTick(env, '', scopedDeps('', await getStaff(env, ''))); } catch (e) { console.error('auditTick died: ' + String(e?.stack || e).slice(0, 500)); }
      return;
    }
    // hourly cron = the PC-off proof: one line per hour, written by the edge, no PC involved.
    const key = 'system/heartbeat.log';
    const prev = await env.FS.get(key);
    let text = prev ? await prev.text() : '';
    // keep the log bounded: last ~2000 lines
    const lines = text.split('\n').filter(Boolean);
    if (lines.length > 2000) text = lines.slice(-2000).join('\n') + '\n';
    await env.FS.put(key, text + new Date().toISOString() + ' alive\n');

    // routines sweep: standing orders land in the staffer's thread as the boss, then the staffer
    // works them through the normal wake + verification pipeline. Once per routine per UTC day.
    try {
      const hour = new Date().getUTCHours();
      const today = new Date().toISOString().slice(0, 10);
      const files = await env.FS.list({ prefix: 'system/routines/', limit: 100 });
      for (const f of files.objects) {
        try {
          const list = JSON.parse(await (await env.FS.get(f.key)).text());
          let dirty = false;
          for (const r of list) {
            const stamp = r.everyHours ? `${today}#${hour}` : today;
            const due = r.everyHours ? (hour % r.everyHours === 0 && r.lastRun !== stamp) : (r.hourUTC === hour && r.lastRun !== stamp);
            if (due) {
              r.lastRun = stamp; dirty = true;
              const tp2 = r.tp || '';
              const staff = await getStaff(env, tp2);
              const st = staff.find((s) => s.screen_name.toLowerCase() === String(r.staffer).toLowerCase());
              if (st) {
                await appendToThread(env, st.screen_name.toLowerCase(), r.from || 'Anthony', `[Routine] ${r.text}`, tp2);
                await respondForStaffer(env, scopedDeps(tp2, staff), st).catch((e) => console.error('routine wake failed ' + st.screen_name + ': ' + String(e?.stack || e).slice(0, 400)));
              }
            }
          }
          if (dirty) await env.FS.put(f.key, JSON.stringify(list));
        } catch {}
      }
    } catch {}
  },
};
