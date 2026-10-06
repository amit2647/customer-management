# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MVP Service-Oriented Architecture (SOA) demo for customer/lead management. This
`customer-management` repo is the **parent repo** — it holds `docker-compose.yml` and `.env`, and
assembles the actual application from **Git submodules**:

- `lead-service`, `customer-service`, `service-service`, `identity-service`, `email-service`,
  `dashboard-service`, `assistant-service` — each an independent Node/Express repo with its own
  git history and Dockerfile
- `kong` — Kong's declarative config repo (`api_gateway`)
- `frontend` — React/Vite SPA (`customer_mgmt_frontend`)
- `migrations` — the schema migration runner and bootstrap seed for the shared database
- `bundle-service`, `engagement-service`, `obligation-service`, `document-service`,
  `vault-service` — the profession-bundle capability services (same layout as the core ones;
  `/health` only until their milestone)
- `bundle-sdk` — the bundle contract and the engines shared by those services (a library,
  not a service)

**`main` is frozen** (since 2026-10-01): it holds the last release, and all work happens on
`develop`, in the parent and in every submodule alike. Local `pre-commit`/`pre-push` hooks in each
repo refuse commits on `main` and pushes to it (`ALLOW_MAIN=1` overrides once — only when the
user asks to release or unfreeze). Hooks are not versioned, so a fresh clone does not have them.

Each submodule is checked out on `develop` at a pinned commit. When editing service code, `cd` into
the submodule — commits there belong to that service's own repo, not the parent. If you change a
submodule and want the parent repo to track the new commit, that's a separate `git add <submodule>`
+ commit in the parent after the submodule itself is committed/pushed.

