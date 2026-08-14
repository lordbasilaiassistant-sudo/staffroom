# Staffroom

**Open-source AI staff.** A team of persistent AI staffers with their own always-on computer,
screens you can watch, private team chat, and claim verification built into the chat itself. Bring
your own model — including free ones. Self-hosts on Cloudflare in about five minutes.

> **Try it with no setup:** deploy and open `/app?demo=1`, or run `npx wrangler dev` and hit
> `http://localhost:8787/app?demo=1`. The demo is a seeded staffroom — real UI, fake data, no
> account and no keys.

![The office — pick a staffer, chat on the left, watch their computer on the right](docs/screenshots/office.png)

<table><tr>
<td width="55%"><img src="docs/screenshots/verified-work.png" alt="A staffer's completion claim carrying the green verified stamp, with their live activity feed beside it"></td>
<td><img src="docs/screenshots/sign-in.png" alt="The sign-in card with the free one-day trial button"></td>
</tr><tr>
<td><em>"Done" gets checked: the ✓ stamp means the named files really changed after the work order.</em></td>
<td><em>Accounts are email+password; trials are one day, no card.</em></td>
</tr></table>

*(Screenshots are from a hosted instance; your deploy looks the same with your own staff.)*

---

## The problem it solves

Every agent harness you have — a coding CLI, a local script runner, a browser-driving bot — lives
inside a process on a machine that sleeps. Close the laptop and your "autonomous" team stops
existing. Worse, the only trace of what they did is a wall of terminal scrollback.

Staffroom gives a team of agents four things a process cannot give them:

1. **Staff that answer on their own.** Point the worker at any Anthropic-compatible model endpoint
   and a cron gives each staffer its persona, its thread, and tools onto the shared filesystem —
   so it does the work and reports back without you driving the loop. Leave the key unset and drive
   the threads yourself instead; everything else works either way.
2. **A computer that stays on.** An R2-backed filesystem behind one URL, mountable over MCP by any
   harness that speaks it, or over plain REST by anything that speaks `curl`. Files written by an
   agent on your laptop at midnight are there for an agent running in CI at noon. An hourly cron
   writes to `system/heartbeat.log`, so "always on" is something you can read rather than something
   the README asserts.
3. **A place to be seen working.** Each staffer posts what it is doing to its own activity feed,
   and can attach a screenshot. The UI renders that stream as *their screen*. Watching an agent
   work turns out to be a completely different experience from reading its logs afterwards.
4. **Chat where "done" is checked.** Language models — cheap ones especially — say the work is
   finished when the file never landed. See below.

## Claim verification

This is the part worth stealing even if you never deploy the rest.

When an **agent** posts a message that sounds like completion (`done`, `fixed`, `shipped`,
`passing`, `green`…), the server looks back through the thread for the most recent work order that
named paths under `shared/`, then checks R2 to see whether each of those paths actually changed
*after* that order was posted. The result is stamped onto the message:

- ✓ **verified** — every named path has a newer write than the work order.
- ⚠ **unverified** — it says done; these paths did not move.

Two design choices matter here. The verdict **rides along with the message instead of blocking the
send**, because a rejected agent just retries the same claim in a loop, whereas a visible
"unverified" is information for whoever is reading. And the sender's name is decided by **the
server from the credential, not by a name in the payload** — a human's name comes from their
session, and only the machine key or the owner may speak for anyone else — so nobody can post as
the boss to skip the check.

It is a narrow check on purpose: it proves a file moved, not that the work is good. A blunt
artifact test still catches the single most common failure mode in multi-agent systems.

## Quickstart

Requirements: a Cloudflare account and Node 18+. R2 needs the Workers Paid plan (\$5/month at time
of writing); everything else here fits inside it.

```bash
git clone https://github.com/lordbasilaiassistant-sudo/staffroom.git
cd staffroom
npm install

# 1. the filesystem
npx wrangler r2 bucket create staffroom-fs

# 2. the machine key your agents will carry (any long random string)
npx wrangler secret put COMPUTER_TOKEN

# 3. ship it
npx wrangler deploy
```

Then:

```bash
BASE=https://staffroom.<your-subdomain>.workers.dev
TOKEN=<the COMPUTER_TOKEN you just set>

# the manual (public)
curl $BASE/

# write a file as a staffer
curl -X PUT "$BASE/fs/ada/notes.md" -H "authorization: Bearer $TOKEN" --data "first note"

# have a staffer report what it is doing
curl -X POST "$BASE/activity" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"employee":"ada","action":"Wrote the first note","detail":"ada/notes.md"}'
```

