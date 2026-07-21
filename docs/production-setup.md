# Production setup: MongoDB Atlas and crypto

This is the operator runbook for the hackathon deployment. It deliberately never
contains secret values. Replace every `<PLACEHOLDER>` locally or in the relevant
dashboard; do not paste secrets into chat, commit them, or put them in an
`EXPO_PUBLIC_*` variable.

Authentication is served by the main API itself (self-hosted username/password),
so there is no external identity provider to configure.

The safest rollout order is:

1. authorize the setup tools;
2. configure Atlas;
3. provision and verify the crypto service while the public feature gate is off;
4. enable `CRYPTO_API_URL` on the main API last;
5. run the acceptance checks, then remove temporary access.

Removing `CRYPTO_API_URL` is the immediate crypto kill switch. Keep it unset until
the crypto service, Atlas persistence, and server-to-server authentication pass.

### Provisioned-state snapshot (19 July 2026)

The following public configuration has already been created. This is an inventory,
not evidence that every feature has passed its production smoke test:

- Atlas project `Tomo Yard Hackathon` (`6a5c8b960ecad0390bf7a9a7`) contains the
  M0 cluster `tomo-yard`. Database user `tomo-yard-crypto` has only `readWrite` on
  `ht6_crypto`.
- Azure Key Vault `ht6tomoyardkv4831` exists with the four required secret names.
  Secret values are intentionally not recorded here.
- `AZURE_CRYPTO_WEBAPP_PUBLISH_PROFILE` is set and was last verified at
  `2026-07-19T09:00:43Z`; its value was never written to the repo.
- Phase-one Terraform applied three creates and one in-place update with no
  destroys and `crypto_enabled = false`. The running, HTTPS-only
  `ht6-tomoyard-crypto` App Service has a system-assigned identity, `/ready` health
  path, and the Key Vault Secrets User role. All four Key Vault references report
  `Resolved`.
- The main API serves self-hosted username/password auth and has no
  `CRYPTO_API_URL`.
- Atlas contains all 25 exact possible-outbound IPv4 `/32` entries for the crypto
  App Service, plus one pre-existing temporary workstation entry. No broad entry
  was added. HTTPS `/ready` currently times out because no crypto artifact has been
  deployed yet (HTTP redirects to HTTPS). Deploy and pass `/ready` before setting
  `crypto_enabled = true`.

## What the user needs to do

The lowest-hassle handoff uses browser/device login. It does not require sharing an
Azure or Atlas password.

### 1. Azure: approve one CLI login

Install the [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-windows),
then run this in the shared terminal:

```powershell
$env:AZURE_CONFIG_DIR = Join-Path $env:TEMP 'ht6-azure-cli'
az login --use-device-code
az account set --subscription '<AZURE_SUBSCRIPTION_ID>'
az account show --query '{subscription:name, tenant:tenantId}' -o table
```

The account needs resource-group-scoped access to create the crypto service and
permission to change settings on the existing `ht6-tomoyard` App Service. Avoid
subscription-wide Owner access. Interactive Azure login supports MFA and is the
[recommended CLI flow](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli-interactively).

### 2. Authentication: nothing to approve

Authentication is self-hosted by the main API (username/password, scrypt-hashed,
with a per-account opaque bearer token). There is no external identity provider,
CLI login, or tenant to configure. Accounts and their credentials live in the
`users` collection in MongoDB Atlas alongside the rest of the application data.

### 3. Atlas: approve project-only access