Every repo has tests and ESLint (`npm test`, `npm run lint`, `npm run coverage`); there is no
formatter (don't assume `prettier`). See **Testing** below.

## Configuration

Every value in `docker-compose.yml` comes from `.env`, with the original literals kept as `:-`
defaults so the stack boots on a fresh clone with nothing configured. `.env.example` documents all
of them. `.env` is gitignored; so is `handoff.md`.

Three things are deliberately not templated, each commented where it sits:

- Kong's container-side `8000` and Vite's `3000` are those programs' own ports.
- `kong/kong.yml` pins the internal service ports and is a separate submodule that is not
  templated from here. Changing a `*_SERVICE_PORT` means editing `kong.yml` to match; changing a
  `*_HOST_PORT` is always safe.
- The frontend reaches Kong through `VITE_API_BASE_URL`, which compose derives from
  `KONG_HOST_PORT`.

**The OpenRouter settings are the one exception to interpolation.** assistant-service reads them
through `env_file`, because `${VAR}` interpolation prefers a shell export over `.env` and made the
key's real source ambiguous. Two consequences: never add `OPENROUTER_*` under that service's
`environment:` (entries there override `env_file` and reinstate shell precedence), and because
`env_file` loads the whole file, the `BOOTSTRAP_*` values are explicitly blanked for that one
container so the service that talks to an external model is not also holding the seed admin
password. `VAULT_MASTER_KEY`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` and `SERVICE_JWT_SECRET` are blanked there for the same
reason; only vault-service may hold the first three, and only obligation- and email-service
the last. Any new secret in `.env` needs the same blanking.

Note the asymmetry: the interpolated variables *are* still shell-overridable, which is normal and
useful for CI. Only `OPENROUTER_*` is shell-proof.

## Running the app

```bash
docker compose up -d          # build + start everything
docker compose ps             # check health
docker compose logs -f <service>   # e.g. lead-service, kong, frontend
docker compose down           # stop and remove containers + network (volumes persist)
docker compose up -d --build <service>   # rebuild a single service after code changes
docker compose up migrate     # re-run migrations alone (idempotent)
```

- Frontend: http://localhost:3000
- Kong API Gateway (what the frontend talks to): http://localhost:8080/api/...
- Redis publishes `6379` to the host. **Postgres publishes nothing** — reach it with
  `docker compose exec postgres psql -U app_user -d customer_management`.
- **Qdrant publishes nothing either** and requires `QDRANT_API_KEY` (a self-generated shared
  secret in `.env`, not a provider key). Reach it from the Docker network, e.g.
  `docker run --rm --network customer-management_default curlimages/curl -H "api-key: …" http://qdrant:6333/collections`.
- **SeaweedFS** (the S3 store for client files) publishes nothing and only vault-service holds
  its keys (`S3_ACCESS_KEY`/`S3_SECRET_KEY`). Its keys always have a value — with none it
  would serve the store anonymously — so compose falls back to development defaults, like
  `JWT_SECRET`. It replaced MinIO, whose community edition was discontinued in 2026.
- Each backend service also exposes its own port directly (4001–4012) for debugging, but the
  frontend and inter-service calls always go through the gateway or internal Docker DNS
  (`http://<service-name>:<port>`), never `localhost`, inside containers.
- Individual services can be run outside Docker with `npm start` (or `npm run dev` for
  auto-restart, where available) from within the submodule directory, provided `DB_HOST`,
  `JWT_SECRET`, etc. are set to match `docker-compose.yml`.

## Testing

Three layers, all run by `.github/workflows/ci.yml` in the parent; each submodule also runs its own
unit tests on its own pushes (`.github/workflows/test.yml`).

- **Unit** — `npm test` in any service (`node --test`, no extra dependencies) or in `frontend`
  (Vitest + Testing Library, jsdom). Every service tests its own copy of the auth middleware from
  one shared template, asserting status codes and `next()` rather than error bodies, since the
  copies differ only in wording. Databases, the model and other services are stubbed.
- **Migrations** — `migrations/test/sql-rules.test.js` enforces the migration rules below
  (no DROP/TRUNCATE/DELETE, no `password_hash` UPDATE, `IF NOT EXISTS`, guarded constraints).
  `idempotency.test.js` runs every migration twice, but **only** when `MIGRATIONS_TEST_DB` names a
  disposable database, and it refuses `customer_management`.
- **Integration** — `tests/run-integration.sh` boots the whole stack as project `cmtest` with
  `docker-compose.test.yml`, runs `tests/integration/*.test.js` through Kong on port 18080, then
  `down -v`s that project only. `KEEP=1` leaves it up. It never touches the main stack's data.
  Outgoing mail goes to **Mailpit** (API on 18025) and replies are delivered into **GreenMail**
  (IMAP; SMTP on 13025) for email-service to read back, so sending, automations and receiving are
  all tested with real protocols and nothing leaves the machine. After the functional tests, a
  **k6** load smoke (`tests/load/smoke.js`, 20 users, p95 < 800 ms, < 1% errors) runs on the same
  stack; `LOAD=0` skips it. Organization isolation needs a user in a second
  organization, which no API creates; `lib.sql()` moves one there via the `cmtest` Postgres only.
- **Browser** — `tests/run-e2e.sh` adds the UI (`--profile ui`, port 13000) and runs Playwright
  from Microsoft's image with `--network host`, so no browser is installed locally. Every test
  saves a screenshot to `tests/e2e/screenshots` (the assistant in all four themes, the docked
  panel's position, profile, access denial); CI uploads them as the `e2e-screenshots` artifact.
- **Lockfiles** — every repo has `package-lock.json` and CI installs with `npm ci`. Regenerate
  with `npm install` after changing dependencies, and commit the lockfile with it. If you do that
  in Docker, pass `-u "$(id -u):$(id -g)"`: run as root, npm writes a root-owned lockfile back
  into the repo.
- **CI gates** — every repo lints and runs `npm audit --omit=dev --audit-level=high`; the parent's
  `security` job also runs gitleaks over the full history of the parent and every submodule.
  Coverage is printed, not enforced.
- **Real model** — `tests/smoke-openrouter.sh` is manual only: one question to the real model
  through the dev stack, checking it called a tool. It spends credit; never add it to CI.

In the test stack the assistant talks to `tests/fake-openrouter`, a scripted stand-in: the last user
message is the script (`TOOL <name> <json>`, `SLOW <ms> <text>`, `FAILONCE <key> <text>`, else
echo), and `GET /__calls` counts model calls. assistant-service reaches it through
`OPENROUTER_BASE_URL`, loaded from `tests/integration/assistant.env` via `env_file`. So tests
spend no OpenRouter credit and hold no real key. Fresh test databases seed email automations
switched off and no email accounts, so nothing in the suite can send mail.

## Architecture

```
Browser -> Frontend (React/Vite, :3000) -> Kong Gateway (:8080) -> backend services -> Postgres/Redis
```

Kong routes by path prefix (`kong/kong.yml`), stripping the prefix before forwarding:

| Path prefix      | Service            | Port |
|-------------------|---------------------|------|
| `/api/leads`      | lead-service        | 4001 |
| `/api/customers`  | customer-service     | 4002 |
| `/api/services`   | service-service      | 4003 |
| `/api/auth`       | identity-service     | 4004 |
| `/api/dashboard`  | dashboard-service    | 4005 |
| `/api/emails`     | email-service        | 4006 |
| `/api/assistant`  | assistant-service    | 4007 |
| `/api/mcp`        | assistant-service    | 4007 |
| `/api/bundles`     | bundle-service       | 4008 |
| `/api/engagements` | engagement-service   | 4009 |
| `/api/obligations` | obligation-service   | 4010 |
| `/api/documents`   | document-service     | 4011 |
| `/api/vault`       | vault-service        | 4012 |

identity-service serves more than `/api/auth`; each of these is a separate Kong entry pointing
at its own upstream path: `/api/users`, `/api/roles`, `/api/permissions`,
`/api/organizations`, `/api/access-grants`, `/api/profile`.

Service-to-service calls (e.g. lead-service calling customer-service/service-service during lead
creation/conversion) go directly over the Docker network via `*_SERVICE_URL` env vars, bypassing
Kong.

### Backend service shape

Every backend service (`lead-service`, `customer-service`, `service-service`, `identity-service`,
`email-service`, `dashboard-service`, `assistant-service`) follows the same layout and
conventions:

```
src/
  server.js        # entrypoint: app.listen() — services do NOT touch schema, see Migrations
  app.js            # express app: cors, json body parsing, requestLogger, /health, routes
  config/database.js   # pg Pool (or redis client for dashboard-service)
  middleware/authenticate.js     # verifies JWT (see Auth below)
  middleware/requirePermission.js
  routes/*.js
  controllers/*.js
  services/*.js     # business logic + SQL queries live here, not in controllers
```

- No ORM — raw SQL via `pg` (`node-postgres`), built with parameterized queries.
- All services share **one Postgres database** (`customer_management`) — there's no per-service
  DB isolation in this MVP. `service-service`'s `services` table is referenced by foreign-key-less
  join tables (`lead_services`, `customer_services`) owned by other services.
- Health check: every service exposes `GET /health` returning at least
  `{status: "ok", service: "<name>"}` — some add a field of their own. `docker-compose.yml`
  healthchecks poll this.
- `middleware/accessGrants.js` is copied into every service and merges live just-in-time grants
  into `req.auth.permissions`; `authenticate` is `async` because of it. dashboard-service carries
  a `pg` pool solely for this.

### Migrations

Schema is owned entirely by the `migrations` submodule, never by the services. The `migrate` compose
service runs it to completion and the DB-backed services are gated behind
`migrate: { condition: service_completed_successfully }`, so the schema always exists before anything
serves traffic.

- `run.js` takes a Postgres advisory lock, then applies each unapplied `sql/*.sql` file (sorted by
  filename) in its own transaction, recording it in a `schema_migrations` ledger. Already-applied
  files are skipped; a changed checksum logs a warning and is never re-applied.
- **To change the schema, add a new numbered file** to `migrations/sql/` — never edit an applied
  one. Write statements re-runnably (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, and
  `pg_constraint`-guarded `ADD CONSTRAINT`, since Postgres has no `ADD CONSTRAINT IF NOT EXISTS`).
  Never put `DROP`, `TRUNCATE`, `DELETE` or a `password_hash` `UPDATE` in a migration.
- `seed.js` runs on every start, outside the ledger, so a half-bootstrapped DB self-heals. It
  resolves the organization by `BOOTSTRAP_ORG_SLUG` (then lowest id, then creates one), creates the
  admin user only if that email is absent — it never overwrites an existing `password_hash` — grants
  SUPER_ADMIN membership, and seeds the default services against the *resolved* org id. Demo data
  sits behind `SEED_DEMO_DATA` (default **true** — set `false` for a real deployment): two leads and one customer converted from the
  first, reproducing `convertLead`'s footprint since no column links a lead to its customer. It
  only runs on a database with no leads and no customers. `BOOTSTRAP_*` vars are documented in
  `.env.example`.
- To prove a from-scratch boot without destroying local data, use the throwaway parallel stack:
  `docker compose -p cmcold -f docker-compose.yml -f docker-compose.cold.yml up --build`, then
  `docker compose -p cmcold down -v`. The override uses `!reset` to strip `container_name` and
  `ports` (plain `null` does not unset them) so both stacks can run side by side.

### Auth model

- `identity-service` issues JWTs (`jsonwebtoken`) on login, signed with `JWT_SECRET` and carrying
  `JWT_ISSUER` (default `omnicore-identity-service`). Both are shared across every service through
  `.env`. All seven services read the issuer from the env var on verify, and identity-service reads
  it when signing — several used to hardcode the literal, so the variable did nothing and changing
  it broke auth in a partial, confusing way.
- No service falls back to a default `JWT_SECRET`. Verification fails closed if it is unset; do not
  reintroduce a fallback, since the development secret is committed to this repo.
- JWT payload carries `sub` (user id), `organizationId`, `role`, and a `permissions` array.
- Every other service's `middleware/authenticate.js` independently verifies the token (no calls
  back to identity-service per-request) and populates `req.auth = { userId, organizationId, role,
  permissions }`.
- `middleware/requirePermission(permission)` is applied per-route and checks
  `req.auth.permissions.includes(permission)` — RBAC permissions are baked into the JWT at login
  time, not re-fetched.
- Multi-tenancy: rows are scoped by `organization_id`, derived from `req.auth.organizationId`, not
  from client-supplied input.

#### Just-in-time access and guests

Two things are deliberately **not** trusted from the token, because a JWT cannot be revoked:

- `access_grants` rows are read **live on every request** by `middleware/accessGrants.js` and
  merged into `req.auth.permissions`. Revoking a grant takes effect immediately on an unchanged
  token. Grants are additive only, so a failed lookup leaves the caller with their token's own
  permissions — erring toward denying access.
- A grant to a `subject_email` with no account issues a one-time invite link. Redeeming it
  (`POST /access-grants/redeem`, the one unauthenticated route there) materialises a `users` row
  with `is_guest = true` and attaches the grant to it, so the normal lookup governs guests too.
  Their JWT carries **zero baseline permissions**. Only a hash of the invite token is stored.

#### Where a permission is checked

Authorization lives in the service that owns the data, and only there. Callers — the frontend,
another service, the assistant — forward the user's own bearer token rather than re-deciding.

Two conventions worth knowing before editing routes:

- **Assigning permissions is gated on `system.settings`**, not on the `*.update` permission for
  the thing being edited. Role CRUD, access grants and changing a user's role all follow this;
  otherwise anyone who could rename a colleague could promote them. Creating a user follows the
  same idea: without `system.settings`, `createUser` only accepts a role whose every permission
  the caller already holds (delegate, never escalate).
- `service-service` has a `requireAnyPermission` middleware used by **`GET /services/:id` only**.
  lead-service and customer-service resolve service names by calling it with the end user's token,
  so requiring `services.read` there would force anyone who can read leads to also be handed the
  Services screen. The catalog list `GET /services` stays on `services.read` alone.

### AI assistant and MCP

`assistant-service` hosts both the in-product assistant (`POST /assistant/chat`) and an MCP server
(`POST /mcp`, Streamable HTTP) over a **single tool catalog** in
`src/services/toolCatalog.js`. It holds no business logic and touches no business tables — it reads
the database only to resolve access grants when authenticating.

- Every tool is an HTTP call onto the owning service carrying the caller's own bearer token, so
  adding a tool never means duplicating a permission check.
- Each tool declares a `permission`. `toolsFor(permissions)` filters the catalog **before the model
  is invoked**, so the assistant has no vocabulary for features the user lacks — that, not the
  prompt, is what keeps it from offering or discussing them.
- Settings tools (users, roles, permissions, access grants, organization, email templates,
  automations, accounts) are **read-only**, each gated on the same permission as the endpoint it
  calls. They pass results through `pick()` so only the fields that answer a question reach the
  model provider — e.g. an email account's address, never its SMTP host or username. Do the same
  for any new tool that reads configuration.
- Tools marked `write: true` are never executed on the model's say-so. They come back as a
  `pendingAction` for the user to confirm, and the confirming call re-checks the permission rather
  than trusting the returned payload.
- The model is reached through OpenRouter. `OPENROUTER_MAX_TOKENS` is capped (default 1024) because
  the provider default is far larger and is billed against the account's headroom. With no
  `OPENROUTER_API_KEY` the assistant returns 503 and nothing else is affected.
- Conversations are stored server-side (`assistant_conversations`, `assistant_messages`,
  `assistant_pending_actions`, migration 011) and `conversationService.js` owns all of that SQL.
  The client sends only `{ clientMessageId, content }`. Tool calls and results are stored and
  replayed to the model, **filtered to the caller's current tools**, so a revoked permission also
  withdraws the data it produced.
- A turn is three steps: a short transaction that takes the conversation's **turn lease** and
  records the question, the model call with **no transaction open**, then one transaction that
  commits everything the model produced. Never hold a transaction across the model call.
- Duplicates are prevented by the schema, not by care: client-generated conversation and message
  ids (a retry replays the stored answer), `UNIQUE (conversation_id, seq)`, and a confirm that
  claims its action with `pending → executing`, so a double click runs the write once. A confirm
  carries no body: the **stored** arguments run, never anything the client sends back.

#### Vector search (Qdrant)

Qdrant is a **derived index; Postgres is the source of truth**. Two collections:
`assistant_messages` (conversation prose, for history search and recall) and
`assistant_knowledge` (the Markdown in `assistant-service/knowledge/`, for the `search_help` tool).

- Nothing writes to Qdrant in a request. A message is committed with `embed_status = 'pending'`
  (migration 012) and `embeddingWorker.js` drains it: claim with `FOR UPDATE SKIP LOCKED`, embed,
  upsert with `wait=true`, mark done, one Postgres transaction. Point id = message id, so reruns
  overwrite. Qdrant down → rows stay pending. Resetting `embed_status` to `pending` rebuilds it.
- **Qdrant only ever supplies ids.** Every hit is re-read from Postgres with organization, user and
  `deleted_at` checked again (`searchService.js`). Keep it that way — never render payload text
  from a message point.
- Only user and assistant prose is embedded, never tool results: those are CRM data under
  permissions that can be revoked, and a vector copy would outlive the revocation.
- Embeddings are local (`all-MiniLM-L6-v2` via `@huggingface/transformers`, 384-d). Its ONNX
  runtime needs glibc, which is why assistant-service is `node:22-slim` rather than Alpine and why
  its healthcheck uses `node`, not `wget`. The model is fetched at image build; runtime is offline.
- Help docs carry a `permission:` front-matter; `search_help` filters to the caller's permissions
  inside the vector search. A tool with `permission: null` is open to everyone, so use that only
  for a tool that filters by permission itself.
- `QDRANT_API_KEY` is passed to assistant-service under `environment:` on purpose, so it resolves
  the same way as in the `qdrant` container. Do not leave it to `env_file`.

### Profession bundles (in progress on `develop`)

The next release turns the CRM into a shared core plus an installable profession **bundle**
(CA practice first). Milestones M0–M8 land on `develop`; `main` stays frozen until the single
release at the end. Rules already decided — keep to them:

- **A bundle is versioned data, never code**: a repo of YAML/JSON/Markdown (`bundle.yaml` plus
  schemas, catalog, deadline rules, document templates, portals, roles, email, help). Its
  contract and every engine that reads it live in `bundle-sdk`: the manifest JSON Schema,
  `bundle-lint`, the condition language (a JSONLogic subset plus `engaged`/`filled`), the
  due-date calculator and the locked-down Handlebars. Services must use these rather than
  re-implement them, so lint and production cannot disagree.
- **One bundle per organization** (`organization_bundles UNIQUE (organization_id)`).
  Profession fields are `attributes` JSONB, validated against the bundle's schema and stamped
  with `attributes_version`.
- **An organization without a bundle must see exactly today's product.** Capability routes
  answer "not enabled" for it, and the existing suites are the proof.
- **Clients are archived, not deleted**; a separate admin-only purge cascades. Client-owned
  tables FK to `customers ON DELETE CASCADE` (unlike the older unconstrained cross-service
  ids). Audit rows (`audit_events`, `credential_reveals`) keep plain ids so they outlive
  a purge.
- **Upgrades keep a firm's edits**: bundle-installed rows carry `source_checksum`; a row
  whose content no longer hashes to it is kept and flagged `update_available_version`, never
  overwritten. Items a bundle drops are `retired_at`, never deleted.
- Due dates are `DATE`s computed in `organizations.time_zone`, never local-time `Date`s.
  Bundle role templates can never grant `system.*` or `bundles.manage`, and bundle
  permissions are namespaced (`ca.*`).
- The capability permissions are seeded by migration 014 and mirrored in
  `bundle-sdk/src/permissions.js`; change both together. identity-service's
  `getPermissions` holds a third copy: it hides them from the role editor of an organization
  with no bundle, and never lists another bundle's namespaced permissions.

#### Installing a bundle (bundle-service)

- **The registry is baked into bundle-service's image** from the parent's `bundles/` directory
  (one submodule per bundle, e.g. `bundles/ca-practice` → repo `bundle-ca-practice`), passed as
  the build context `bundles` (`additional_contexts` in compose). At startup each is linted
  with bundle-sdk and recorded in `bundle_versions`; a version whose content differs from its
  recorded copy is refused — **bump the version for any change to a bundle**.
- bundle-service depends on bundle-sdk through a GitHub tarball URL pinned to a commit
  (`codeload.github.com/…/tar.gz/<sha>`): images have no git, so not `github:` shorthand.
- `POST /bundles/:key/install` (needs `bundles.manage`) runs steps in order — permissions →
  roles → catalog → email — each a `PUT /<capability path>/bundles/:key/:version` on the
  owning service, carrying only its slice and the admin's own token. Each step is idempotent
  and recorded in `bundle_install_steps`; a failed step stops the install (`502`, status
  `failed`), and installing again resumes at that step without re-running finished ones. No
  transaction spans the calls: the `organization_bundles` row is a lease (`installing` with a
  recent `updated_at`), taken under an advisory lock, stale after two minutes.
- **Upgrading** (`POST /bundles/:key/upgrade`, Settings → Profession Bundle → "Upgrade to x.y.z"):
  the same steps again at the newer version, each keeping the firm's edits (`bundleSync`). The
  organization keeps working on the version it has throughout: `organization_bundles.version`
  changes only when every step has finished, `GET /bundles/installed` serves the old version
  while the row is `upgrading`, and a failed upgrade leaves the row `installed` at the old version
  — upgrading again resumes at the failed step (steps are recorded per version). Install refuses
  a newer version over an installed one ("upgrade instead"); nothing goes back a version.
- Every install endpoint uses `src/services/bundleSync.js` (`decide()`: insert / unchanged /
  update / keep) — **copied** into identity-, service- and email-service like the auth
  middleware, with an identical test beside each copy; keep them identical. A pre-existing row
  with the same name is adopted and treated as the firm's own, never duplicated.
- Installed email automations are always created **off**, and an install never switches one
  on or off. The deadline trigger events are accepted only for an organization with a bundle.
- `GET /bundles/installed` (any member) returns only the public sections (vocabulary, profiles,
  identifiers, people roles, pipeline) of the installed version's recorded manifest, and
  `{ bundle: null }` until an install has finished. Settings → Profession Bundle
  (`BundlePage.jsx`, `bundles.manage`) installs and resumes.
- Integration tests install into organizations of their own (`lib.caFirm()`,
  `lib.organizationWithAdmin()`); the shared test organization never gets a bundle, so the other
  suites keep proving it unchanged. The browser suite is the exception: its *last* tests install
  CA Practice into the test organization and then exercise the bundle screens — keep new
  bundle browser tests after that install.

#### Client profiles, prospects and the firm (M2)

- Services that need the installed bundle ask bundle-service for it (`GET /bundles/installed`,
  with the caller's token) through a copied `services/bundleContext.js` (installed bundles cached
  60 s per organization; "no bundle" never cached), and gate their bundle routes with a copied
  `middleware/requireBundle.js` → 404 "not enabled" for an organization without one. Copies live
  in customer-, lead- and identity-service; keep them identical.
- Bundle rules are evaluated with bundle-sdk everywhere, the browser included: customer-service
  (`profiles.validate`, `identifiers.check`), lead-service, identity-service, and the frontend,
  which imports `bundle-sdk/src/conditions` and `/identifiers` so the wizard shows and requires
  exactly the identifiers the server will. A schema `if` must `require` the field it tests, or it
  also matches when the field is empty — lint warns.
- customer-service: the client wizard saves core fields, services and `profile` (attributes,
  identifiers, people, bank accounts) in **one transaction** — `createCustomer`'s `extend` hook
  writes the profile before COMMIT, so a refused PAN leaves no half-made client. A duplicate
  identifier is a 409 naming the client that holds it, archived ones included (the PAN stays
  taken while archived). Bank account numbers leave the service masked (`•••• 9012`), so an
  existing client's accounts are only changed one by one through their own endpoints, never
  resent with the profile. Locked clients need `profiles.lock` for any write (423); archived
  clients are read-only (409). With a bundle, `DELETE /customers/:id` archives; purge needs
  `customers.purge` and an archived client. All of this is new code in
  `profileService.js`/`profileRoutes.js`; the original customer code only gained additive
  columns, the archived filter, identifier search and the `extend` hook.
- lead-service: `PATCH /leads/:id/prospect` moves a lead between the bundle's pipeline columns
  (never to `Converted` by hand, never once converted) and keeps quote, next meeting, notes and
  lead fields. Convert links lead and client (see **Lead conversion**); the frontend then opens
  the wizard on that client, preselecting the prospect's constitution. The client's Overview
  shows the prospect it was won from, or offers "Link a prospect" (`ClientOrigin.jsx`).
- identity-service: `/organizations/current/profile` and `/organizations/current/professionals`
  (one default signatory) — under `/organizations/…` so Kong needed no new route.
- Frontend: `BundleContext` loads the installed bundle once per sign-in (`ready` once the first
  answer is in); the sidebar's Customers entry becomes the bundle's word ("Clients") and points at
  `/clients`, and **Prospects replaces Leads** — only with a bundle. Both were views of the same
  `leads` rows, so a bundle organization has one screen for them: the board, with a Board | List
  toggle (search, "Show converted"). The `/leads*` and `/customers*` routes sit behind
  `components/auth/WithoutBundle.jsx`, which with a bundle redirects them to `/prospects` and to
  each path's `/clients` twin, so dashboard links and the landing fallback follow; it renders
  nothing until `ready`, so the old screen never flashes. Bundle fields render with
  react-jsonschema-form through `components/bundle/SchemaForm.jsx` (rjsf 6 keeps option
  **indexes** as `<select>` values — pick options by label in tests). Not yet possible: showing a
  field only for some constitutions (needs conditional properties in contract v1).

#### Engagements and fees (M3)

- engagement-service owns `engagement_types` (installed from the bundle by the
  `engagementTypes` install step), `engagements` (one per client per period of a type —
  `UNIQUE (customer_id, engagement_type_id, period_start)`), `engagement_lines` (services
  engaged, fee and expenses) and `engagement_payments` (migration 015). Gross, received and
  balance are computed on read, never stored.
- Periods come from bundle-sdk `schedules`, generated around **today in
  `organizations.time_zone`** (`GET /engagements/periods`), never a hard-coded list.
- Fee amounts are part of an engagement only for `fees.read`; setting them needs `fees.update`.
  Someone without it may change which services are engaged, and existing fees are carried
  over, not zeroed. Payments need `fees.read`/`fees.update` and are audited
  (`payment.recorded`).
- The install-step route (`PUT /engagements/bundles/:key/:version`) is the one capability route
  without `requireBundle`: it runs while the install is still in progress.
- New engagements raise `engagement.created`; email-service's event queue accepts the capability
  events alongside the core ones.
- The wizard creates a new client's first engagement as a second request after the client is
  saved; if it fails, the client page says so and the Engagement tab can add it.
  `components/bundle/EngagementForm.jsx` is shared by the wizard and the Engagement tab.

#### Deadlines and reminders (M4)

- obligation-service owns `obligation_rules` (installed by the `obligations` step; the bundle's
  rule is stored whole in `definition` and evaluated by bundle-sdk `schedules`),
  `obligation_overrides` (one extended date per rule and period) and `obligations` (migration
  016). Overdue / due soon (30 days) / upcoming are derived on read against today in
  `organizations.time_zone`, never stored.
- **Deadlines come from engagements**: only services engaged for that year generate items
  (FIX-15). engagement-service calls `POST /obligations/generate` after every create and
  update, with the user's token; a failure there is logged, not surfaced, and generating again
  repairs it. Generation is idempotent (`UNIQUE (customer_id, rule_id, period_key)`), never
  touches a `filed`/`not_applicable` item, and drops pending generated items a changed
  engagement no longer produces.
- An extension moves open deadlines of that period at once; removing it regenerates them.
- **The service credential.** The reminder runner has no user token, so it signs a short-lived
  JWT with `SERVICE_JWT_SECRET` (issuer `omnicore-services`, scope `automations.trigger`).
  email-service accepts it on `POST /emails/automations/trigger` **only**
  (`authenticateUserOrService.js`), with no permissions. Without the secret the runner stays
  off. It is a secret like the others: blanked for assistant-service.
- The runner (hourly, `OBLIGATION_REMINDER_INTERVAL_MS`) raises `obligation.due_soon` (≤ 7
  days) and `obligation.overdue` (≤ 30 days late) with `dedupe_key
  obligation:<id>:<kind>`, so each reminder is raised once; whether mail goes out is up to the
  firm's automations, which install switched off. `POST /obligations/reminders/run`
  (`obligations.rules`) runs it for the caller's organization now.
- CA rules exist for GST, TDS, income tax, audits and ROC. Accounting, PF/ESIC and PTRC have
  none until a practitioner confirms the dates — don't invent them.

#### Documents (M5)

- document-service owns `document_templates` (installed by the `documents` step) and
  `generated_documents` (migration 018). **Templates are versioned and never edited in place**:
  a bundle upgrade or a firm's own edit adds a version and makes it current (one current per
  key). A document points at the version it was made from (FK `RESTRICT`), is re-rendered only
  from that version while a draft, and keeps its `rendered_html` once finalized — a later
  version never changes a letter already issued.
