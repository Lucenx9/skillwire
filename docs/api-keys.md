# API-key bootstrap, rotation, and revocation

API-key administration is out of band and requires direct access to the
authoritative PostgreSQL database plus the deployment pepper. The CLI accepts
`DATABASE_URL`/`DATABASE_URL_FILE` and
`SKILLWIRE_API_KEY_PEPPER`/`SKILLWIRE_API_KEY_PEPPER_FILE`; exactly one source
for each value is required.

## Bootstrap

With Compose running:

```bash
account_json="$(docker compose exec -T skillwire \
  node dist/src/authentication/admin-cli.js account:create)"
account_id="$(node -e \
  'process.stdout.write(JSON.parse(process.argv[1]).accountId)' "$account_json")"
docker compose exec -T skillwire \
  node dist/src/authentication/admin-cli.js key:create --account-id "$account_id"
unset account_json account_id
```

`key:create` returns a key ID and token once. Store the token in the intended
client secret store; never log it, commit it, or pass it through tickets or
chat. PostgreSQL retains only a public lookup identifier, lifecycle metadata,
and a keyed digest.

## Rotation

Rotation is an explicit create–deploy–verify–revoke workflow:

1. Run `key:create --account-id <uuid>` to create a second key for the same
   account.
2. Place the new token in the client/deployment secret store.
3. Make an authenticated health-neutral MCP request with the new key.
4. Revoke the old key by ID:

   ```bash
   docker compose exec -T skillwire \
     node dist/src/authentication/admin-cli.js key:revoke --key-id '<old-key-uuid>'
   ```

5. Confirm the old key receives the same HTTP 401 shape as every other
   authentication failure.

Multiple keys may overlap briefly during rotation. Authentication is never
cached, so revocation is observed on the next request. To disable every key for
an account, use:

```bash
docker compose exec -T skillwire \
  node dist/src/authentication/admin-cli.js account:disable --account-id '<account-uuid>'
```

Disabling an account does not delete repository memory. Use the authenticated
`forget_repo_memory` operation for each repository scope before disabling access
when erasure is required.
