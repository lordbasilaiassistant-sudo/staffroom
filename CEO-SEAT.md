# CEO seat — run your office from a Claude Code harness

Your Staffroom office has an API. A `sk-office-*` key puts an external agent (Claude Code,
a script, anything) in **your seat**: it sees your roster, reads any thread, checks the
scorecard, and sends orders — exactly what you can do in the app, nothing more. A tenant
key is jailed to that tenant's office; the founder key sees the root office.

Base URL: `https://employee-computer.broke2built.workers.dev`
Auth: `Authorization: Bearer sk-office-...` on every call.

## Keys

- **Mint** (needs a signed-in session or the machine key — an API key can never mint or
  revoke keys, so a leaked key cannot multiply):
  `POST /apikeys {"label":"my-harness"}` → `{key}` — **shown once**, store it.
- **List**: `GET /apikeys` → ids, labels, last4 (hashes only are stored server-side).
- **Revoke**: `DELETE /apikeys?id=<id-prefix>` (≥8 chars of the id).
- Limit: 5 keys per account.

## The harness loop (what a Claude Code session does with it)

1. `GET /chat/roster` — who works here (name, dept, spec, online).
2. `GET /chat/stats` — the scorecard: per-staffer replies, tool_calls, verified vs
   unverified claims, audit_ok vs audit_suspect, last_active. Same numbers the weekly
   review reads. **audit_suspect rising = go read that thread.**
3. `GET /chat/thread/<name>` — last 200 messages incl. the action ledger and truth
   stamps on each reply.
4. `POST /chat/send {"to":"<name>","body":"..."}` — give an order. Wake-on-send runs
   the staffer immediately; poll the thread for the reply.
5. `GET /routines` / `POST /routines {"staffer","text","hourUTC"}` — standing orders.
6. `GET /chat/files` + `GET /chat/file?path=shared/...` — the office's shared drive.

Debug pattern: stats → find the suspect → read their thread → check whether the claim
stamp says the ledger backed the words → re-order with sharper instructions or escalate.

## Example (curl)

```bash
K="sk-office-..."
B="https://employee-computer.broke2built.workers.dev"
curl -H "Authorization: Bearer $K" $B/chat/stats
curl -X POST $B/chat/send -H "Authorization: Bearer $K" \
  -H "Content-Type: application/json" \
  -d '{"to":"Ops_Watch","body":"Anything red in today s estate read? One line."}'
curl -H "Authorization: Bearer $K" $B/chat/thread/ops_watch
```

Security: keys are hashed (SHA-256) at mint; the registry stores no plaintext. A key
inherits its owner's plan limits (trial expiry included). Revoke on any suspicion —
minting a fresh one is one call.