Open `$BASE/app` and paste the token into the email field to get straight in, or create a human
login:

```bash
curl -X POST "$BASE/auth/register" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"...","name":"You"}'
```

`/auth/register` requires the machine key. There is also an open `POST /auth/signup` that creates a
**1-day trial** account — trials are capped (24 hours, 40 chat sends) and fully isolated, see
tenancy below. Sessions last 30 days; passwords are stored as salted SHA-256, never in plaintext.

## Tenancy

**Every non-owner account is isolated in its own `tenants/` namespace** — its staff, threads,
screens and `shared/` workspace all live under `tenants/<id>/`, invisible to and from every other
tenant. The machine key and the owner (`founder-unlimited` plan) are *root*: they see the real
office at the top of the bucket, and they are the only ones who can touch the ops surfaces
(`/fs`, `/mcp`, `/runner/tick`, `POST /activity`). Tenants get the chat product: roster, threads,
send, and read-only views of their own staff's activity and screens. Tenant staff answer on
wake-on-send (a message triggers an immediate runner pass); the cron sweeps only the root office.

### Connecting an agent over MCP

Point any MCP client at `POST $BASE/mcp` (Streamable HTTP, JSON-RPC 2.0) with the bearer token.
It exposes five tools: `fs_read`, `fs_write`, `fs_append`, `fs_list`, `fs_delete`. For Claude Code:

```bash
claude mcp add --transport http staffroom https://staffroom.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer $TOKEN"
```

## Filesystem conventions

| Prefix | Meaning |
| --- | --- |
| `<name>/…` | that staffer's private work |
| `shared/…` | handoffs between staffers — **the namespace claim verification watches** |
| `system/…` | the worker's own: heartbeat, users, sessions, trial meters. Writes are refused. |
| `system-feed/…`, `threads/…`, `screens/…` | machine-managed activity, chat and screenshots |
| `tenants/<id>/…` | a tenant's entire private world (same layout as above, one level down) |

Caps: 25 MB per file, 1000 keys per listing, 500 events per feed, 1000 messages per thread,
4 MB per screenshot.

## API

| Route | Auth | What |
| --- | --- | --- |
| `GET /` | public | self-describing manual |
| `GET /app`, `/app.js`, `/office` | public shell | the UI (all its data calls are gated) |
| `POST /auth/signup` | public | `{email,password,name?}` → 1-day trial account |
| `POST /auth/login` | public | `{email,password}` → session token (+ `trial_ends` on trials) |
| `POST /auth/register` | machine key | create/replace a user |
| `POST /mcp` | bearer | MCP Streamable HTTP |
| `GET\|PUT\|DELETE /fs/<path>` | bearer | REST mirror of the filesystem |
| `GET /ls/<prefix>` | bearer | list files |
| `POST /activity` | bearer | `{employee,action,detail?,screenshot_b64?}` |
| `GET /activity/<name>?limit=` | bearer | newest-first event log |
| `GET /screen/<name>` | bearer | latest screenshot (png) |
| `GET /employees` | bearer | who has clocked in, and when |
| `GET /chat/roster` | bearer | staff + online state |
| `GET /chat/thread/<name>` | bearer | last 200 messages + a `working` flag while the staffer types |
| `POST /chat/send` | bearer | `{to,body}` — runs claim verification, wakes the staffer |
| `POST /runner/tick` | machine key | run one round of staff replies now |
| cron `0 * * * *` | — | appends to `system/heartbeat.log` |
| cron `*/3 * * * *` | — | the staff answer their threads (needs `BRAIN_API_KEY`) |

## Bring your own model

Set two values and your staff start answering their own threads:

```bash
npx wrangler secret put BRAIN_API_KEY
# then in wrangler.toml: BRAIN_URL + BRAIN_MODEL for whatever endpoint that key belongs to
```

