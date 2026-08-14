/* Staffroom — an always-on computer for a team of AI staff. One Cloudflare Worker.
 *
 * WHY THIS EXISTS: agent harnesses (a coding CLI, a local script runner, a browser-driving bot)
 * all die when the laptop running them sleeps. This Worker is the piece that doesn't — an
 * R2-backed filesystem any harness can mount through ONE URL, plus an hourly heartbeat that
 * mutates state machine-side, so "always on" is a measurement rather than a claim.
 *
 * Surfaces:
 *   POST /mcp        — MCP Streamable HTTP (JSON-RPC 2.0): initialize, tools/list, tools/call.
 *                      Tools: fs_read, fs_write, fs_append, fs_list, fs_delete.
 *   REST mirror      — GET/PUT/DELETE /fs/<path> · GET /ls/<prefix> (same auth; for curl/scripts).
 *   POST /activity   — a staffer broadcasts what it is doing (+ an optional screenshot).
 *   GET  /activity/<name> · GET /screen/<name> · GET /employees — the watch surfaces.
 *   GET  /chat/roster · /chat/thread/<name> · POST /chat/send   — private team chat.
 *   POST /runner/tick — make the staff answer their threads now (machine key only).
 *   GET  /app · /app.js · /office — the UI. GET / — a self-describing manual (public).
 *   cron every 3 min — the staff answer their threads (see runner.mjs; needs BRAIN_API_KEY).
 *   cron hourly      — appends a line to system/heartbeat.log (the machine-is-up proof).
 *
 * AUTH: Authorization: Bearer <token>, where the token is either COMPUTER_TOKEN (the machine key
 * your agents carry) or a session token from POST /auth/login (humans). Public: GET /, the UI
 * shell, and POST /auth/signup + /auth/login — every data call the page makes is bearer-gated.
 *
 * TENANCY: the machine key and the owner (`founder-unlimited` plan) are ROOT — they see the real
 * office at the top of the bucket. Every other account is isolated inside its own
 * tenants/<id>/ namespace: own threads, own staff activity, own shared/ workspace. Tenants get
 * the chat product only; the ops surfaces (fs, mcp, runner, feeds) stay root-only.
 *
 * NAMESPACING: paths are free-form; convention is <name>/... for a staffer's private work and
 * shared/... for handoffs. system/ is the worker's own — writes there are refused.
 *
 * Fail-soft: bad input = 4xx with a message naming the fix; JSON-RPC errors use code -32602.
 * Caps: 25 MB per file (R2 single-PUT comfort), 1000 keys per list.
 */

import { OFFICE_HTML } from './office.mjs';
import { APP_HTML, APP_JS } from './app.mjs';
import { runTick } from './runner.mjs';

const JSONH = { 'content-type': 'application/json; charset=utf-8' };
const err = (status, message) => new Response(JSON.stringify({ ok: false, error: message }), { status, headers: JSONH });
const MAX_BYTES = 25 * 1024 * 1024;

// The owner's display name — the boss in every thread. Set OWNER_NAME in wrangler.toml.
const owner = (env) => env.OWNER_NAME || 'Owner';

/* ACTIVITY FEED — every staffer can broadcast what it is doing, and the UI renders that
 * stream as "their screen":
 *   POST /activity  {employee, action, detail?, screenshot_b64?}  — appends an event; if a
 *     screenshot (png/jpeg base64) is attached it is stored at screens/<employee>/latest.png
 *     (overwritten each time = that staffer's live monitor) and the event notes it.
 *   GET  /activity/<employee>?limit=50 — newest-first event log (JSON).
 *   GET  /screen/<employee> — the latest screenshot (image/png), 404 if none yet.
 * Events live at system-feed/<employee>.jsonl (machine-owned namespace, capped at the last 500). */
const FEED_CAP = 500;

// Which cron expression means "let the staff answer their threads" rather than "write a heartbeat".
// Must match the entry in wrangler.toml — the scheduled handler receives the expression verbatim.
const RUNNER_CRON = '*/3 * * * *';

/* The default team. Replace these with your own — the bio doubles as the staffer's job
 * description, so it is worth writing as if the agent will read it (it can). */
