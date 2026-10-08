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

Standard `docker compose` usage (`up -d`, `ps`, `logs -f <service>`, `up -d --build <service>`,
`down` — volumes persist). `docker compose up migrate` re-runs migrations alone (idempotent).

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

`/api/<prefix>` maps to each service by name (`/api/leads` → lead-service, … `/api/vault` →
vault-service; `/api/mcp` → assistant-service), ports 4001–4012 in the order listed under
**What this is**. `kong/kong.yml` is the authority.

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

`src/server.js` (entrypoint; services do NOT touch schema, see Migrations), `src/app.js` (cors,
json, requestLogger, `/health`, routes), `config/database.js`, `middleware/authenticate.js` and
`requirePermission.js`, then `routes/` → `controllers/` → `services/` (business logic and SQL live
in `services/`).

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
- `seed.js` runs on every start, outside the ledger, so a half-bootstrapped DB self-heals. **There
  is no default admin password.** With `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` both
  set (CI, scripted deployments) it resolves the organization by `BOOTSTRAP_ORG_SLUG` (then lowest
  id, then creates one), creates the admin user only if that email is absent — it never overwrites
  an existing `password_hash`, and refuses a new admin whose password is under 12 characters or the
  retired `ChangeMe123!` — grants SUPER_ADMIN membership, and seeds the default services against
  the *resolved* org id. Setting only one of the two is an error. With **neither** set and no admin
  anywhere, it is a **first run**: it prepares a placeholder organization with the default services
  and email templates (no demo data), stores the hash of a fresh one-time setup code in
  `install_setup` (migration 020) and prints the code to its log (`[SETUP]`). The app then shows
  `pages/Setup/SetupPage.jsx` before anything else: identity-service `POST /setup` (public, Kong
  `/api/setup`; `GET /setup/status`) checks the code (24 h, 10 wrong tries lock it until migrate
  runs again), names the organization, creates the admin as SUPER_ADMIN and closes setup — refused
  for good once completed or once any SUPER_ADMIN exists. An install that already has an admin is
  simply marked set up. `tests/run-first-run.sh` (project `cmfirst`, `docker-compose.firstrun.yml`
  blanking the test admin) proves it in a browser; CI runs it as the `first-run` job. Demo data
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

See `assistant-service/CLAUDE.md` (tool catalog, write confirmation, conversation storage, Qdrant
vector search). Key rule: every tool is an HTTP call onto the owning service with the caller's own
token, and `toolsFor()` filters the catalog before the model sees it.

### Profession bundles (in progress on `develop`)

The next release turns the CRM into a shared core plus an installable profession **bundle**
(CA practice first). Milestones M0–M8 land on `develop`. The release is cut as
`release/v2.0.0` from `develop` (tagged `v2.0.0`) at the end of M8 — **nothing is merged into
`main`**, which stays frozen. Rules already decided — keep to them:

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
  roles → catalog → engagementTypes → obligations → documents → vault → email → help — each a `PUT /<capability path>/bundles/:key/:version` on the
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
- **The plain CRM's generic services leave with a bundle.** The seed's defaults (CRM
  Implementation, Cloud Migration, Data Analytics, IT Support, Consulting) are marked
  `services.seeded_default` (migration 021, which also backfills unedited ones). The catalog step
  deletes those nothing references (`lead_services`, `customer_services`, `engagement_lines`,
  `obligations`) and switches the rest to `Inactive`; a default a bundle adopted (it has a `key`)
  is left alone. An organization without a bundle keeps them.
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

Milestone detail (M2 client profiles … M8 customized items: per-service behaviour, routes,
pitfalls) lives in the `profession-bundles` skill (`.claude/skills/profession-bundles/SKILL.md`)
— load it before working on any bundle capability.

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

See `frontend/CLAUDE.md`. New screens follow `frontend/docs/ui-style-guide.md`.
