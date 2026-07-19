# Handoff: Tomo Yard — Unifold / staking / ledger hardening

You are a fresh Claude Code session picking up a scoped hardening task on **Tomo Yard**
(a React Native / Expo app + a small server + a standalone Unifold "crypto" custody
service). This document is your entire briefing — you have no prior conversation. Read it
fully, then **self-govern**: verify the current state, decide scope within the guardrails
below, implement, verify, and report. Ask the human only for the few decisions explicitly
marked as theirs.

---

## 0. Mission

Fix a set of correctness / money-safety issues in the USDC staking + wallet system, at a
level appropriate for a **hackathon demo that also wants to be presentable to Unifold's
engineers** — not a full production custody rewrite. Prioritize the things that (a) go
wrong in the *normal* demo flow and (b) are cheap. Consciously defer crash-window /
concurrency / hostile-input hardening unless it's trivial.

**The single most important rule:** the findings below were discovered against an *older*
snapshot of this code. The repo has since been through a large refactor (`Auth0, Atlas
crypto` — the crypto service moved to MongoDB, gained a `CRYPTO_SERVICE_TOKEN`, gained
several feature-gates). **Do not trust the line numbers or assume a bug still exists.
Re-verify every finding against the current code before you change anything.** Some are
likely already fixed; report those as "already addressed" rather than touching them.

---

## 1. Operating rules (how to self-govern)

- **Orient first (see §7 checklist).** Establish current ground truth before planning.
- **Maintain a todo list** (TodoWrite) and work through it.
- **Work on a branch.** Do not commit to `main`. Small, logically-scoped commits. Use the
  repo's commit-message convention (co-author trailer). **Do not push and do not open a PR
  unless the human asks.**
- **Verify every non-trivial change end-to-end** (see §6). A change to product code that
  you can't observe working is not done.
- **You have authority to:** re-verify findings, edit app/server/custody source, add or
  adjust tests, delete redundant/broken code paths, refactor for the fixes, run the app
  and servers locally, run test suites.
- **Stop and ask the human before:** enabling crypto in any deployed environment, moving
  real money, changing Terraform / Key Vault / infra to flip `crypto_enabled`, deleting a
  whole feature the human might still want, or any action that's outward-facing or hard to
  reverse. Also ask before the two decisions marked **[HUMAN DECISION]** below.
- **Never** commit secrets or `.env` files (`.gitignore` already excludes them; keep it
  that way). Never paste a real `sk_live_…` / `pk_live_…` / treasury id anywhere.