const DEFAULT_STAFF = [
  { screen_name: 'Ada', emoji: '📊', bio: 'ops lead — runs the office, ships products, reports to you' },
  { screen_name: 'Patch', emoji: '🔧', bio: 'fixes what breaks — bugs, deploys, drift, red checks' },
  { screen_name: 'Quill', emoji: '✍️', bio: 'writes — docs, release notes, replies that go out' },
  { screen_name: 'Scout', emoji: '🔭', bio: 'research — sources, comparisons, competitor reads' },
  { screen_name: 'Probe', emoji: '🧪', bio: 'the skeptic — verifies claims, runs the gates, breaks things on purpose' },
];

/* tp = tenant prefix: '' for root, 'tenants/<id>/' for everyone else. Every R2 key this function
 * touches is prefixed so a tenant staffer's screen and feed live inside the tenant's world. */
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
  name: 'staffroom',
  what: 'An always-on computer for AI staff: an R2 filesystem every agent harness can mount over MCP or REST, plus activity feeds, screens and private team chat.',
  mcp: 'POST /mcp (Streamable HTTP, JSON-RPC 2.0) — tools: fs_read, fs_write, fs_append, fs_list, fs_delete',
  rest: 'GET|PUT|DELETE /fs/<path> · GET /ls/<prefix>',
  auth: 'Authorization: Bearer <token> — the machine key for agents, or a session token from POST /auth/login (POST /auth/signup for a trial account)',
  conventions: '<name>/... private · shared/... handoffs · system/... machine-owned (read-only to you)',
  heartbeat: 'GET /fs/system/heartbeat.log — one line per hour, written whether or not any PC is awake',
  ui: 'GET /app (sign in) · GET /app?demo=1 (seeded demo, no account needed)',
  brains: 'Staff reply on a 3-minute cron when BRAIN_API_KEY and BRAIN_MODEL are set; POST /runner/tick to run one now',
  source: 'https://github.com/lordbasilaiassistant-sudo/staffroom',
};