- Upgrades keep a firm's text (`bundleSync.decide`): untouched templates move to the new bundle
  text; a firm-edited one stays current, is flagged `update_available_version`, and the newer
  bundle text is stored beside it as a non-current version so **Restore** can take it.
- Rendering is bundle-sdk `templates` only: values always escaped, `[Label]` marks for anything
  missing. `templates.check(body, fields)` is the one set of template rules — bundle-lint runs
  it on bundle documents and document-service on a firm's edit (parse, known helpers, no
  `{{{ }}}`, no `<script>`/`<iframe>`/`on…=`/`javascript:`, only the binding roots and the
  document's own fields). Fields pre-fill from data via `"ui:prefill": "<path>"` in the field's
  ui (`templates.prefill`); the render context (`contextService.js`) carries exactly the bindings
  lint allows — `client` (+ identifiers, people, `signatory`), `engagement` for the period
  (+ `fee_total`, `expenses_total`, `services`), `firm`, `signatory` (the firm's default
  partner), `fields`, `today`, `period`.
- **Finalize refuses while any `[placeholder]` remains** or the fields fail their schema, and
  writes `document.finalized` to `audit_events` (with the optional UDIN). Finals cannot be
  changed or deleted; drafts can.
- The frontend shows letters in `components/documents/LetterFrame.jsx`: an iframe with
  `sandbox="allow-same-origin allow-modals"` (no scripts can run in it; the page can size and
  print it), letter CSS of its own (0.5 in margins, highlighted gaps kept when printing,
  favourable/adverse answers in green/red).
