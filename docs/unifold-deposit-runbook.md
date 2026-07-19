# Unifold deposit runbook: prove the live flow with ~4 test USDC

Goal: demonstrate the real end-to-end deposit path — provision a per-user
Unifold deposit address, send the team's ~4 USDC (Unifold TEST funds) on Base to
it, and watch the in-app balance increase. This document never contains secret
values; replace every `<PLACEHOLDER>` locally and never commit them.

## 1. Local environment (never commit)

Create `crypto/unifold-demo/server/.env` (already gitignored — keep it that way):

```dotenv
UNIFOLD_SECRET_KEY=sk_test_<YOUR_TEST_KEY>
TREASURY_ACCOUNT_ID=ta_<YOUR_TREASURY_ACCOUNT>
CRYPTO_SERVICE_TOKEN=<RANDOM_SHARED_SECRET_AT_LEAST_32_CHARS>
# Strongly recommended: lets the webhook credit deposits in real time.
UNIFOLD_WEBHOOK_SECRET=whsec_<YOUR_WEBHOOK_SECRET>
```

Notes: `CRYPTO_SERVICE_TOKEN` must be ≥ 32 characters or the service refuses to
boot. If you have no webhook secret yet, `npm run setup:webhook` can provision
an endpoint, or skip it and rely on polling (step 5).

## 2. Start the custody service and point the main server at it

```bash
cd crypto/unifold-demo/server
npm install
npm run dev        # (or: npm run build && npm start) — listens on :8787
```

On the main server, set `CRYPTO_API_URL=http://localhost:8787` and the exact
same `CRYPTO_SERVICE_TOKEN` value, then restart it. `GET :8787/health` should
return `{"ok":true}`.

## 3. Provision the deposit address

Either tap "Add funds" in the app, or call the custody service directly:

```bash
curl -s -X POST http://localhost:8787/users/register \
  -H "Authorization: Bearer $CRYPTO_SERVICE_TOKEN" \
  -H "Content-Type: application/json" -d '{"externalUserId":"demo-user-1"}'

curl -s -X POST http://localhost:8787/add-funds \
  -H "Authorization: Bearer $CRYPTO_SERVICE_TOKEN" \
  -H "Content-Type: application/json" -d '{"externalUserId":"demo-user-1"}'
```

The response contains `treasuryAddress` and `depositAddresses` (one entry per
supported source chain). Use the `address` of the `"chain_type": "ethereum"`
entry — that is the Base deposit address for this user.

## 4. Send the test USDC

From a wallet the team controls, send ~4 USDC **on Base** to that deposit
address. Unifold routes it to the treasury tagged with the user's
`external_user_id`.

## 5. Credit and verify

- With `UNIFOLD_WEBHOOK_SECRET` set, the `deposit.direct_execution.completed`
  webhook credits the balance automatically once the deposit completes.
- Without it (or to force a check), poll:

```bash
curl -s -X POST http://localhost:8787/deposits/refresh \
  -H "Authorization: Bearer $CRYPTO_SERVICE_TOKEN" \
  -H "Content-Type: application/json" -d '{"externalUserId":"demo-user-1"}'
```

Then confirm the balance increased (USDC has 6 decimals; 4 USDC = `4000000`):

```bash
curl -s http://localhost:8787/users/demo-user-1 \
  -H "Authorization: Bearer $CRYPTO_SERVICE_TOKEN"
```

The in-app wallet balance should show the same increase.

## Troubleshooting

- **Webhook secret unset** — the service logs a warning at boot and rejects all
  webhooks; deposits still credit via `POST /deposits/refresh` (polling), just
  not in real time.
- **Deposit not crediting** — a deposit only counts if it matches the
  `ownedDeposit()` tuple in `deposits.ts`: a succeeded `deposit` execution to
  destination chain `ethereum`/`8453` (Base), destination token = Base USDC
  (`USDC_BASE_TOKEN_ADDRESS` in `config.ts`), recipient = the treasury address.
  `addFunds` provisions addresses with exactly this tuple, so a mismatch usually
  means the funds were sent on the wrong chain or with the wrong token.
- **401 from the custody service** — the `Authorization: Bearer` token must
  exactly match `CRYPTO_SERVICE_TOKEN` (also on the main server).
- Deposits below Unifold's minimum, or still in flight, show up only after the
  execution reaches `succeeded`; re-run the refresh poll after a minute.
