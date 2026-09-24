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

Each submodule is checked out on `main` at a pinned commit. When editing service code, `cd` into
the submodule — commits there belong to that service's own repo, not the parent. If you change a
submodule and want the parent repo to track the new commit, that's a separate `git add <submodule>`
+ commit in the parent after the submodule itself is committed/pushed.

There are no test suites, linters, or formatters configured anywhere in this repo (parent or any
submodule) — don't assume `npm test`/`eslint` exist.

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
- Each backend service also exposes its own port directly (4001–4007) for debugging, but the
  frontend and inter-service calls always go through the gateway or internal Docker DNS
  (`http://<service-name>:<port>`), never `localhost`, inside containers.
- Individual services can be run outside Docker with `npm start` (or `npm run dev` for
  auto-restart, where available) from within the submodule directory, provided `DB_HOST`,
  `JWT_SECRET`, etc. are set to match `docker-compose.yml`.

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

identity-service serves more than `/api/auth`; each of these is a separate Kong entry pointing
at its own upstream path: `/api/users`, `/api/roles`, `/api/permissions`,
`/api/organizations`, `/api/access-grants`.

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

- `identity-service` issues JWTs (`jsonwebtoken`) on login, signed with `JWT_SECRET`, issuer
  `omnicore-identity-service` (both shared via env vars across every service — a real deployment
  would not hardcode `JWT_SECRET` in `docker-compose.yml` the way this MVP does).
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
  otherwise anyone who could rename a colleague could promote them. (`createUser` is the known
  exception — it still accepts any `roleCode` with `users.create`.)
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
- Tools marked `write: true` are never executed on the model's say-so. They come back as a
  `pendingAction` for the user to confirm, and the confirming call re-checks the permission rather
  than trusting the returned payload.
- The model is reached through OpenRouter. `OPENROUTER_MAX_TOKENS` is capped (default 1024) because
  the provider default is far larger and is billed against the account's headroom. With no
  `OPENROUTER_API_KEY` the assistant returns 503 and nothing else is affected.
- No server-side session: the client posts the whole conversation each turn. Tool results never
  leave the server, so across turns the model works from its own prose, not the raw data.

### Lead conversion

`POST /api/leads/:id/convert` (lead-service) is the one cross-service write transaction: it creates
a customer (via customer-service), copies the lead's service mappings, and marks the lead
`Converted`, committed as a single transaction — see `lead-service/src/services/leadService.js`.

### Frontend

- React + Vite + React Router, plain CSS (`src/styles/`, organized by foundation/layout/components/
  features/pages — no CSS framework/CSS-in-JS).
- `src/api/client.js` is the single fetch wrapper: base URL hardcoded to
  `http://localhost:8080/api` (Kong), attaches `Authorization: Bearer <token>` from
  `localStorage` (`omnicore_access_token`). All other `src/api/*.js` files are thin per-resource
  wrappers around it.
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
- Page chrome (breadcrumb, header, cards) is defined **per page** in `styles/`, not shared — when
  adding a screen, expect to copy a block rather than find a generic rule.