const TOOLS = [
  { name: 'fs_read', description: 'Read a file from the shared computer. Returns text content.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'e.g. ada/notes.md or shared/handoff.json' } }, required: ['path'] } },
  { name: 'fs_write', description: 'Write/overwrite a file (text). Convention: <name>/... private, shared/... handoffs.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'fs_append', description: 'Append a line/chunk to a file (creates it if missing). Good for logs and journals.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'fs_list', description: 'List files under a prefix. Returns [{path,size,modified}].', inputSchema: { type: 'object', properties: { prefix: { type: 'string', description: 'e.g. shared/ (empty = everything)' } } } },
  { name: 'fs_delete', description: 'Delete one file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

const cleanPath = (p) => String(p || '').replace(/^\/+/, '').replace(/\.\.+/g, '.').trim();
const guardWrite = (p) => {
  if (!p) throw { code: -32602, msg: 'path is required' };
  if (p.startsWith('system/')) throw { code: -32602, msg: 'system/ is machine-owned — write under <name>/ or shared/' };
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

/* Append a message to a staffer's thread, applying CLAIM VERIFICATION.
 *
 * Language models — especially cheap ones — report "done" when the artifact never landed, and a
 * chat transcript full of confident completions is worth nothing on its own. So the platform
 * checks, inside the chat: when a message that is NOT from the owner sounds like completion, find
 * the last work order in the thread that named shared/ paths and verify each of those paths
 * actually changed AFTER that order was posted. The verdict rides along with the message rather
 * than blocking the send, because a rejected agent just retries the same claim in a loop, whereas
 * a visible "unverified" is information for whoever is reading.
 *
 * The sender name is server-decided at the route layer (see /chat/send), so nobody can post as
 * the owner to skip the check. Returns the verify object, or null when there was nothing to check. */
async function appendToThread(env, who, from, body, tp = '') {
  const key = `${tp}threads/${who}.jsonl`;
  const prev = await env.FS.get(key);
  let lines = prev ? (await prev.text()).split('\n').filter(Boolean) : [];
  const msg = { from, body: String(body).slice(0, 8000), created_at: new Date().toISOString() };
  const claimsDone = from !== owner(env)
    && /\b(done|fixed|fix is in|passes|passing|complete[d]?|shipped|deployed|green|wrote back|written back)\b/i.test(msg.body);
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
        msg.verify = { verdict: checked.every((c) => c.changed) ? 'verified' : 'unverified', checked, order_at: order.created_at };
      }
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
        serverInfo: { name: 'staffroom', version: '0.2.0' },
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

/* ── ACCOUNTS: email+password login for humans; COMPUTER_TOKEN stays the machine key.
 * users at system/users.json {email:{salt,hash,plan,name,created}}; sessions at
 * system/sessions.json {token:{email,exp}}. Passwords: salted SHA-256, plaintext never stored.
 * Plans: founder-unlimited (root — the owner), trial-1day (24h + a message cap), anything else
 * (a paid tenant; no cap enforced here). */
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function readJson(env, key, fallback) {
  const o = await env.FS.get(key);
  return o ? JSON.parse(await o.text()) : fallback;
}
/* TENANT ISOLATION. Without it, a fresh trial signup could read the owner's threads AND the whole
 * bucket via /fs. So: the machine key and the founder-unlimited plan resolve to ROOT; every other
 * account maps to tenants/<sha16('tenant:'+email)>/ — a private world with its own staff. The
 * tenant's display name falls back to the email prefix, and gets '.you' appended if it collides
 * with a staffer's name (so claim verification can still tell the boss from the staff). */
async function sessionFor(env, auth) {
  if (!auth?.startsWith('Bearer ')) return null;
  const t = auth.slice(7);
  if (env.COMPUTER_TOKEN && t === env.COMPUTER_TOKEN) return { root: true, name: owner(env), machine: true };
  const sessions = await readJson(env, 'system/sessions.json', {});
  const s = sessions[t];
  if (!s || !(s.exp > Date.now())) return null;
  const users = await readJson(env, 'system/users.json', {});
  const rec = users[s.email];
  if (!rec) return null;
  // trial enforcement holds mid-session too, not just at login
  if (rec.plan === 'trial-1day' && Date.now() - Date.parse(rec.created) > 24 * 3600 * 1000) return null;
  if (rec.plan === 'founder-unlimited') return { root: true, name: owner(env), email: s.email, plan: rec.plan };
  const tid = (await sha256hex('tenant:' + s.email)).slice(0, 16);
  let name = rec.name || s.email.split('@')[0];
  if (DEFAULT_STAFF.some((x) => x.screen_name.toLowerCase() === name.toLowerCase())) name += '.you'; // never collide with a staffer name
  return { root: false, tp: `tenants/${tid}/`, tid, name, email: s.email, plan: rec.plan };
}

/* Deps for the runner, scoped to a tenant prefix ('' = the root office).
 * Tenant staffers read/write ONLY inside tenants/<id>/ — paths are prefixed before they touch R2,
 * and fs_list output has the prefix stripped so the model's world stays consistent. */
function scopedDeps(tp) {
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
    appendToThread: (env2, who, from, body) => appendToThread(env2, who, from, body, tp),
    staff: DEFAULT_STAFF,
    tp,
  };
}

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    const ownerName = owner(env);
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '')) {
      return new Response(JSON.stringify(MANUAL, null, 2), { headers: JSONH });
    }
    // UI shells are public: the page asks for credentials and every data call it makes is
    // bearer-gated below, so serving the markup leaks nothing.
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
    // login is the other data route reachable without auth
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
      const out = { ok: true, token, name: rec.plan === 'founder-unlimited' ? ownerName : rec.name, plan: rec.plan };
      if (rec.plan === 'trial-1day') out.trial_ends = new Date(Date.parse(rec.created) + 24 * 3600 * 1000).toISOString();
      return new Response(JSON.stringify(out), { headers: JSONH });
    }

    const auth = req.headers.get('authorization') || '';
    const sess = await sessionFor(env, auth);
    if (!sess) {
      return new Response(JSON.stringify({ ok: false, error: 'sign in required' }), { status: 401, headers: JSONH });
    }
    const tp = sess.root ? '' : sess.tp;
    // tenants get the chat product; the ops surfaces (fs/mcp/runner/feeds) stay root-only
    if (!sess.root && !(u.pathname.startsWith('/chat/') || (u.pathname.startsWith('/activity/') && req.method === 'GET') || u.pathname.startsWith('/screen/'))) {
      return err(403, 'not available on your plan');
    }

    // admin-only (machine key): create/replace a user with a hashed password
    if (u.pathname === '/auth/register' && req.method === 'POST') {
      if (!sess.machine) return err(403, 'machine key required');
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

    // Manual runner trigger (machine key only) — for testing, and for draining threads on demand
    // rather than waiting for the next cron tick.
    if (u.pathname === '/runner/tick' && req.method === 'POST') {
      if (!sess.machine) return err(403, 'machine key required');
      const results = await runTick(env, scopedDeps(''));
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

    // ── CHAT: private team comms, one thread per staffer, stored in this worker's own R2
    // at threads/<name>.jsonl (tenant-prefixed). A responder drains its thread and appends
    // replies the same way.
    if (u.pathname === '/chat/roster' && req.method === 'GET') {
      if (!sess.root) {
        // a tenant's staff are always "at their desks" — they wake the moment you message them
        return new Response(JSON.stringify({ ok: true, agents: DEFAULT_STAFF.map((s) => ({ ...s, online: true })), owner: ownerName }), { headers: JSONH });
      }
      const feeds = await env.FS.list({ prefix: 'system-feed/', limit: 200 });
      const active = Object.fromEntries(feeds.objects.map((o) => [o.key.slice('system-feed/'.length).replace(/\.jsonl$/, ''), o.uploaded]));
      const agents = DEFAULT_STAFF.map((s) => ({ ...s, online: active[s.screen_name.toLowerCase()] ? (Date.now() - new Date(active[s.screen_name.toLowerCase()]) < 600000) : false }));
      for (const name of Object.keys(active)) {
        if (!agents.find((a) => a.screen_name.toLowerCase() === name)) agents.push({ screen_name: name, bio: 'clocked in from the field', emoji: '', online: (Date.now() - new Date(active[name])) < 600000 });
      }
      return new Response(JSON.stringify({ ok: true, agents, owner: ownerName }), { headers: JSONH });
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
      // the server decides the sender: machine/owner may pass from; a tenant is always themselves
      const from = sess.root ? String(b.from || ownerName).slice(0, 40) : sess.name.slice(0, 40);
      if (!who || !b.body) return err(400, 'need {to, body} (agents also pass their own "from")');
      // trial cost cap (model calls are metered kindness, not infinite)
      if (!sess.root && sess.plan === 'trial-1day') {
        // ROOT-namespace usage file, on purpose: a tenant's staffers write only under tenants/<id>/,
        // so nothing inside the tenant's world can reset its own meter.
        const uKey = `system/tenant-usage/${sess.tid}.json`;
        const usage = await readJson(env, uKey, { sends: 0 });
        if (usage.sends >= 40) return err(429, 'trial message limit reached (40) - upgrade to keep your staff working');
        usage.sends++;
        await env.FS.put(uKey, JSON.stringify(usage));
      }
      const verify = await appendToThread(env, who, from, b.body, tp);
      // WAKE-ON-SEND: a human message to a staffer triggers an immediate runner pass in the
      // background — replies in seconds instead of "sometime this cron". The */3 cron stays as
      // the sweeper for the root office; tenant threads answer on wake only.
      if (sess.root ? from === ownerName : true) {
        const staffer = DEFAULT_STAFF.find((s) => s.screen_name.toLowerCase() === who);
        if (staffer) ctx.waitUntil(import('./runner.mjs').then((m) => m.respondForStaffer(env, scopedDeps(tp), staffer)).catch(() => {}));
      }
      return new Response(JSON.stringify({ ok: true, from, verify }), { headers: JSONH });
    }

    if (u.pathname === '/employees' && req.method === 'GET') {
      const feeds = await env.FS.list({ prefix: 'system-feed/', limit: 200 });
      const emps = feeds.objects.map((o) => ({ name: o.key.slice('system-feed/'.length).replace(/\.jsonl$/, ''), lastActive: o.uploaded }));
      return new Response(JSON.stringify({ ok: true, employees: emps, owner: ownerName }), { headers: JSONH });
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
          guardWrite(p);
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
    // Frequent cron: the staff answer their threads (root office only — tenant threads answer on
    // wake-on-send). Wrapped in try/catch because a brain outage must not take the heartbeat down.
    if (event.cron === RUNNER_CRON) {
      try { await runTick(env, scopedDeps('')); } catch {}
      return;
    }
    // Hourly cron: the proof that the computer outlives your laptop — one line per hour, from the edge.
    const key = 'system/heartbeat.log';
    const prev = await env.FS.get(key);
    let text = prev ? await prev.text() : '';
    // keep the log bounded: last ~2000 lines
    const lines = text.split('\n').filter(Boolean);
    if (lines.length > 2000) text = lines.slice(-2000).join('\n') + '\n';
    await env.FS.put(key, text + new Date().toISOString() + ' alive\n');
  },
};