The dedicated project already exists. For the quickest one-off setup, install the
[Atlas CLI](https://www.mongodb.com/docs/atlas/cli/current/install-atlas-cli/)
and approve its browser login:

```powershell
atlas auth login
atlas auth whoami
```

For tighter access, create an eight-hour project Service Account with only
**Project Owner**, use it for provisioning, then revoke it. Project Owner is broad
inside that one project but does not grant organization-wide access. Atlas
[recommends Service Accounts instead of legacy API keys](https://www.mongodb.com/docs/atlas/configure-api-access/).

### 4. Confirm the local Unifold source file exists

`somevariables.txt` must remain local and ignored. Do not paste its contents into a
ticket, PR, chat, or terminal output. Its three labels map exactly as follows:

| Label in `somevariables.txt` | Production variable | Key Vault secret |
| --- | --- | --- |
| `publishable` | `UNIFOLD_PUBLISHABLE_KEY` | `unifold-publishable-key` |
| `Secret` | `UNIFOLD_SECRET_KEY` | `unifold-secret-key` |
| `ethereum treasury id` | `TREASURY_ACCOUNT_ID` | `treasury-account-id` |

The Atlas SRV URI is the fourth Key Vault secret, `mongodb-uri`. Verify names only:

```powershell
az keyvault secret list --vault-name 'ht6tomoyardkv4831' --query '[].name' -o tsv
```

All three should be present in production even though the current crypto server
does not read the publishable key. Never place the secret key or treasury
credential in the Expo app. Keep live treasury funds and transfer limits small for
the demo.

### 5. Approve GitHub deployment access

The new crypto service deploys through GitHub Actions. Approve the official GitHub
CLI browser flow; do not send a personal access token in chat:

```powershell
gh auth login --hostname github.com --git-protocol https --web --clipboard --skip-ssh-key
gh auth status --hostname github.com
```

The account needs repository write access to set the production secret. Add the
crypto App Service publish profile through the hidden prompt:

```powershell
gh secret set AZURE_CRYPTO_WEBAPP_PUBLISH_PROFILE --repo 'a4ye/ht6-app'
```

GitHub documents the [browser login](https://cli.github.com/manual/gh_auth_login)
and [encrypted Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).
The publish profile is a credential even though it is XML; never commit it.
Authentication is self-hosted, so no public auth-provider build variables are
required by the APK or web workflows.

After these five actions, the coordinator can complete the remaining provisioning.

## Configuration matrix

`EXPO_PUBLIC_*` values are embedded in the app bundle and are **not secrets**.
Everything else below is server-side configuration. Values shown as "same" must be
byte-for-byte identical across the two services. Authentication is self-hosted
(username/password against the main API), so it needs no auth-provider variables.

| Runtime | Variable | Required | Meaning / source |
| --- | --- | --- | --- |
| Main API | `CRYPTO_API_URL` | enable switch | HTTPS origin of the crypto service, with no trailing path |
| Main API | `CRYPTO_SERVICE_TOKEN` | with crypto | Terraform-generated 32+ byte random value; identical on both services |
| Crypto service | `CRYPTO_SERVICE_TOKEN` | yes | Same Terraform-generated value; rejects unauthenticated money requests |
| Crypto service | `MONGODB_URI` | yes | Atlas SRV connection string for the application database user |
| Crypto service | `MONGODB_DB_NAME` | yes | Dedicated database name; Terraform defaults to `ht6_crypto` |
| Crypto service | `CRYPTO_STORE_BACKEND` | yes | Must be `mongodb` in production; Terraform sets it explicitly |
| Crypto service | `UNIFOLD_SECRET_KEY` | yes | `Secret` from `somevariables.txt` |
| Crypto service | `UNIFOLD_PUBLISHABLE_KEY` | requested | `publishable` from `somevariables.txt`; currently retained as deployment configuration only |
| Crypto service | `TREASURY_ACCOUNT_ID` | yes | `ethereum treasury id` from `somevariables.txt` |
| Crypto service | `TREASURY_SOURCE_CHAIN_ID` | yes | `8453` for Base mainnet |
| Crypto service | `UNIFOLD_WEBHOOK_SECRET` | when webhooks are enabled | Signing secret returned during webhook registration |
| Crypto service | `CREDIT_LIMIT_UNITS` | optional | Defaults to `0`; do not allow debt for the demo |
| Crypto service | `CASHOUT_THRESHOLD_UNITS` | optional | Defaults to `20000000` USDC base units |
| Crypto service | `ENABLE_RECURRING_REAL_USDC_GRANTS` | dangerous opt-in | Omit in production; only exact `true` enables automatic real-USDC grants |
| Crypto service | `ENABLE_RAW_BALANCE_ADJUSTMENTS` | dangerous opt-in | Omit in production; only exact `true` exposes the general adjustment route |
| Crypto service | `ENABLE_TREASURY_FUNDED_EVENT_BONUSES` | dangerous opt-in | Omit in production; only exact `true` permits treasury-funded bonus payouts |
| Crypto service | `DATA_DIR` | fallback only | Local fallback storage path; Atlas is the production source of truth |

Azure injects `PORT`; do not treat it as a credential. The four external
credentials are not Terraform variables: they already live in Key Vault and App
Service receives Key Vault references. Never commit `terraform.tfvars`, state,
or `somevariables.txt`. App Service setting changes restart the app,
while
[Key Vault references](https://learn.microsoft.com/en-us/azure/app-service/app-service-key-vault-references)
keep credential values out of App Service and Terraform configuration.

The current non-secret Terraform inputs map as follows:

| Terraform input | Runtime destination | Default |
| --- | --- | --- |
| `crypto_key_vault_name` | Vault used by four Crypto Key Vault references | `ht6tomoyardkv4831` |
| `mongodb_db_name` | Crypto `MONGODB_DB_NAME` | `ht6_crypto` |
| `crypto_enabled` | Controls whether Main receives `CRYPTO_API_URL` | `false` |

`CRYPTO_SERVICE_TOKEN` is generated by Terraform and injected into both services;
it is intentionally not an operator input. That generated server-to-server token
is sensitive and remains in Terraform state, so protect the state file.

The exact production request boundaries are:

| Public/main API | Internal crypto API | Authentication |
| --- | --- | --- |
| `GET /wallet` | `POST /users/register`, then `GET /users/:externalUserId` | Account bearer token to Main; service bearer to Crypto |
| `POST /wallet/add-funds` | `POST /add-funds` | Same two-hop boundary |
| `POST /wallet/refresh` | `POST /deposits/refresh` | Same two-hop boundary |
| `POST /wallet/withdraw` | `POST /withdraw` | Same two-hop boundary plus exactly one `Idempotency-Key` header |
| none | `GET /withdrawals/:withdrawalId` | Service bearer; reconciliation/status endpoint |
| none | `GET /health`, `GET /ready`, `GET /readyz` | Public probes; no business data |
| none | `POST /webhooks/unifold` | Unifold HMAC signature, not the service bearer |

All other crypto business routes sit behind `CRYPTO_SERVICE_TOKEN`. The main API
never receives the MongoDB URI, Unifold key, publishable key, or treasury ID.

## Configure MongoDB Atlas

Atlas is the durable store for everything: the crypto ledger and
event/idempotency data live in `ht6_crypto`, and the main Tomo Yard social data
(users, friends, hangouts, activity weights) lives in the separate `tomoyard`
database on the same cluster. SQLite is fully retired; see
[the SQLite-to-MongoDB migration runbook](sqlite-to-mongodb-migration.md) for
the one-time data cutover.

### 1. Verify the cluster

The `Tomo Yard Hackathon` project (`6a5c8b960ecad0390bf7a9a7`) contains the M0
cluster `tomo-yard`. It is the lowest-hassle hackathon tier. Verify that its Azure
region is acceptable for the crypto App Service in West Europe. Follow Atlas's
[free cluster guide](https://www.mongodb.com/docs/atlas/tutorial/deploy-free-tier-cluster/).

M0 has no managed backups or private endpoints. Use Flex if automatic daily
snapshots are worth the added cost. Atlas documents the
[free-tier limitations](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)
and [Flex backup behavior](https://www.mongodb.com/docs/atlas/backup/cloud-backup/flex-cluster-backup/).

### 2. Verify the application database users

There are two dedicated database users, not Atlas dashboard users:

- `tomo-yard-crypto` has only `readWrite` on `ht6_crypto`. Its password exists
  only inside the Key Vault `mongodb-uri` connection string.
- `tomo-yard-app` has only `readWrite` on `tomoyard` (the main server's social
  data). Its password exists only inside the Key Vault `mongodb-uri-app`
  connection string.

Neither user can read the other's database, so the main server still has no
access to the crypto ledger. Atlas documents the distinction and roles in
[Configure Database Users](https://www.mongodb.com/docs/atlas/security-add-mongodb-users/).

Copy the Node.js `mongodb+srv://` driver URI. Add the database name or keep it in
`MONGODB_DB_NAME`. Percent-encode reserved characters in the username/password.
Never log the URI.

### 3. Allow only the App Services' outbound addresses

After Azure has provisioned the App Services, collect every possible outbound
address from the Terraform outputs. Both apps share one App Service plan, so the
two lists are normally identical — but verify both, because the main server now
also reaches Atlas:

```powershell
terraform -chdir=infra output -json crypto_possible_outbound_ip_addresses
terraform -chdir=infra output -json app_possible_outbound_ip_addresses
```

The direct Azure query is a useful cross-check; use the **possible** list, not only
the addresses observed on the current worker:

```powershell
az webapp show `
  --resource-group 'ht6-tomoyard-rg' `
  --name 'ht6-tomoyard-crypto' `
  --query possibleOutboundIpAddresses -o tsv
```

Add each address to the Atlas project IP access list as an exact `/32`. Azure may
choose any listed address, so adding only the currently observed one is not enough.
Re-check after changing the App Service plan or tier. Do not leave `0.0.0.0/0`; a
temporary local developer address can have a short expiry. See
[Atlas IP access lists](https://www.mongodb.com/docs/atlas/security/ip-access-list/)
and [Azure App Service outbound IP behavior](https://learn.microsoft.com/en-us/azure/app-service/overview-inbound-outbound-ips).

The current allowlist has all 25 App Service `/32` entries plus one temporary
workstation `/32`. Remove the workstation entry after bootstrap. Do not remove any
possible-outbound address while the App Service can still select it.

### 4. Verify persistence without moving money

Start the crypto service and confirm that Atlas contains these collections:

```text
crypto_users
crypto_idempotency
crypto_withdrawals
crypto_events
```

The startup path creates unique indexes for external user IDs, idempotency
references, Unifold transfer IDs, and event IDs, plus query indexes. Check the
indexes in Atlas Data Explorer. Restart the crypto App Service and confirm the same
non-monetary test record is still present. Do not use a deposit, withdrawal, or
webhook-registration command as a connectivity test.

The service must fail closed if `CRYPTO_STORE_BACKEND=mongodb`, `MONGODB_URI`, or
`MONGODB_DB_NAME` is missing. `/health` proves process liveness; `/ready` (and its
alias `/readyz`) returns `200` only after Atlas connects and the indexes exist. Use
readiness plus a persistence read after restart as the acceptance check.

## Deploy and enable crypto on Azure

Production uses a separate `ht6-tomoyard-crypto` service. Unifold and Atlas secrets
belong there, not on the main `ht6-tomoyard` service.

### 1. Provision without enabling the public feature

Keep `CRYPTO_API_URL` absent from the main API before provisioning. From `infra/`,
copy `terraform.tfvars.example` to the ignored `terraform.tfvars`, fill it locally,
then initialize and review the Terraform plan before applying it:

For phase one, explicitly put these public/non-secret values in the ignored file:

```hcl
crypto_key_vault_name = "ht6tomoyardkv4831"
mongodb_db_name       = "ht6_crypto"
crypto_enabled        = false
```

```powershell
$env:ARM_SUBSCRIPTION_ID = '<AZURE_SUBSCRIPTION_ID>'
$cloudflareToken = Read-Host 'Cloudflare API token' -AsSecureString
$env:CLOUDFLARE_API_TOKEN = [System.Net.NetworkCredential]::new('', $cloudflareToken).Password
Remove-Variable cloudflareToken

terraform init
terraform fmt -check
terraform validate
terraform plan
terraform apply
```

This first apply provisions the crypto App Service and generates the shared service
token, but deliberately leaves `CRYPTO_API_URL` absent from the main API. The four
external credentials are resolved at runtime from these exact Key Vault references:

| App setting | Key Vault `ht6tomoyardkv4831` secret |
| --- | --- |
| `MONGODB_URI` | `mongodb-uri` |
| `UNIFOLD_SECRET_KEY` | `unifold-secret-key` |
| `TREASURY_ACCOUNT_ID` | `treasury-account-id` |
| `UNIFOLD_PUBLISHABLE_KEY` | `unifold-publishable-key` |

The crypto App Service's system-assigned managed identity must have only **Key Vault
Secrets User** on that vault. Terraform creates this role assignment; no role is
granted to the main API. RBAC and App Service Key Vault reference resolution can
take a few minutes to converge. Inspect reference status, but never print resolved
values.

The Cloudflare token is required because the existing Terraform configuration also
manages the two production DNS names. Use a narrowly scoped zone token. Clear
`CLOUDFLARE_API_TOKEN` from the session after the apply. The current state backend is
local and contains the generated `CRYPTO_SERVICE_TOKEN`; keep it only on the trusted
workstation with restrictive file permissions. The MongoDB and Unifold values stay
in Key Vault and are not Terraform inputs. Move state to an access-controlled,
encrypted remote backend after the hackathon.

### 2. Configure the two service boundaries

Terraform sets the datastore, Key Vault reference, and server-to-server
settings. In phase one, the main service has only:

```text
CRYPTO_SERVICE_TOKEN=<Terraform-generated server-to-server value>
```

After the first apply:

1. Add **every** `crypto_possible_outbound_ip_addresses` value to the Atlas project
   as an exact `/32` and wait until each entry is active.
2. Download the new crypto App Service publish profile locally and set it through
   the hidden `gh secret set AZURE_CRYPTO_WEBAPP_PUBLISH_PROFILE --repo 'a4ye/ht6-app'`
   prompt. The XML is a credential: never save it in the repo or print it.
3. Trigger the `Deploy crypto service` workflow. It installs, tests, type-checks,
   builds, deploys, then requires `GET /ready` to succeed.
4. Run the non-monetary phase-one acceptance checks below. Do not perform a real
   deposit, grant, stake, withdrawal, or webhook-registration smoke test by default.
5. Change only `crypto_enabled = true`, review the second Terraform plan, and
   apply. Terraform then adds
   `CRYPTO_API_URL=https://ht6-tomoyard-crypto.azurewebsites.net` to the main API.

Azure App Service setting changes restart the app automatically; an explicit
restart is harmless:

```powershell
az webapp restart -g 'ht6-tomoyard-rg' -n 'ht6-tomoyard-crypto'
az webapp restart -g 'ht6-tomoyard-rg' -n 'ht6-tomoyard'
```

List setting **names**, never values, during review:

```powershell
az webapp config appsettings list `
  -g 'ht6-tomoyard-rg' -n 'ht6-tomoyard-crypto' `
  --query '[].name' -o tsv
```

Microsoft documents App Service
[application settings](https://learn.microsoft.com/en-us/azure/app-service/configure-common)
and [log streaming](https://learn.microsoft.com/en-us/azure/app-service/troubleshoot-diagnostic-logs).

The publish-profile secret is required only by the crypto deployment workflow.
Changes under `custody/**` also trigger it. Repository variables
are not a safe substitute for this credential.

### 3. Acceptance checks

Run these in order:

1. `GET https://ht6-tomoyard-crypto.azurewebsites.net/health` returns 2xx and no
   configuration or secret material.
2. `GET https://ht6-tomoyard-crypto.azurewebsites.net/ready` returns 2xx with the
   MongoDB backend ready; a missing/unreachable Atlas configuration returns 503 or
   prevents the service from binding.
3. A protected crypto route called directly without the service token returns
   `401` or `403`.
4. Crypto service startup logs show successful Atlas initialization and never print
   the MongoDB URI, bearer token, or Unifold secret.
5. Restart the crypto service and confirm Atlas-backed state survives.
6. Main API `/health` returns 2xx.
7. An unauthenticated protected main-API route returns `401`; an unknown or malformed
   bearer token also returns `401`; a token issued by register/login succeeds.
8. In a newly built APK, register, sign out, sign back in, and process restart all
   work: the persisted token keeps the session signed in and `/me` validates it. On
   web, the same flow works and the session survives a page reload.
9. With `CRYPTO_API_URL` finally set, an authenticated `/wallet` response reports
   `enabled: true`; the wallet card and stake selector appear in the deployed APK.
10. Stop here for the default production smoke. A real-money deposit, grant, stake,
    cash-out, or webhook registration is **not** a routine health check. If the team
    explicitly approves a capped demo transfer, verify the Atlas record and Unifold
    result before any retry.

Cash-out has one product minimum: `CASHOUT_THRESHOLD_UNITS=20000000`, or 20 USDC at
six decimals. The client creates an 8-128-character `Idempotency-Key`, persists the
entire withdrawal intent locally before sending, and reuses the exact same key and
payload while reconciling an uncertain response. The main API forwards that header;
the crypto service durably reserves/debits once in Atlas and passes the same key to
Unifold. Reusing a key with different user, amount, or destination returns a
conflict. Never "fix" a timeout by generating a new key: retry the original intent
until its terminal state is known.

Leave all three dangerous opt-ins unset. If recurring real-USDC grants are deliberately
enabled for a controlled demo, do not create throwaway production accounts: each
eligible account can consume treasury funds. Reuse one controlled demo account and
keep the treasury balance capped. The same opt-in rule applies to raw balance
adjustments and treasury-funded event bonuses.

## Background music behavior

`Tomo Yard.mp3` is bundled into native and web builds through `expo-audio` at low
volume and loops while the app is active. The visible **Music on/off** switch is
available throughout the app and its preference is persisted in AsyncStorage.

The project owner confirms that `Tomo Yard.mp3` was generated using their Suno
plan and that they hold the rights needed to use and distribute it with this
project.

On Android/iOS, music is foreground-only: it pauses when the app becomes inactive,
does not opt into lock-screen/background playback, respects silent mode, and mixes
with other audio. On `https://app.tomo-together.com`, browser autoplay policy means
the default unmuted preference cannot begin playback until the first pointer, touch,
or keyboard gesture. The toggle itself also unlocks playback. This is expected
browser behavior, not a deployment failure. Test initial gesture unlock, mute
persistence after reload, loop playback, and pause/resume across app lifecycle. See
the exact Expo SDK 57 [`expo-audio` documentation](https://docs.expo.dev/versions/v57.0.0/sdk/audio/).

## Rollback and rotation

### Immediate crypto rollback

Delete the main API's URL setting. This disables the wallet/staking UI without
changing the APK:

```powershell
az webapp config appsettings delete `
  -g 'ht6-tomoyard-rg' -n 'ht6-tomoyard' `
  --setting-names CRYPTO_API_URL
```

Then investigate the crypto service while the main application remains available.
Also set `crypto_enabled = false` in `infra/terraform.tfvars`, review, and apply so
Terraform does not restore the URL on its next run. Do not delete Atlas data or
rotate credentials as the first response.

### Auth rollback

Authentication is served entirely by the main API against the `users` collection.
If a bad deploy breaks sign-in, roll back the server and APK artifacts together;
account rows (username, scrypt hash, salt, token) are unchanged by a rollback, so
existing sessions and passwords keep working once the previous build is restored.

### Atlas backup and rollback

M0 has no managed backup. Before schema/data changes, use `mongodump` and store the
encrypted archive outside the repository, then test `mongorestore` into a scratch
database. MongoDB warns that passwords in command arguments may be visible to other
processes; prefer an interactive prompt or protected config. See
[mongodump](https://www.mongodb.com/docs/database-tools/mongodump/) and
[mongorestore](https://www.mongodb.com/docs/database-tools/mongorestore/).

Use additive migrations. Roll back the application first; restore data only when a
change is incompatible and the restore has been rehearsed.

### Rotate credentials

- **MongoDB:** create a second least-privilege database user, update the Key Vault
  secret (`mongodb-uri` for the crypto service, `mongodb-uri-app` for the main
  server), force a Key Vault reference refresh or restart, verify `/ready` (crypto)
  or `/health` (main), then delete the old user.
- **Crypto service token:** there is no dual-token overlap today. Remove
  `CRYPTO_API_URL`, replace the Terraform-managed `random_password` value so both
  services update together, verify internally, then restore the URL through
  `crypto_enabled = true`.
- **Unifold secret:** create/rotate it in Unifold, update only Key Vault
  `unifold-secret-key`, refresh/restart and run a read-only preflight, then revoke
  the old key. `treasury-account-id` is an identifier, but changes still require
  careful reconciliation. Keep `unifold-publishable-key` aligned with the same
  Unifold environment.
- **Account passwords:** authentication is self-hosted, so there is no third-party
  auth secret to rotate. If a password store compromise is suspected, force-reset the
  affected accounts' credentials directly in the `users` collection.

## Honest hackathon demo narrative

Use claims that match what judges can see and what the deployed system actually
does:

- **Accounts:** "Tomo Together uses self-hosted username/password sign-in. The API
  hashes passwords with scrypt and issues a per-account opaque bearer token; accounts
  live in MongoDB Atlas alongside the rest of the app data."
- **MongoDB Atlas:** "Atlas is the durable store for the real-USDC ledger, withdrawal
  state, hangout staking events, and idempotency records — and, in a separate
  database with a separate least-privilege user, the main profiles/friends/hangouts
  data. Unique indexes prevent duplicate grants, transfers, and event processing,
  and the state survives an app restart."
- Be explicit that the hackathon cluster is M0 without managed backups.
- **Crypto safety:** "The money service is separately deployed, authenticated
  server-to-server, and gated by `CRYPTO_API_URL`. We can disable the entire money
  surface immediately without shipping a new APK. Automatic real-USDC grants and
  the raw balance-adjustment endpoint are disabled by default in production."
- Never claim that the unused publishable key is a shipped client integration, that
  every route was migrated to Atlas, or that a feature is production-grade merely
  because its dashboard switch is on.

## Remove temporary access

After deployment and verification:

```powershell
atlas auth logout --force
gh auth logout --hostname github.com
az logout
az account clear
Remove-Item Env:\CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:\ARM_SUBSCRIPTION_ID -ErrorAction SilentlyContinue
```

Delete the temporary Atlas Service Account, remove any temporary Azure role
assignment, and revoke the corresponding device/OAuth grants where appropriate. Securely remove the isolated `AZURE_CONFIG_DIR` after confirming
it points to the intended temporary directory.