- JSONB does not keep key order, so the service records each template's field order as
  `ui:order` at install (`withOrder`). A bundle's own `ui:order` wins.
- Editing a template's text needs `system.settings` (Settings → Document templates); previewing
  unsaved text through `POST /documents/preview` with a `body` needs it too.
- **CA letters are skeletons**: every field, condition and pre-fill is wired, but the legal
  wording is `[Wording: …]` gaps until the firm supplies it — so none can be finalized as
  shipped. The order letters are offered in is their folder order (`documents/01-…`).

### Email

- An automation sends from its chosen account (`email_account_id`, the form's "Send from"), or
  the organization default, which only resolves while exactly one account is active. The server
  enforces this when an automation is saved switched on or activated: a chosen account must be an
  active one in the caller's organization, and "default" is refused once two are active. The
  automation list response carries `accounts` (id, name, address only) so automation editors can
  pick one without `system.integrations`.
- `emailReceiver.js` reconciles IMAP receivers with active accounts every `EMAIL_RECEIVER_SYNC_MS`
  (default 60 s): new accounts start, dropped connections reconnect, deactivated ones stop. It
  used to start receivers only at boot and never reconnect.
- nodemailer is on v10; v7 carried ten advisories including SMTP/header injection.

### Lead conversion

A lead and the customer it became are **one entity kept by two services**, linked both ways
(migration 017): `leads.converted_customer_id` points forward, `customers.source_lead_id` points
back to the lead the customer was *first* won from. Several leads may point at one customer
(convert reuses a customer with the same email); a lead becomes at most one customer
(`UNIQUE (organization_id, source_lead_id)`).

`POST /api/leads/:id/convert` (lead-service) is **two writes, not one transaction**: customer-service
`POST /customers/from-lead` creates the customer (with the lead's services and notes, and
`leadId`), then lead-service marks the lead `Converted`. What makes it safe is idempotency, not a
distributed transaction: from-lead returns the customer that already carries that `leadId`, so a
retry after the second write failed completes onto the same customer. Keep it that way — see
`lead-service/src/services/leadService.js`.

`POST /api/leads/:id/link` (`leads.update` + `customers.update`) ties an existing customer to a lead
the same way, in the same order (customer-service `PUT /customers/:id/source-lead` first): for
customers won before conversions were recorded. A customer keeps its first lead; a lead already
tied to another customer is refused (409). Once converted, a prospect is history: the board's
`PATCH /leads/:id/prospect` answers 409.

### Frontend

- React + Vite + React Router, plain CSS (`src/styles/`, organized by foundation/layout/components/
  features/pages — no CSS framework/CSS-in-JS).
- `src/api/client.js` is the single fetch wrapper: base URL from
  `import.meta.env.VITE_API_BASE_URL` (Kong), falling back to `http://localhost:8080/api`. It
  attaches `Authorization: Bearer <token>` from `localStorage` (`omnicore_access_token`). All
  other `src/api/*.js` files are thin per-resource wrappers around it. `VITE_` is the only prefix
  Vite exposes to browser code, and the value is read when the dev server starts — changing it
  needs the frontend container restarted, it is not read per request.
- The container runs the Vite **dev server** (`npm start`); `npm run build` is `vite build`, a
  production bundle used only to check the code compiles (it was plain `vite` until 2026-10-06,
  which started a dev server and never exited).
- `src/archieve/` exists in the tree (that's the actual directory name, not a typo to fix
  incidentally) — check whether code there is still referenced before assuming it's dead.
- Routes are permission-gated with `components/auth/RequirePermission.jsx` inside `ProtectedRoute`,
  so a screen someone lacks denies honestly instead of mounting and showing an empty page. The
  sidebar hides the link separately; both are cosmetic — the API is the authority.
- The assistant's conversation lives in `context/AssistantContext.jsx`, above `AppLayout`, so the
  docked panel and the `/assistant` page share one thread. `AssistantThread.jsx` is the shared UI;
  the panel and page are chrome only.
- Assistant replies are rendered as Markdown (`react-markdown` + `remark-gfm`). `rehype-raw` is
  deliberately absent: model output is untrusted, so raw HTML stays escaped.
- The assistant is reachable from a header button and a sidebar entry above Settings. Neither is
  permission-gated, matching the route and the backend.
- The assistant's status orb is `thinking-orbs` (MIT, zero dependencies, a transparent 2D canvas).
  Its state is derived **once**, as `state` in `AssistantContext` (`idle` / `listening` /
  `processing` / `responding` / `confirming`), so the orb and its caption cannot disagree.
  `AssistantOrb.jsx` maps those onto the library's own animations. It does **not** use the
  `<ThinkingOrb>` component: `MorphOrb` draws with the library's engine (`thinking-orbs/engine` —
  `resolvePreset`, `MODE_FRAMES`, `paintFrame`) so it can do two things the component cannot:
  - **Draw at real size.** The component sizes its canvas to the preset, so enlarging it meant
    stretching a 64px raster. The frames are pure vector geometry, so they are painted through a
    scaled context at the CSS size instead; `--orb-scale` is a real size, not a stretch.
  - **Morph between states.** The component restarts on a state change. `blend()` moves each
    dot of the old frame to a dot of the new one over `MORPH_MS`.
  - Still true of the library: `size`/`base` is `64 | 32 | 20` — tuned designs, and
    `resolvePreset` throws above 64. Dark ink vs light ink is pinned from `ThemeContext`, since
    our theme names are not `dark|light`.
  - The canvas is transparent. Never give an orb selector a background, border or shadow — it
    shows as a plate behind the dots instead of letting the glass through.