- **Follow `AGENTS.md`:** Expo v57 changed a lot — read the versioned docs
  (https://docs.expo.dev/versions/v57.0.0/) before writing any React Native code.

---

## 2. What the app is (product context)

Tomo Yard is a "prove you actually hung out" social app. Friends plan a **hangout**, meet
in person, and prove attendance by taking a group **photo** and tapping phones **(NFC)**
pairwise. Confirmed attendance earns social currency (**vibe → acorns**, non-cashable game
money). Separately, a hangout can carry a **real USDC stake** (a "flake-tax"): everyone
stakes, no-shows forfeit their stake to the friends who showed. There's also a plain
**wallet** (add funds / cash out real USDC).

Two currencies, do not confuse them:
- **acorns / vibe** — cosmetic game currency. Holiday/birthday bonuses (2×) live here and
  are fine.
- **USDC** — real money via Unifold. This is what the fixes are about.

---

## 3. System map (three layers)

1. **Client** — Expo/React Native app in `src/`. Wallet + staking UI lives in
   `src/screens/DepositScreen.tsx`, `src/screens/HangoutDetailScreen.tsx`,
   `src/screens/NewHangoutScreen.tsx`; API client in `src/api.ts`; money helpers in
   `src/money.ts`; types in `src/types.ts`.

2. **Main server** — `server/index.js` (Express + better-sqlite3). Owns hangouts, friends,
   NFC confirm, and the `/wallet/*` + `/hangouts/:id/{stake,settle,end,confirm}` endpoints.
   It never holds the Unifold key; it proxies money operations through
   `server/crypto.js` to the custody service, using a `CRYPTO_SERVICE_TOKEN` bearer and
   mapping each user to `external_user_id = ty_<username>`.

3. **Custody service** — `custody/` (TypeScript). The only thing that
   talks to Unifold. Holds all USDC in **one treasury**; per-user balances are ledger
   claims (Mongo in prod via `mongoStore.ts`, in-memory/JSON via `runtimeStore.ts` in
   dev). Key files: `addFunds.ts`, `deposits.ts`, `withdraw.ts`, `webhooks.ts`,
   `events.ts` (flake-tax settlement), `adjust.ts`, `grant.ts`, `catalog.ts`,
   `config.ts`, `index.ts` (routes), `unifold.ts` (SDK client).

**Money model (the invariant that explains everything):** omnibus treasury + internal
ledger. The blockchain is touched **only** at deposit-in and cash-out. Grants, stakes,
settlement are internal ledger arithmetic in USDC base units (6 decimals, BigInt-on-
strings). **Grants and any treasury-funded bonus mint *unbacked* balance** — this is the
core solvency concern and the reason bonuses are contentious (see Fix B1).

**Gating / current prod state (verify, don't assume):**
- Crypto is **OFF in the deployed app**: Terraform `crypto_enabled=false`, main app has no
  `CRYPTO_API_URL`, no custody artifact deployed, `/ready` times out. `GET /wallet`
  returns `{enabled:false}` and the wallet UI doesn't render. Keep this default safe —
  nothing you do should make the gated-off deployment start moving money.
- Feature-gates that already exist (confirm in `config.ts` / `adjust.ts` / `grant.ts` /
  `events.ts`): `ENABLE_RAW_BALANCE_ADJUSTMENTS` (guards `/adjust`),
  `ENABLE_RECURRING_REAL_USDC_GRANTS` (guards `/grant`),
  `ENABLE_TREASURY_FUNDED_EVENT_BONUSES` (guards the holiday USDC bonus),
  `UNIFOLD_LIVE_MODE` (derived from `sk_live_` prefix).
- The deposit-address call in `addFunds.ts` is **wired but never executed against real
  Unifold** — self-documented as untested. Treat it as unproven.

---

## 4. The fixes (re-verify each; priorities in brackets)

For each: confirm it still applies in the current code (grep for the function, read it),
then fix, then verify. If it's already handled, say so and move on.

### A1 — [P0, demo-critical] Settlement robs stakers who showed up but didn't NFC-tap
**Symptom:** the manual settle path calls the custody `settle` **without checking present
stakers in first**, so anyone still in `staked` state (classically the photo-taker, who
proved presence by taking the photo, or someone whose partner's tap failed) is treated as
a **flaker and loses their deposit**. A separate "end early" path already does the right
thing (checks in present stakers, requires a photo as proof, then settles). Two paths,
opposite financial outcomes for the same attendance.
**Where (pre-refactor names — re-locate):** `server/index.js` `POST /hangouts/:id/settle`
vs `POST /hangouts/:id/end`; attendance from `attendeeIdSet()` (photo taker + confirmed
pairs); check-in happens in `POST /hangouts/:id/confirm`.
**Fix approach:** eliminate the divergence. Preferred: **delete `/settle` and route all
settlement through `/end`** (which check-ins present stakers, requires photo proof, mirrors
results, marks completion) — one deletion also removes the `/settle`-vs-`/end` race and a
null-deref hang when crypto is disabled. If `/settle` must stay, make it check in present
stakers exactly like `/end` first. Also remove the duplicate client button (see A2).
**Acceptance:** a staker who showed (photo taker) never loses their stake at settlement; a
genuine no-show does. One settlement path. Verified against a local run.

### A2 — [P0/P1] Duplicate settlement UI on the client
**Symptom:** `HangoutDetailScreen.tsx` can show *both* "Settle the pool" and "End the
hangout" at once — two ways to settle, sequential taps hit an already-settled pool.
**Fix:** collapse to one settlement action, consistent with A1 (keep the "end / someone
flaked" flow; remove the redundant settle button). Ensure a busy-guard prevents double
submit (verify one already exists).
**Acceptance:** one clear settlement control; can't double-settle from the UI.

### A5 — [P1, cheap correctness — confirmed present in current code] Deposit credit-path asymmetry
**Symptom:** the webhook and the poll credit deposits from **different provider fields**
and validate differently, converging on the same `deposit:<execId>` idempotency key:
- poll (`deposits.ts`) uses `destination_amount_base_unit` and requires
  `recipient_address == treasury`;
- webhook (`webhooks.ts`) uses `details.destination_amount ?? execution.amount` and matches
  `treasury_account_id == TREASURY_ACCOUNT_ID`.
Risks: (1) the webhook accepts `"0"` (poll requires `>0`) — a `"0"` credit still records
the reference and **suppresses a later correct credit**; (2) both assume the webhook object
`id` equals the poll execution `id` without asserting it — if they differ, **double
credit**; (3) the amount fields could differ (source vs destination, fee-inclusive).
**Fix:** make both paths read the same canonical destination-amount field, reject
non-positive amounts identically, and assert/normalize the execution id used for the
reference. Add/adjust a unit test.
**Acceptance:** identical crediting semantics on both paths; a `"0"` event credits nothing
and does not poison the reference; unit test covers webhook+poll convergence on one
execution.

### A6 — [P1, likely already largely done] Custody service trust boundary
**Symptom (pre-refactor):** the custody service had no auth on money routes. The refactor
added `CRYPTO_SERVICE_TOKEN`. **Verify:** every money/ledger route (except the
signature-verified `/webhooks/unifold`) requires the bearer token; `/adjust` and `/grant`
are gated off in prod; the service is not internet-reachable in the intended deployment.
**Fix (only if gaps remain):** enforce the token on any unguarded route; otherwise document
"verified, no change." This is mostly a verification task.
**Acceptance:** no unauthenticated route can move or mint a balance in prod config.

### A3 — [P2, only if the demo moves real USDC] Ambiguous cash-out failure loses money
**Symptom:** on withdraw, the balance is debited, then `outboundTransfers.create` is
called; on *any* thrown error the balance is rolled back — but a response timeout can throw
*after* Unifold already sent the funds → money left the treasury, balance restored, no
record. Re-check current `withdraw.ts` (refactored).
**Fix:** record the transfer attempt before assuming it didn't happen; on ambiguous
errors, do not blind-rollback — mark it pending and reconcile via status poll/webhook.
**Acceptance:** an ambiguous create failure cannot both refund the user and send the funds;
every initiated transfer is recorded and reconcilable.

### A4 — [P2, only if the demo moves real USDC] Failed-withdrawal refund is pull-only
**Symptom:** a failed transfer only refunds if a client happens to poll
`/withdrawals/:id`; if `UNIFOLD_WEBHOOK_SECRET` is unset the webhook rejects everything, so
a failed cash-out may never refund. No background reconciliation.
**Fix (cheap):** ensure the webhook secret is configured for any real-money demo.
**Fix (real):** a small reconciliation sweep that lists Unifold transfers by
`external_user_id`, matches to local records, and refunds/alerts on drift. This also closes
several deferred crash-window items and the auditability gap (see D1).
**Acceptance:** a failed transfer always refunds without requiring a client to poll.

### B1 — [HUMAN DECISION] Treasury-funded holiday bonus mints unbacked cashable USDC
**Symptom:** the flake-tax settlement can pay a holiday/birthday **multiplier bonus** in
USDC that no deposit backs (net-new treasury money). Current code gates it behind
`ENABLE_TREASURY_FUNDED_EVENT_BONUSES` (off by default), **but** the main server sets the
multiplier to `15000` (1.5×) on 2× bonus days — which means a staked hangout on a holiday
would **fail** unless that opt-in is set. So today it's both a solvency concern and an
inconsistency.
**Recommended fix:** remove the USDC multiplier bonus entirely — clamp the multiplier the
main server sends to `10000` (1×) so cashable balance is only ever backed by real deposits
+ redistributed stakes, and keep the 2× holiday reward on **acorns/vibe** (where it already
exists). **Confirm with the human before changing product behavior.**
**Acceptance:** no code path mints cashable USDC from a bonus; holiday *staked* hangouts
still work (don't error); the holiday 2× still applies to acorns.

### C — [P2, optional] Make a real self-deposit actually work (if the human wants to demo it)
The deposit flow exists (`Add funds` → custody provisions a per-user Unifold deposit
address that funnels to the shared treasury → user sends USDC on Base from their own wallet
→ credited via webhook or the `/wallet/refresh` poll). But the `POST
/v1/deposit_addresses` call in `addFunds.ts` is a **raw, hand-built, never-tested** fetch.
**Fix:** with a Unifold **test** key + funded test treasury (human supplies these; never
commit them), run `addFunds` once against real Unifold, confirm the request/response shape,
fix any field mismatches, and confirm an arrived deposit satisfies `ownedDeposit()` in
`deposits.ts` so it credits. **This is the only unproven seam** — everything downstream is
unit-tested. Do not turn on prod; use a local/dev config.
**Acceptance:** a real test-USDC send to the provisioned address credits the in-app balance
locally, proven end-to-end (not mocked).

### D1 — [P3, structural — only if this graduates past a demo] Reconciliation ledger
The ledger can't be independently reconstructed/reconciled (running balance; references
stored without amounts; grants track only last period), and there's a two-write idempotency
window on some paths. The real fix is an append-only, amount-bearing movement journal
(`{reference, deltaUnits, kind, at}`) so `balance == Σ(movements)` and each external kind
cross-checks against Unifold. **Do not build this for a demo** unless the human asks — but
mention it, because it closes A3/A4/A5 and several deferred crash-window items at once.

**Deliberately deferred (do not fix for a demo unless trivial):** pure crash-window
desyncs (orphaned stake on create, orphaned transfer before record, mid-settle crash),
`completed→failed` refund double-spend / no event-dedup, under-validated non-EVM withdraw
destinations, and code hygiene (inconsistent balance floors, `multiplierBps` not
re-validated on load, dead source-chain config). List them in your report as "known,
accepted."

---

## 5. Suggested order of work

1. Orientation checklist (§7). Produce a short "what still applies" note.
2. A1 + A2 together (highest value, self-contained, no real money needed).
3. A5 (cheap correctness, confirmed live).
4. A6 verification.
5. B1 — get the human's decision, then implement.
6. A3 / A4 / C only if the human confirms the demo will move real USDC.
7. D1 only if asked.

---

## 6. Verification protocol (do this per fix, not just at the end)

- **Run it.** Prefer the repo's `/run` and `/verify` skills if available. Otherwise:
  - Main server: `cd server && npm install && node index.js` (listens on `:4000`, SQLite in
    `server/data/`).
  - Custody service (for staking/wallet): `cd custody && npm install &&
    cp .env.example .env` then fill dev values and `npm start` (`:8787`). Point the main
    server's `CRYPTO_API_URL` at it and set a matching `CRYPTO_SERVICE_TOKEN` (≥32 chars).
  - App: default server is editable on the sign-in screen; point it at your local main
    server.
- **Drive the actual flow** you changed (create staked hangout → stake → confirm/photo →
  settle/end; or add-funds → refresh; or withdraw). Observe balances and settlement
  outcomes, don't just typecheck.
- **Tests.** Run and extend: `server/crypto.test.js`, `server/test-crypto/*.integration.test.js`,
  and `custody/test/*`. `tsc` must stay clean in the custody service.
- For client changes, follow `AGENTS.md` (Expo v57 docs) and confirm the screen renders /
  behaves in the app, not just that it compiles.

---

## 7. First-15-minutes orientation checklist

- [ ] Read `AGENTS.md` (Expo v57 constraint).
- [ ] `git log --oneline -15` and `git status` — know where HEAD is and that the tree is clean.
- [ ] Grep for the endpoints A1 targets: `grep -n "hangouts/:id/settle\|hangouts/:id/end\|attendeeIdSet\|cryptoApi.settle\|cryptoApi.checkin" server/index.js`. Confirm they still exist and read them.
- [ ] Read `server/crypto.js` (gating: `enabled()`/`ready()`, `CRYPTO_SERVICE_TOKEN`).
- [ ] Read the custody `config.ts` to learn the current feature-gate flags.
- [ ] Read `deposits.ts` + `webhooks.ts` to confirm A5 still applies.
- [ ] Run the custody test suite to get a green baseline before touching anything.
- [ ] Write a short "still-applies vs already-fixed" summary and your planned scope, then proceed.

---

## 8. Definition of done

- Each fix you took on is implemented, verified end-to-end (with evidence of the flow
  working, not just tests), and covered by a test where practical.
- Fixes you skipped are listed with a one-line reason (already fixed / deferred / needs a
  human decision).
- The gated-off production default remains safe (no path makes the deployed app move money).
- No secrets committed. Work is on a branch. A concise summary of what changed, what was
  verified, and what remains is written for the human. Do not push or open a PR unless asked.

---

## 9. Ground truth to carry (facts established before this handoff)

- Repo advanced through an `Auth0, Atlas crypto` refactor: custody store is now MongoDB
  (`mongoStore.ts`) + runtime/JSON (`runtimeStore.ts`) with transactional idempotent
  reference claims; `CRYPTO_SERVICE_TOKEN` bearer auth exists between main and custody;
  `/adjust` and `/grant` are gated off in prod. **Re-verify all of this.**
- Deposit model: the user does **not** expose their own wallet key. Unifold provisions a
  per-user deposit address (tagged by `external_user_id`) that funnels into one shared
  treasury; the user sends to it from a wallet they already control. The only user-typed
  address in the system is the **cash-out** destination (outbound).
- Crypto is gated OFF in the deployed app and the live Unifold deposit/cash-out calls have
  never been executed. Anything involving real money is unproven and must be treated as
  such.
