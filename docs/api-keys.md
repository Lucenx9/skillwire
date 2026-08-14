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
key_id="$(node -e \
  'process.stdout.write(require("node:crypto").randomUUID())')"
private_directory="$(mktemp -d)"
mkfifo --mode=0600 "$private_directory/token"
docker compose run --rm --no-TTY --no-deps \
  --user "$(id -u):$(id -g)" \
  --entrypoint node \
  --volume "$private_directory:/run/skillwire-private:rw" \
  skillwire dist/src/authentication/admin-cli.js key:create \
  --account-id "$account_id" --key-id "$key_id" \
  --token-output /run/skillwire-private/token \
  > "$private_directory/metadata.json" &
admin_pid=$!
timeout 30s sh -c 'cat "$1" > "$2"' _ \
  "$private_directory/token" .secrets/api-key
wait "$admin_pid"
chmod 0600 .secrets/api-key
rm -f "$private_directory/token" "$private_directory/metadata.json"
rmdir "$private_directory"
unset account_json account_id key_id admin_pid private_directory
```

`key:create` returns only the key ID and private-channel metadata on stdout. The
token is written once to the owner-only FIFO and must go directly into the
intended client secret store; never log it, commit it, or pass it through
tickets or chat. PostgreSQL retains only a public lookup identifier, lifecycle
metadata, and a keyed digest.

## Rotation

Rotation is an explicit create–deploy–verify–revoke workflow:

1. Repeat the private FIFO flow with a new UUIDv4, passing
   `key:create --account-id <uuid> --key-id <new-uuid>` and
   `--token-output /run/skillwire-private/token` to create a second key for the
   same account.
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
