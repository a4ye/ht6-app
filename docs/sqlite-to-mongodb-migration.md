# SQLite → MongoDB migration runbook (main server)

The main Tomo Yard server no longer uses SQLite. All social data (users,
friends, hangouts, activity weights, app metadata) lives in the MongoDB Atlas
database `tomoyard` on the existing `tomo-yard` cluster, next to (but strictly
separated from) the crypto ledger database `ht6_crypto`.

This runbook covers the one-time production cutover. Local development and CI
need none of this: tests start their own in-memory MongoDB, and a local server
run only needs any MongoDB at `MONGODB_URI` (default
`mongodb://127.0.0.1:27017`, e.g. `docker run -d -p 27017:27017 mongo:7`).

## What changed

- `server/` depends on `mongodb` instead of `better-sqlite3`; every route reads
  and writes MongoDB. Integer ids are preserved (allocated from a `counters`
  collection), so API payloads, NFC payloads, and Auth0 subject backfill ids
  (`tomoyard-<id>`) are unchanged.
- The old per-hangout tables became embedded arrays on the hangout document:
  `hangout_members` → `member_ids`, `confirms` → `confirms`, `hangout_stakes` →
  `stakes`, `hangout_settlements` → `settlements`. NFC tokens are embedded too
  but are short-lived and not migrated.
- Unique constraints became unique indexes created at startup: `username`,
  `token`, and the partial `users_auth0_sub_unique` on `auth0_sub`.
- Terraform gives the main App Service a system-assigned identity and resolves
  `MONGODB_URI` from the Key Vault secret `mongodb-uri-app`;
  `MONGODB_DB_NAME` comes from the `app_mongodb_db_name` input (default
  `tomoyard`). `SQLITE_JOURNAL` is gone.
- The Auth0 legacy-migration scripts (`export-auth0-users.js`,
  `backfill-auth0-subjects.js`) now target MongoDB via `--uri`/`--db-name` (or
  the `MONGODB_URI`/`MONGODB_DB_NAME` environment variables).

## One-time production cutover

Order matters: the data must be in Atlas before the new code serves traffic.

1. **Create the Atlas database user.** In the `Tomo Yard Hackathon` Atlas
   project, add database user `tomo-yard-app` with `readWrite` scoped to the
   `tomoyard` database only (Atlas CLI:
   `atlas dbusers create --username tomo-yard-app --role readWrite@tomoyard`).
   The Atlas IP access list already contains all App Service possible-outbound
   addresses; both apps share one plan, so no new entries are normally needed
   (verify with `terraform -chdir=infra output app_possible_outbound_ip_addresses`).
2. **Store the connection string.** Put the full `mongodb+srv://` URI for
   `tomo-yard-app` (percent-encoded password) into Key Vault as secret
   `mongodb-uri-app`:
   `az keyvault secret set --vault-name ht6tomoyardkv4831 --name mongodb-uri-app --value '<uri>'`.
   Never commit or log the URI.
3. **Apply Terraform.** `terraform -chdir=infra apply` adds the main app's
   managed identity, its Key Vault role assignment, and the
   `MONGODB_URI`/`MONGODB_DB_NAME` app settings, and removes `SQLITE_JOURNAL`.
4. **Freeze writes briefly.** Stop the main App Service (`az webapp stop`) so
   the SQLite file cannot change during the copy. The mobile app degrades
   gracefully; the crypto service is unaffected.
5. **Copy the SQLite file down.** Fetch `/home/data/tomoyard.sqlite` via Kudu
   (`https://ht6-tomoyard.scm.azurewebsites.net` → Debug console) or
   `az webapp deploy`-adjacent tooling, to a private location outside any repo.
6. **Run the migration.** On a trusted machine:

   ```bash
   cd server
   npm install
   npm install --no-save better-sqlite3
   node scripts/migrate-sqlite-to-mongodb.js --sqlite /abs/path/tomoyard.sqlite \
     --uri '<mongodb-uri-app value>' --db-name tomoyard        # dry run
   node scripts/migrate-sqlite-to-mongodb.js --sqlite /abs/path/tomoyard.sqlite \
     --uri '<mongodb-uri-app value>' --db-name tomoyard --yes  # write
   ```

   The script refuses non-empty target collections, preserves every id, sets
   the id counters, and creates the server's indexes so any unique-constraint
   surprise fails here, not at first server start.
7. **Deploy the new code.** Merge/push to `main` (or re-run
   `deploy-server.yml`), then start the App Service again. Startup connects to
   Atlas before listening and exits on failure.
8. **Verify.** `/health` returns ok; sign in with an existing account; friends,
   hangout history, photos (still under `/home/data/uploads`), and wallet
   mapping are intact. The legacy `tomoyard.sqlite` stays on `/home/data` as a
   fallback until the cutover has been verified for a few days; then delete it.

## Rollback

Revert the migration commit and redeploy; the untouched
`/home/data/tomoyard.sqlite` file still contains the pre-cutover state. Any
writes made while MongoDB was live are lost on rollback — roll back quickly or
not at all.
