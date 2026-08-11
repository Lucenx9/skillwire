# Quickstart and end-to-end validation

This quickstart proves the complete SkillWire MVP without installing catalog content on the MCP
client.

## 1. Install and validate immutable inputs

```bash
corepack enable
corepack prepare pnpm@11.21.0 --activate
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:evaluation
pnpm catalog:verify --release-id launch-catalog-v1
pnpm advisory:verify --release-id launch-catalog-v1
pnpm benchmark:validate
```

The evaluation project enforces at least 30 frozen search cases with three per launch skill and at
least 20 frozen progressive journeys. Both thresholds must be at least 90%.

## 2. Create local secret files

`.env.example` contains paths and non-secret settings only.

```bash
cp .env.example .env
install -d -m 700 .secrets
openssl rand -hex 32 > .secrets/postgres-password
openssl rand -hex 32 > .secrets/api-key-pepper
postgres_password="$(tr -d '\n' < .secrets/postgres-password)"
printf 'postgresql://skillwire:%s@postgres:5432/skillwire\n' "$postgres_password" \
  > .secrets/database-url
chmod 400 .secrets/postgres-password
chmod 444 .secrets/database-url .secrets/api-key-pepper
unset postgres_password
```

## 3. Start PostgreSQL, migrate, and become ready

```bash
docker compose config --quiet
docker compose up --build --wait
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
```

The application cannot become ready before PostgreSQL health, the one-shot migration job, catalog
and advisory verification, and startup expired-audit cleanup succeed.

## 4. Bootstrap an API key

```bash
account_json="$(docker compose exec -T skillwire \
  node dist/src/authentication/admin-cli.js account:create)"
account_id="$(node -e \
  'process.stdout.write(JSON.parse(process.argv[1]).accountId)' "$account_json")"
key_json="$(docker compose exec -T skillwire \
  node dist/src/authentication/admin-cli.js key:create --account-id "$account_id")"
node -e \
  "const fs=require('fs'); fs.writeFileSync('.secrets/api-key', JSON.parse(process.argv[1]).token+'\n', {mode:0o600})" \
  "$key_json"
unset account_json account_id key_json
```

The plaintext token is emitted once and is absent from PostgreSQL and logs.

## 5. Prove search → load → resource and repository memory

```bash
repository_hash="$(printf 'quickstart/repository' | sha256sum | cut -d' ' -f1)"
pnpm smoke:mcp --endpoint http://127.0.0.1:3000/mcp \
  --api-key-file .secrets/api-key \
  --task 'Review strict TypeScript changes and unsafe narrowing' \
  --repository-hash "$repository_hash" \
  --verify-memory
unset repository_hash
```

The first three calls return preview → exact immutable instructions/manifest → one verified textual
resource. The optional fourth call confirms the load was persisted in the authenticated
account/repository scope. The client tree remains unchanged.

## 6. Run every suite locally and in the container

```bash
pnpm test:unit
pnpm test:contract
pnpm test:evaluation
TEST_DATABASE_URL='<disposable-admin-postgres-url>' pnpm test:integration
TEST_DATABASE_URL='<disposable-admin-postgres-url>' pnpm test:e2e
TEST_DATABASE_URL='<disposable-admin-postgres-url>' pnpm test:security
docker compose -f compose.yaml -f compose.test.yaml config --quiet
docker compose -f compose.yaml -f compose.test.yaml run --rm --build test
git diff --check
```

## 7. Prove clean shutdown and restart persistence

```bash
docker compose stop --timeout 15 skillwire
docker compose up --detach --wait --no-build skillwire
docker compose restart --timeout 15 skillwire
docker compose up --detach --wait --no-build skillwire
curl --fail http://127.0.0.1:3000/health/ready
```

The service stops with exit code zero, reruns startup cleanup before readiness, and observes the same
authoritative PostgreSQL repository memory after restart.

## 8. Optional informational measurement

```bash
pnpm benchmark:validate
chmod 0444 .secrets/api-key
trap 'chmod 0600 .secrets/api-key' EXIT
docker compose -f compose.yaml -f compose.benchmark.yaml --profile benchmark up \
  --build --abort-on-container-exit benchmark
chmod 0600 .secrets/api-key
trap - EXIT
```

Benchmark timings are evidence only and never a release gate.
