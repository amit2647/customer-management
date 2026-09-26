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

Every repo has tests; there are still no linters or formatters (don't assume `eslint`/`prettier`).
See **Testing** below.

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
password.

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
- Each backend service also exposes its own port directly (4001–4007) for debugging, but the
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

### Lead conversion

`POST /api/leads/:id/convert` (lead-service) is the one cross-service write transaction: it creates
a customer (via customer-service), copies the lead's service mappings, and marks the lead
`Converted`, committed as a single transaction — see `lead-service/src/services/leadService.js`.

### Frontend

- React + Vite + React Router, plain CSS (`src/styles/`, organized by foundation/layout/components/
  features/pages — no CSS framework/CSS-in-JS).
- `src/api/client.js` is the single fetch wrapper: base URL from
  `import.meta.env.VITE_API_BASE_URL` (Kong), falling back to `http://localhost:8080/api`. It
  attaches `Authorization: Bearer <token>` from `localStorage` (`omnicore_access_token`). All
  other `src/api/*.js` files are thin per-resource wrappers around it. `VITE_` is the only prefix
  Vite exposes to browser code, and the value is read when the dev server starts — changing it
  needs the frontend container restarted, it is not read per request.
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
- Page chrome (breadcrumb, header, cards) is defined **per page** in `styles/`, not shared — when
  adding a screen, expect to copy a block rather than find a generic rule.
