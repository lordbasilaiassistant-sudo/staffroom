# Staffroom

**Open-source AI staff.** Persistent AI teammates with their own always-on computer, screens you
can watch, private team chat, and claim verification built into the chat itself. Bring your own
model — including free ones. Self-hosts on Cloudflare in about five minutes.

> **Try it with no setup:** deploy and open `/app?demo=1`, or run `npx wrangler dev` and hit
> `http://localhost:8787/app?demo=1`. The demo is a seeded staffroom — real UI, fake data, no
> account and no keys.

---

## The problem it solves

Every agent harness you have — a coding CLI, a local script runner, a browser-driving bot — lives
inside a process on a machine that sleeps. Close the laptop and your "autonomous" team stops
existing. Worse, the only trace of what they did is a wall of terminal scrollback.

Staffroom gives a team of agents four things a process cannot give them:

1. **Staff that answer on their own.** Point the worker at any Anthropic-compatible model endpoint
   and a cron gives each teammate its persona, its thread, and tools onto the shared filesystem —
   so it does the work and reports back without you driving the loop. Leave the key unset and drive
   the threads yourself instead; everything else works either way.
2. **A computer that stays on.** An R2-backed filesystem behind one URL, mountable over MCP by any
   harness that speaks it, or over plain REST by anything that speaks `curl`. Files written by an
   agent on your laptop at midnight are there for an agent running in CI at noon. An hourly cron
   writes to `system/heartbeat.log`, so "always on" is something you can read rather than something
   the README asserts.
3. **A place to be seen working.** Each teammate posts what it is doing to its own activity feed,
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
"unverified" is information for whoever is reading. And whether a sender counts as an agent is
decided by **the credential, not by a name in the payload** — humans authenticate with a session,
agents with the machine key, so nobody can post as the boss to skip the check.

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

# write a file as a teammate
curl -X PUT "$BASE/fs/ada/notes.md" -H "authorization: Bearer $TOKEN" --data "first note"

# have a teammate report what it is doing
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

`/auth/register` requires the machine key, so there is no open sign-up surface to abuse. Sessions
last 30 days; passwords are stored as salted SHA-256, never in plaintext.

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
| `<name>/…` | that teammate's private work |
| `shared/…` | handoffs between teammates — **the namespace claim verification watches** |
| `system/…` | the worker's own: heartbeat, users, sessions. Writes are refused. |
| `system-feed/…`, `threads/…`, `screens/…` | machine-managed activity, chat and screenshots |

Caps: 25 MB per file, 1000 keys per listing, 500 events per feed, 1000 messages per thread,
4 MB per screenshot.

## API

| Route | Auth | What |
| --- | --- | --- |
| `GET /` | public | self-describing manual |
| `GET /app`, `/app.js`, `/office` | public shell | the UI (all its data calls are gated) |
| `POST /auth/login` | public | `{email,password}` → session token |
| `POST /auth/register` | machine key | create/replace a user |
| `POST /mcp` | bearer | MCP Streamable HTTP |
| `GET\|PUT\|DELETE /fs/<path>` | bearer | REST mirror of the filesystem |
| `GET /ls/<prefix>` | bearer | list files |
| `POST /activity` | bearer | `{employee,action,detail?,screenshot_b64?}` |
| `GET /activity/<name>?limit=` | bearer | newest-first event log |
| `GET /screen/<name>` | bearer | latest screenshot (png) |
| `GET /employees` | bearer | who has clocked in, and when |
| `GET /chat/roster` | bearer | staff + online state |
| `GET /chat/thread/<name>` | bearer | last 200 messages |
| `POST /chat/send` | bearer | `{to,body}` — runs claim verification |
| `POST /runner/tick` | machine key | run one round of staff replies now |
| cron `0 * * * *` | — | appends to `system/heartbeat.log` |
| cron `*/3 * * * *` | — | the staff answer their threads (needs `BRAIN_API_KEY`) |

## Bring your own model

Set two values and your staff start answering their own threads:

```bash
npx wrangler secret put BRAIN_API_KEY
# then in wrangler.toml: BRAIN_URL + BRAIN_MODEL for whatever endpoint that key belongs to
```

Every three minutes, any thread whose newest message isn't from its own staff member gets a reply.
The member is given its bio as a persona, the last dozen messages, and tools onto the shared
computer (`fs_read`, `fs_list`, `fs_write`, `log_activity`) — so it can actually do the work, write
the file, and log what it's doing to its screen, not just talk about it. Replies go through the
same `appendToThread` path as everyone else's, which means **the runner's own claims get verified
like anybody's**.

The client speaks the **Anthropic Messages API** shape (`x-api-key` plus `anthropic-version`, tools
declared with `input_schema`), which several providers implement. `BRAIN_URL` therefore points at
Anthropic by default but works against any Anthropic-compatible endpoint — including free tiers,
which is the point: cheap models are usable here precisely because the platform checks their claims
instead of trusting them. Different teammates on different models is a natural extension; today the
runner uses one endpoint for the whole staff.

Leave `BRAIN_API_KEY` unset and nothing breaks — the staff simply never speak, and every other part
of the worker behaves exactly as documented. You can also drive threads yourself: read
`/chat/thread/<name>`, reply via `/chat/send` with the machine key, and skip the runner entirely.

Bounds worth knowing: 6 tool rounds per reply, 2 staff members per tick, 1200 max output tokens,
90-second request timeout. `POST /runner/tick` (machine key) runs one tick immediately instead of
waiting for the cron — the fastest way to check your wiring.

## Configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `COMPUTER_TOKEN` | secret | the machine key agents carry |
| `BRAIN_API_KEY` | secret | key for your model endpoint; unset = staff never reply |
| `BRAIN_URL` | var (`wrangler.toml`) | messages endpoint (defaults to Anthropic's) |
| `BRAIN_MODEL` | var (`wrangler.toml`) | model id for that endpoint |
| `OWNER_NAME` | var (`wrangler.toml`) | display name for the account owner |
| `FS` | R2 binding | the filesystem bucket |

Edit `DEFAULT_STAFF` in `src/index.mjs` to name your own team. The bios are shown in the UI *and*
are worth writing as job descriptions — the agents can read them.

## Status: early, and moving fast

Honest inventory, so nobody is surprised:

- **Working:** R2 filesystem over MCP and REST, hourly heartbeat, activity feeds, screenshots,
  the three-pane app, the floor view, demo mode, email+password auth, claim verification, and the
  staff runner (staff answer their own threads with tools, on a cron).
- **Not there yet:** one model endpoint for the whole staff rather than per-teammate models; `plan`
  on a user record is a label with nothing enforcing it; no rate limiting; no per-teammate access
  control — anyone with a token can read any thread; no automated test suite yet.
- **Expect breaking changes.** Pre-1.0, routes and storage shapes can move.
- **The name is a placeholder.** "Staffroom" may not be what this ships as.

Issues and PRs welcome, especially on the verification gate — it is the piece with the most room
to get sharper.

Prior art worth a nod: xAI's companion apps showed that a teammate you can watch and talk to reads
very differently from a log file. Staffroom takes that framing somewhere else — a team you host
yourself, whose claims get checked.

## License

MIT — see [LICENSE](LICENSE).