- The assistant's glass (`backdrop-filter`) is scoped to `.assistant-panel` and
  `.assistant-page-card` only, with separate fills for the light and dark themes. The shared glass
  rule must **not** set `position`: the panel is `position: fixed`, and a `relative` in that
  shared block once unpinned it from the corner (same specificity, later in the file).
- Dashboard figures are built from the caller's own view of leads, customers and services, so its
  Redis cache key includes which of those the caller can read (`readScope`). A key by
  organization alone once served a Dashboard-only grant an admin's figures and lead names.
  Figures are cached 30 s, so any edit shows within half a minute. **Service demand** counts open
  leads and customers, never a converted lead: it is the same entity as its customer, whose
  services are the current truth (counting both once showed a one-service client as three).
- Page chrome (breadcrumb, header, cards) is defined **per page** in `styles/`, not shared — when
  adding a screen, expect to copy a block rather than find a generic rule.
- **New screens follow `frontend/docs/ui-style-guide.md`** — read it before building one. It
  maps each kind of screen to its reference (Dashboard, Clients, client detail, the Add client
  and Add prospect wizards, Deadline rules) and lists what to reuse. Five shared components in
  `src/components/ui/` — `Breadcrumb`, `StatCard`, `WizardSteps`, `ServicePicker`, `PageState` —
  render the existing classes (no CSS of their own); everything else is CSS classes. Rule: a
  multi-line block pasted a third time becomes a `components/ui/` component; one-line class
  usages stay classes. When the guide and a reference screen disagree, the screen wins.