Every three minutes, any thread whose newest message isn't from its own staffer gets a reply — and
a human message wakes the staffer immediately, so answers come in seconds, not "sometime this
cron". The staffer is given its bio as a persona, the last dozen messages, and real tools: the
shared computer (`fs_read`, `fs_list`, `fs_write`, `log_activity`), **a browser** (`web_search`,
`web_fetch`, `browser_visit` — see below), and **its team** (`list_team`, `message_teammate` for
delegating work orders to whoever's charge fits). Replies go through the same `appendToThread`
path as everyone else's, which means **the runner's own claims get verified like anybody's**.

### The staff have a browser

Three tools, each optional and failing soft to a "not configured" message the model can read:

- `web_search` — live web search via [Tavily](https://tavily.com). Set the `TAVILY_API_KEY`
  secret (their free tier is enough to start).
- `web_fetch` — a plain GET with scripts/styles stripped and a hard cap. No key needed.
- `browser_visit` — a real Chrome via Cloudflare's Browser Rendering REST API. The model reads
  the page as markdown, and a screenshot of what it saw lands on its monitor pane — so you can
  literally watch your staff browse. Needs the `CF_BR_TOKEN` secret (an API token with the
  Browser Rendering permission) and `CF_BR_ACCOUNT` (your Cloudflare account id) in
  `wrangler.toml`.

The system prompt tells staff to research through these tools rather than from memory, and to
save anything worth keeping with `fs_write`.

The client speaks the **Anthropic Messages API** shape (`x-api-key` plus `anthropic-version`, tools
declared with `input_schema`), which several providers implement. `BRAIN_URL` therefore points at
Anthropic by default but works against any Anthropic-compatible endpoint — including free tiers,
which is the point: cheap models are usable here precisely because the platform checks their claims
instead of trusting them. Different staffers on different models is a natural extension; today the
runner uses one endpoint for the whole staff.

Leave `BRAIN_API_KEY` unset and nothing breaks — the staff simply never speak, and every other part
of the worker behaves exactly as documented. You can also drive threads yourself: read
`/chat/thread/<name>`, reply via `/chat/send` with the machine key, and skip the runner entirely.

Bounds worth knowing: 6 tool rounds per reply, 6 staffers per tick (a full default-team round —
delegation chains crawl on less), 1200 max output tokens, 90-second request timeout, and a
2-minute per-staffer lock so wake-on-send and the cron never double-reply. `POST /runner/tick`
(machine key) runs one tick immediately instead of waiting for the cron — the fastest way to
check your wiring.

## Configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `COMPUTER_TOKEN` | secret | the machine key agents carry |
| `BRAIN_API_KEY` | secret | key for your model endpoint; unset = staff never reply |
| `BRAIN_URL` | var (`wrangler.toml`) | messages endpoint (defaults to Anthropic's) |
| `BRAIN_MODEL` | var (`wrangler.toml`) | model id for that endpoint |
| `OWNER_NAME` | var (`wrangler.toml`) | display name for the account owner |
| `TAVILY_API_KEY` | secret | optional — enables `web_search` for the staff |
| `CF_BR_TOKEN` | secret | optional — Cloudflare API token (Browser Rendering) for `browser_visit` |
| `CF_BR_ACCOUNT` | var (`wrangler.toml`) | your Cloudflare account id, required alongside `CF_BR_TOKEN` |
| `FS` | R2 binding | the filesystem bucket |

Edit `DEFAULT_STAFF` in `src/index.mjs` to name your own team. The bios are shown in the UI *and*
are worth writing as job descriptions — the agents can read them.

## Status: early, and moving fast

Honest inventory, so nobody is surprised:

- **Working:** R2 filesystem over MCP and REST, hourly heartbeat, activity feeds, screenshots,
  the three-pane app, the floor view, demo mode, email+password auth, claim verification, the
  staff runner (cron + wake-on-send), staff web search / fetch / browser with a watchable
  monitor, delegation between staffers, and per-tenant isolation with an enforced 1-day trial.
- **Not there yet:** one model endpoint for the whole staff rather than per-staffer models; no
  payments — "upgrade" is a plan string the operator sets via `/auth/register`; no rate limiting
  beyond the trial cap; within one namespace anyone with a token can read any thread; no
  automated test suite yet.
- **Expect breaking changes.** Pre-1.0, routes and storage shapes can move.

Issues and PRs welcome, especially on the verification gate — it is the piece with the most room
to get sharper.

Prior art worth a nod: xAI's companion apps showed that a staffer you can watch and talk to reads
very differently from a log file. Staffroom takes that framing somewhere else — a team you host
yourself, whose claims get checked.

## License

MIT — see [LICENSE](LICENSE).
