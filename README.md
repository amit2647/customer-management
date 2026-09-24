# Customer Management

MVP demonstrating a **Service-Oriented Architecture (SOA)** for customer and lead management.

The platform demonstrates how an **API Gateway** can provide a stable frontend-facing API while independent backend services manage separate business capabilities.

The project is organized as a **multi-repository architecture**. Each service is maintained as an independent Git repository, while the `customer-management` repository acts as the parent repository and uses **Git submodules** to assemble the complete application from ten of them.

---

## Features

### Lead Management

- Create leads
- List leads
- Search leads
- View lead details
- Update lead information
- Update lead status
- Lead scoring
- Track lead acquisition channel
- Assign multiple services to leads
- Remove services from leads
- Convert qualified leads into customers
- Delete leads

### Customer Management

- Create customers
- List customers
- Search customers
- View customer details
- Update customer information
- Assign multiple services to customers
- Remove services from customers
- Delete customers
- Display assigned services

### Service Management

- Create services
- List services
- Search services
- View service details
- Update services
- Activate/deactivate services
- Delete services
- Assign services to leads
- Assign services to customers

### Email Communication

The Email Service provides email as a communication channel for leads and customers.

Current capabilities include:

- SMTP-based email delivery
- IMAP-based inbound mail, threaded onto the originating record
- Email composed and replied to from a lead or customer record
- Communication history on each record
- Email templates with `{{lead.name}}`-style placeholders
- Email automations triggered by `lead.created`, `lead.converted` and
  `customer.created`, delivered through a durable queue with retry and dedupe
- Email API

Automations ship seeded but **disabled**, because they send real mail from the
organization's real mailbox and must be opted into.

Future email capabilities can include:

- Scheduled emails
- Lead nurturing sequences
- SMS and WhatsApp channels

### Dashboard

The Dashboard Service provides aggregated information for the application dashboard.

It is responsible for:

- Dashboard metrics
- Aggregated service data
- Redis-based caching
- Dashboard API endpoints

### Identity and Access Management

The Identity Service provides authentication and authorization capabilities.

Responsibilities include:

- User authentication
- JWT-based authentication
- User management
- Organization management
- Role management, including custom roles scoped to an organization
- Permission management
- Role-based access control

### Just-in-Time Access

Temporary, auditable access to a single screen without changing anyone's role.

- Grant one or more permissions to a user for a fixed period (5 minutes to 24 hours)
- A reason is mandatory, so every grant is auditable
- Grants are read **live on every request** rather than trusted from the token:
  revoking one stops it working immediately, without the holder signing out
- Revoking stamps the row rather than deleting it, preserving the audit trail

### Guest Access

The same mechanism extended to people who have no account at all.

- Grant access to an email address; a one-time invite link is produced
- Opening the link materialises a guest user and starts a session whose token
  carries **no baseline permissions** — everything comes from the live grant
- The link dies exactly when the grant expires or is revoked
- Only a hash of the invite token is stored

### AI Assistant

An in-product assistant that answers questions about the organization's own
data and performs operations on the user's behalf.

- Available from the header on every screen
- Answers only from live data, retrieved through tools
- Confined to the product: off-topic questions are declined
- Constrained to the signed-in user's permissions — the tool catalog is
  filtered before the model is invoked, so the assistant has no vocabulary for
  features the user cannot access
- Changes are never applied on the model's say-so: they are shown for
  confirmation first, and destructive ones are marked
- The same catalog is served over **MCP**, so an external MCP client can drive
  the product with the same JWT

### Schema Migrations

Schema is owned by a dedicated `migrations` repository, never by the services.

- Ordered, checksummed SQL files applied under a PostgreSQL advisory lock
- A `schema_migrations` ledger, so applied files are never re-run
- Services are gated behind the migration run completing successfully
- A seed that is safe to re-run on every boot and never overwrites existing data

---

# Lead Conversion

A qualified lead can be converted into a customer.

The conversion workflow is:

```text
Qualified Lead
      |
      | Convert
      v
Customer Created
      |
      +---- Customer information copied
      |
      +---- Lead services copied
      |
      v
Lead marked as Converted
```

The conversion operation is performed transactionally so that the customer creation, service mapping, and lead status update succeed or fail together.

---

# Architecture

```text
                              Browser
                                 |
                                 | HTTP :3000
                                 v
                         +---------------+
                         | React / Vite  |
                         |   Frontend    |
                         +-------+-------+
                                 |
                                 | REST API
                                 v
      External      +---------------+
      MCP client -->|     Kong      |
                    | API Gateway   |
                    |    :8080      |
                    +-------+-------+
                            |
     +---------+---------+--+------+---------+-----------+
     |         |         |         |         |           |
     v         v         v         v         v           v
 +-------+ +--------+ +-------+ +--------+ +-------+ +-----------+
 | Lead  | |Customer| |Service| |Identity| |Email  | | Assistant |
 | :4001 | | :4002  | | :4003 | | :4004  | | :4006 | |   :4007   |
 +---+---+ +---+----+ +---+---+ +---+----+ +---+---+ +-----+-----+
     |         |          |         |          |           |
     |         |          |         |          |           | tools call
     |         |          |         |          |           | back through
     |         |          |         |          |           | these services
     |         |          |         |          |           | as the user
     +---------+----------+----+----+----------+-----------+
                               |
                               v
                        +-------------+          +-------------+
                        | PostgreSQL  |<---------|   migrate   |
                        |     DB      |  owns    | (runs once, |
                        +-------------+  schema  |  then exits)|
                                                 +-------------+

                        +-------------+
                        |    Redis    |
                        |   Cache     |
                        +------+------+
                               |
                               v
                     Dashboard Service :4005
```

Every service starts only after `migrate` has exited successfully, so the schema
always exists before anything serves traffic.

The Assistant Service holds no business logic of its own: each of its tools is a
call onto one of the other services, made with the signed-in user's own token,
so those services apply their usual permission checks.

> Port numbers are based on the current Docker Compose configuration. Verify `docker-compose.yml` if ports are changed.

---

# Service-Oriented Architecture

The application separates business capabilities into independent services.

```text
+---------------------+
|   Customer Mgmt     |
|   Parent Project    |
+----------+----------+
           |
           +-------------------+
           |                   |
           v                   v
     +-----------+       +-----------+
     | Lead      |       | Customer  |
     | Service   |       | Service   |
     +-----------+       +-----------+
           |
           +-----------+
           |           |
           v           v
     +-----------+ +-----------+
     | Service   | |   Email   |
     | Catalog   | |  Service  |
     +-----------+ +-----------+

     +-----------+       +-----------+
     | Identity  |       | Dashboard |
     | Service   |       | Service   |
     +-----------+       +-----------+

     +-----------+       +-----------+
     | Assistant |       | Migrations|
     | Service   |       | (schema)  |
     +-----------+       +-----------+
```

Each service has its own:

- Source code
- Git repository
- Git history
- Dockerfile
- `package.json`
- API
- Business logic
- Database access layer

---

# Components

## Frontend

The frontend is implemented using:

- React
- Vite
- React Router
- JavaScript
- CSS

The browser communicates with the backend through the Kong API Gateway rather than directly accessing individual services.

The gateway address comes from `VITE_API_BASE_URL`, which docker-compose derives
from `KONG_HOST_PORT`. `VITE_` is the only prefix Vite exposes to browser code,
and the value is read when the dev server starts rather than per request, so
changing it needs the frontend container restarted.

Frontend:

```text
http://localhost:3000
```

---

## Kong API Gateway

Kong acts as the API Gateway between the frontend and backend services.

Gateway:

```text
http://localhost:8080
```

Example routing:

```text
/api/leads/*
       |
       v
Lead Service :4001
```

```text
/api/customers/*
       |
       v
Customer Service :4002
```

```text
/api/services/*
       |
       v
Service Service :4003
```

```text
/api/*
       |
       v
Other backend services
```

The gateway provides a stable API boundary for the frontend and hides internal service addresses.

---

# Backend Services

## Lead Service

**Port:** `4001`

Responsibilities:

- Lead management
- Lead search
- Lead scoring
- Lead status management
- Lead/service relationships
- Lead conversion
- Lead validation
- Organization/user ownership

Main API:

```http
GET    /leads
GET    /leads/:id
POST   /leads
PATCH  /leads/:id
DELETE /leads/:id
GET    /leads/:id/services
PUT    /leads/:id/services
POST   /leads/:id/convert
```

Repository:

```text
lead-service
```

---

## Customer Service

**Port:** `4002`

Responsibilities:

- Customer management
- Customer search
- Customer details
- Customer/service relationships
- Customer validation
- Organization/user ownership

Main API:

```http
GET    /customers
GET    /customers/:id
POST   /customers
PUT    /customers/:id
DELETE /customers/:id
GET    /customers/:id/services
PUT    /customers/:id/services
```

Repository:

```text
customer-service
```

---

## Service Service

**Port:** `4003`

Responsibilities:

- Service catalog management
- Service creation
- Service search
- Service updates
- Service activation/deactivation
- Service deletion

Main API:

```http
GET    /services
GET    /services/:id
POST   /services
PUT    /services/:id
DELETE /services/:id
```

Repository:

```text
service-service
```

---

## Identity Service

**Port:** `4004`

The Identity Service provides authentication and authorization.

Responsibilities:

- Login
- JWT generation
- Authentication
- User management
- Organization management
- Role management, including custom roles
- Permission management
- Authorization
- Just-in-time access grants
- Guest invite issue and redemption

Main API:

```http
POST   /auth/login
GET    /auth/me
GET    /users/:id
POST   /users
GET    /roles
POST   /roles
GET    /permissions
GET    /organizations/:id/users
GET    /access-grants
POST   /access-grants
POST   /access-grants/:id/revoke
POST   /access-grants/redeem      (unauthenticated: the token is the credential)
```

Repository:

```text
identity-service
```

---

## Email Service

**Port:** `4006`

The Email Service provides email-based communication capabilities.

Responsibilities:

- SMTP configuration and delivery
- IMAP polling for inbound replies
- Email sending and in-thread replies
- Communication history per lead/customer
- Email templates
- Email automations and their durable event queue

Main API:

```http
POST   /emails/send
POST   /emails/conversations/:id/reply
GET    /emails/communications
GET    /emails/templates
POST   /emails/templates
GET    /emails/automations
POST   /emails/automations
POST   /emails/automations/trigger
```

Automation events are persisted on receipt and processed by a background runner
that claims due rows with `FOR UPDATE SKIP LOCKED`, retries with exponential
backoff, and de-duplicates on a `dedupe_key` so a producer retry cannot send a
second welcome email.

Repository:

```text
email-service
```

---

## Dashboard Service

**Port:** `4005`

The Dashboard Service provides aggregated dashboard data.

Responsibilities:

- Dashboard metrics
- Data aggregation across the lead, customer and service APIs
- Redis caching
- Dashboard API

Repository:

```text
dashboard-service
```

---

## Assistant Service

**Port:** `4007`

The Assistant Service hosts the in-product AI assistant and an MCP server over a
single tool catalog.

Responsibilities:

- Chat API for the in-product assistant
- MCP server exposing the product's operations
- Tool catalog covering leads, customers, services, dashboard and email
- Permission-scoped tool exposure
- Confirmation gating for anything that changes data

Main API:

```http
POST   /assistant/chat
GET    /assistant/capabilities
POST   /mcp                        (MCP over HTTP)
```

It holds no business logic and touches no business tables. Every tool is an HTTP
call onto the owning service carrying the signed-in user's bearer token, so
authorization is decided in exactly one place — the service that owns the data.
It reads the database only to resolve active just-in-time grants when
authenticating a request.

The model is reached through **OpenRouter**, configured with
`OPENROUTER_API_KEY` and `OPENROUTER_MODEL`. Without a key the assistant returns
503 and the rest of the product is unaffected.

Repository:

```text
assistant-service
```

---

## Migrations

The `migrations` repository owns the database schema. It is not a long-running
service: the `migrate` container runs to completion and exits, and every
DB-backed service is gated behind it with
`condition: service_completed_successfully`.

Responsibilities:

- Ordered, checksummed SQL migrations
- A `schema_migrations` ledger
- Advisory-lock coordination, so concurrent starts cannot race
- Bootstrap and demo seeding

To change the schema, add a new numbered file to `migrations/sql/` — an applied
file is never edited, and a changed checksum logs a warning rather than
re-applying.

Repository:

```text
migrations
```

---

# API Examples

## Get Leads

```http
GET /api/leads
```

Search:

```http
GET /api/leads?q=priya
```

---

## Create Lead

```http
POST /api/leads
Content-Type: application/json
```

Example:

```json
{
  "name": "John Smith",
  "company": "ABC Ltd",
  "email": "john@example.com",
  "phone": "9876543210",
  "channel": "Website",
  "status": "New",
  "score": 50,
  "serviceIds": [1, 2]
}
```

---

## Assign Services to Lead

```http
PUT /api/leads/1/services
Content-Type: application/json
```

```json
{
  "serviceIds": [1, 2, 4]
}
```

Sending an empty array removes all service mappings:

```json
{
  "serviceIds": []
}
```

---

## Convert Lead

```http
POST /api/leads/1/convert
```

The conversion:

1. Finds the lead.
2. Verifies that it has not already been converted.
3. Creates a customer.
4. Copies the lead's customer information.
5. Copies the lead's service mappings.
6. Marks the lead as `Converted`.
7. Commits the operation as a transaction.

---

## Get Customers

```http
GET /api/customers
```

Search:

```http
GET /api/customers?q=amit
```

---

## Create Customer

```http
POST /api/customers
Content-Type: application/json
```

Example:

```json
{
  "name": "Amit Sharma",
  "company": "Example Ltd",
  "email": "amit@example.com",
  "phone": "9876543210",
  "segment": "Enterprise",
  "serviceIds": [1, 3]
}
```

---

## Assign Services to Customer

```http
PUT /api/customers/1/services
Content-Type: application/json
```

```json
{
  "serviceIds": [1, 3, 5]
}
```

---

## Get Services

```http
GET /api/services
```

Search:

```http
GET /api/services?q=cloud
```

---

## Ask the Assistant

```http
POST /api/assistant/chat
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{
  "messages": [{ "role": "user", "content": "How many leads do I have?" }]
}
```

The conversation is sent whole on each turn; the service keeps no session.

A response either answers, or asks for confirmation before changing anything:

```json
{
  "reply": "",
  "steps": [],
  "pendingAction": {
    "name": "create_lead",
    "arguments": { "name": "Priya Nair", "company": "Kestrel Analytics" },
    "summary": "Create lead \"Priya Nair\" at Kestrel Analytics.",
    "destructive": false
  }
}
```

Nothing has been written at this point. To apply it, send the same request again
with the action echoed back under `confirm`. The service re-checks the caller's
permission rather than trusting the returned payload.

---

## Using the MCP Server

The same tool catalog is available over MCP at `/api/mcp`, authenticated with an
ordinary product JWT:

```bash
curl -X POST http://localhost:8080/api/mcp \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The tools returned are scoped to that token's permissions: a user holding only
`leads.read` is offered `list_leads` and `get_lead` and nothing else, and calling
an unlisted tool is refused rather than attempted.

---

# Data Model

The application uses PostgreSQL.

Database:

```text
customer_management
```

The core business entities are:

```text
+----------+
|  leads   |
+----+-----+
     |
     | lead_services
     |
     v
+----------+
| services |
+----+-----+
     ^
     |
     | customer_services
     |
+----+-------+
| customers |
+----------+
```

---

## Tables

### `leads`

Stores prospect information.

Important fields:

```text
id
name
company
email
phone
channel
status
score
created_at
updated_at
```

---

### `customers`

Stores customer information.

Important fields:

```text
id
name
company
email
phone
segment
created_at
updated_at
```

---

### `services`

Stores the service catalog.

Important fields:

```text
id
name
description
category
status
created_at
updated_at
```

---

### `lead_services`

Many-to-many relationship between leads and services.

```text
lead_id
service_id
created_at
```

---

### `customer_services`

Many-to-many relationship between customers and services.

```text
customer_id
service_id
created_at
```

---

## Other Tables

All services share the one `customer_management` database — there is no
per-service database isolation in this MVP. Alongside the business entities
above, the schema holds:

| Group    | Tables                                                                    |
| -------- | ------------------------------------------------------------------------- |
| Identity | `organizations`, `users`, `roles`, `permissions`, `role_permissions`, `organization_users` |
| Access   | `access_grants` (just-in-time and guest access)                           |
| Email    | `email_accounts`, `email_conversations`, `communications`, `email_templates`, `email_automations`, `automation_events` |
| Schema   | `schema_migrations` (the migration ledger)                                |

`services` is owned by the Service Service but referenced by `lead_services` and
`customer_services`, which belong to other services — a shortcut this MVP takes
knowingly.

---

# Authentication and Authorization

The platform includes an Identity Service providing JWT-based authentication and role/permission management.

The authorization model includes roles such as:

- Super Admin
- Operations Manager
- Marketing Manager
- Marketing Specialist
- Sales Manager
- Sales Representative
- Customer Support Agent
- Customer Success Manager

Permissions are baked into the JWT at login. Every service verifies the token
independently, with no call back to the Identity Service per request. The
signing secret and issuer come from `JWT_SECRET` and `JWT_ISSUER`, shared across
every service through `.env`; no service falls back to a default secret, so
verification fails closed if one is missing.

Two things are deliberately *not* taken from the token:

- **Just-in-time grants** are read from the database on every request and merged
  into the caller's permissions. A token cannot be revoked, so a grant that were
  trusted from the token would keep working for the token's full eight hours
  after being withdrawn.
- **Organization scoping** is derived from `req.auth.organizationId`, never from
  client-supplied input.

Grants are additive only: if the lookup fails, the request proceeds with the
token's own permissions, which errs toward denying access.

---

# Roles Matrix

| Role                     | Leads       | Customers | Services | Users  | Organization | Own-record restriction |
| ------------------------ | ----------- | --------- | -------- | ------ | ------------ | ---------------------- |
| Super Admin              | Full        | Full      | Full     | Full   | Full         | No                     |
| Operations Manager       | Full        | Full      | Full     | Manage | Manage       | No                     |
| Marketing Manager        | Full        | Limited   | View     | No     | No           | No                     |
| Marketing Specialist     | Create/View | Limited   | View     | No     | No           | No                     |
| Sales Manager            | Full        | Full      | View     | Team   | No           | No                     |
| Sales Representative     | Own         | Own       | View     | No     | No           | **Yes**                |
| Customer Support Agent   | Limited     | View      | Full     | No     | No           | No                     |
| Customer Success Manager | View        | Full      | View     | No     | No           | No                     |

---

# Docker Deployment

The application is designed to run using Docker Compose.

## Requirements

Install:

- Docker
- Docker Compose

Node.js 20+ is required if running individual services without Docker.

---

## Run with Docker

From the project root:

```bash
docker compose up --build
```

On first start the `migrate` container applies the schema and exits; the
DB-backed services wait for it to finish before starting. Re-running migrations
on their own is safe and idempotent:

```bash
docker compose up migrate
```

Or run in detached mode:

```bash
docker compose up --build -d
```

Check running containers:

```bash
docker compose ps
```

View logs:

```bash
docker compose logs -f
```

View logs for a specific service:

```bash
docker compose logs -f email-service
```

---

# Configuration

`docker-compose.yml` hardcodes nothing. Every value comes from `.env`, with the
previous literals kept as defaults, so the stack boots on a fresh clone with no
`.env` at all. Copy `.env.example` to `.env` to take control of any of them.

`.env` is gitignored — do not commit it.

### Database, cache and authentication

| Variable                      | Default                  | Purpose                                     |
| ----------------------------- | ------------------------ | ------------------------------------------- |
| `DB_HOST`                     | `postgres`               | Compose service name, not `localhost`        |
| `DB_PORT`                     | `5432`                   |                                             |
| `DB_NAME`                     | `customer_management`    | Shared by every service                      |
| `DB_USER` / `DB_PASSWORD`     | `app_user` / `app_password` |                                          |
| `REDIS_URL`                   | `redis://redis:6379`     | In-network address                           |
| `REDIS_HOST_PORT`             | `6379`                   | For connecting from your machine             |
| `JWT_SECRET`                  | development value        | Shared by every service; no service falls back if unset |
| `JWT_ISSUER`                  | `omnicore-identity-service` | Used when signing *and* verifying         |
| `JWT_EXPIRES_IN`              | `8h`                     | Also how long a role change takes to reach someone signed in |

### Ports

`*_SERVICE_PORT` is the port inside the container; `*_SERVICE_HOST_PORT` is what
is published to your machine, for debugging only.

| Variable                                          | Default |
| ------------------------------------------------- | ------- |
| `LEAD_SERVICE_PORT` / `_HOST_PORT`                 | `4001`  |
| `CUSTOMER_SERVICE_PORT` / `_HOST_PORT`             | `4002`  |
| `SERVICE_SERVICE_PORT` / `_HOST_PORT`              | `4003`  |
| `IDENTITY_SERVICE_PORT` / `_HOST_PORT`             | `4004`  |
| `DASHBOARD_SERVICE_PORT` / `_HOST_PORT`            | `4005`  |
| `EMAIL_SERVICE_PORT` / `_HOST_PORT`                | `4006`  |
| `ASSISTANT_SERVICE_PORT` / `_HOST_PORT`            | `4007`  |
| `KONG_HOST_PORT`                                   | `8080`  |
| `FRONTEND_HOST_PORT`                               | `3000`  |
| `VITE_API_BASE_URL`                                | follows `KONG_HOST_PORT` |
| `PUBLIC_APP_URL`                                   | `http://localhost:3000` |

> **The internal service ports are also written into `kong/kong.yml`**, a
> separate submodule that is not templated from here. Changing a
> `*_SERVICE_PORT` means editing `kong.yml` to match, or the gateway routes to a
> dead port. Changing a `*_HOST_PORT` is always safe.
>
> Kong's container-side `8000` and Vite's `3000` are those programs' own ports
> and are not configurable from here.

### Bootstrap and seeding

| Variable                   | Purpose                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `BOOTSTRAP_ORG_NAME`       | Organization created on an empty database                             |
| `BOOTSTRAP_ORG_SLUG`       | Slug used to resolve the organization on every boot                   |
| `BOOTSTRAP_ADMIN_NAME`     | Display name for the first admin                                      |
| `BOOTSTRAP_ADMIN_EMAIL`    | First admin user; an existing user is never overwritten               |
| `BOOTSTRAP_ADMIN_PASSWORD` | Password for that user, on first creation only                        |
| `SEED_DEMO_DATA`           | Seeds two leads and one converted customer. Set `false` for real use  |

Demo seeding only runs on a database with no leads and no customers, so it never
touches a database already in use. The bootstrap seed runs on every start,
outside the migration ledger, so a half-bootstrapped database repairs itself.

### AI assistant

| Variable                | Purpose                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `OPENROUTER_API_KEY`    | Enables the assistant. Empty means it returns 503                 |
| `OPENROUTER_MODEL`      | Any OpenRouter model with tool-calling                            |
| `OPENROUTER_MAX_TOKENS` | Reply cap, default `1024`                                         |

These three are handled differently from everything above. assistant-service
reads them through docker-compose's `env_file` rather than `${VAR}`
interpolation, because interpolation prefers a value exported in your shell and
would silently override the file — so for these, `.env` is the only source.

Two consequences: do not add `OPENROUTER_*` under that service's `environment:`,
since entries there beat `env_file`; and because `env_file` loads the whole file,
the `BOOTSTRAP_*` values are blanked for that one container so the service that
talks to an external model is not also holding the seed admin password.

Everything else *is* shell-overridable, which is normal and useful in CI — only
the OpenRouter settings are pinned to the file.

---

## Proving a From-Scratch Boot

To verify a cold start without destroying local data, use the throwaway parallel
stack rather than `down -v`:

```bash
docker compose -p cmcold -f docker-compose.yml -f docker-compose.cold.yml up --build
docker compose -p cmcold down -v
```

The override strips `container_name` and `ports` so both stacks can run at once.

---

# Application URLs

Frontend:

```text
http://localhost:3000
```

API Gateway:

```text
http://localhost:8080
```

Kong proxy:

```text
http://localhost:8080
```

---

# Docker Services

The Docker Compose environment contains the following major components:

| Component         |     Host port | Purpose                            |
| ----------------- | ------------: | ---------------------------------- |
| Frontend          |          3000 | React application                  |
| Kong              |          8080 | API Gateway (container port 8000)  |
| Lead Service      |          4001 | Lead management                    |
| Customer Service  |          4002 | Customer management                |
| Service Service   |          4003 | Service catalog                    |
| Identity Service  |          4004 | Authentication and authorization   |
| Dashboard Service |          4005 | Dashboard aggregation              |
| Email Service     |          4006 | Email communication                |
| Assistant Service |          4007 | AI assistant and MCP server        |
| migrate           |    — one-shot | Applies the schema, then exits     |
| PostgreSQL        |  — not published | Database (internal network only) |
| Redis             |          6379 | Dashboard caching                  |

The backend ports are published for debugging only. The frontend and all
service-to-service calls go through the gateway or internal Docker DNS
(`http://<service-name>:<port>`), never `localhost`.

> The authoritative port configuration is `docker-compose.yml`.

---

# Service Dependencies

The high-level dependency structure is:

```text
                      migrate
                         |  applies the schema, then exits
                         v
                     PostgreSQL
                         |
       +-----------+-----+-----+-----------+
       |           |           |           |
       v           v           v           v
 Lead Service  Customer   Service      Identity
                Service   Service      Service
       |           |           |           |
       +-----------+-----+-----+-----------+
                         |
                         v
                   Business APIs
                         |
                         v
                    Kong Gateway
                         |
             +-----------+-----------+
             |                       |
             v                       v
         Frontend            External Clients
                                     |
                                     v
                              MCP clients
                                     |
                                     v
                            Assistant Service
                                     |
                       calls the business APIs
                       as the signed-in user


       Redis                  SMTP / IMAP           OpenRouter
         |                         |                    |
         v                         v                    v
 Dashboard Service           Email Service       Assistant Service
```

---

# Health Checks

Every backend service exposes:

```http
GET /health
```

Docker Compose polls these, and dependent services wait on them.

The response always carries the service name and status; some services add a
detail of their own:

```json
{ "status": "ok", "service": "lead-service" }
```

```json
{ "service": "identity-service", "status": "ok", "database": "postgresql" }
```

```json
{ "service": "dashboard-service", "status": "ok", "architecture": "aggregation-service" }
```

---

# Project Structure

The parent repository uses Git submodules for the independently maintained services.

```text
customer-management/
│
├── .git/
├── .gitmodules
│
├── docker-compose.yml
├── README.md
│
├── .env                 (not committed)
├── .env.example
├── docker-compose.yml
├── docker-compose.cold.yml
│
├── kong/                (api_gateway)
│   └── ...
│
├── migrations/          (schema + seed)
│   └── ...
│
├── lead-service/
│   └── ...
│
├── customer-service/
│   └── ...
│
├── service-service/
│   └── ...
│
├── identity-service/
│   └── ...
│
├── dashboard-service/
│   └── ...
│
├── email-service/
│   └── ...
│
├── assistant-service/   (AI assistant + MCP)
│   └── ...
│
└── frontend/            (customer_mgmt_frontend)
    └── ...
```

The parent repository holds only `docker-compose.yml`, the environment files and
this README. All application code lives in the submodules.

---

# Repository Architecture

The project consists of a parent repository and independent service repositories.

| Local Directory       | GitHub Repository        | Purpose                          |
| --------------------- | ------------------------ | -------------------------------- |
| `customer-management` | `customer-management`    | Parent/orchestration repository  |
| `customer-service`    | `customer-service`       | Customer management              |
| `dashboard-service`   | `dashboard-service`      | Dashboard aggregation            |
| `email-service`       | `email-service`          | Email communication              |
| `frontend`            | `customer_mgmt_frontend` | React frontend                   |
| `identity-service`    | `identity-service`       | Authentication and authorization |
| `kong`                | `api_gateway`            | Kong API Gateway configuration   |
| `lead-service`        | `lead-service`           | Lead management                  |
| `service-service`     | `service-service`        | Service catalog                  |
| `migrations`          | `migrations`             | Schema migrations and seed       |
| `assistant-service`   | `assistant-service`      | AI assistant and MCP server      |

Each service maintains its own Git history and can be developed and deployed independently.

Note that two directory names differ from their repository names: `frontend` is
`customer_mgmt_frontend`, and `kong` is `api_gateway`. The mapping is recorded in
`.gitmodules`.

---

# Git Submodules

The parent repository uses Git submodules to reference the service repositories.

Check submodules:

```bash
git submodule status
```

Initialize submodules after cloning:

```bash
git submodule update --init --recursive
```

Clone the complete project:

```bash
git clone --recurse-submodules git@github.com-amit2647:amit2647/customer-management.git
```

If the parent repository has already been cloned:

```bash
git submodule update --init --recursive
```

---

## Working with a Service

Each service is an independent Git repository.

For example:

```bash
cd email-service
```

Make changes and commit them:

```bash
git add .
git commit -m "Add email automation"
git push
```

Then update the parent repository's reference:

```bash
cd ..

git add email-service
git commit -m "Update email-service"
git push
```

The child repository contains the actual service history, while the parent repository records the exact service commit used by the overall application.

---

# Running Without Docker

Each backend service can be run independently, provided `DB_HOST`, `JWT_SECRET`
and the other variables match `docker-compose.yml`, and the schema has already
been applied by the migration runner.

There are no test suites, linters or formatters configured in any repository —
`npm test` and `eslint` do not exist here.

## Lead Service

```bash
cd lead-service
npm install
npm start
```

Runs on:

```text
http://localhost:4001
```

---

## Customer Service

```bash
cd customer-service
npm install
npm start
```

Runs on:

```text
http://localhost:4002
```

---

## Service Service

```bash
cd service-service
npm install
npm start
```

Runs on:

```text
http://localhost:4003
```

---

## Assistant Service

```bash
cd assistant-service
npm install
npm start
```

Runs on:

```text
http://localhost:4007
```

---

## Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend development server runs on the configured Vite port, normally:

```text
http://localhost:3000
```

---

# Database

The application uses PostgreSQL.

Default configuration, all overridable from `.env`:

```text
Database: customer_management     (DB_NAME)
User:     app_user                (DB_USER)
Password: app_password            (DB_PASSWORD)
Host:     postgres                (DB_HOST — the compose service name)
Port:     5432                    (DB_PORT)
```

Postgres is **not published to the host**. Reach it from your machine with:

```bash
docker compose exec postgres psql -U app_user -d customer_management
```

PostgreSQL data is persisted using a Docker volume. Note that `docker compose
down -v` destroys it.

---

# Architectural Principles

## Service Separation

Business capabilities are separated into independent services:

```text
Lead Service
Customer Service
Service Service
Identity Service
Email Service
Dashboard Service
Assistant Service
```

Each service exposes its own API and encapsulates its business logic.

---

## API Gateway

The frontend does not need to know the internal addresses of backend services.

Instead:

```text
Browser
   |
   v
 Kong
   |
   +---- Lead Service
   |
   +---- Customer Service
   |
   +---- Service Service
   |
   +---- Identity Service
   |
   +---- Dashboard Service
   |
   +---- Email Service
   |
   +---- Assistant Service
```

This creates a stable API boundary.

---

## Many-to-Many Relationships

A lead can require multiple services:

```text
Lead A
  |
  +-- Cloud Migration
  +-- Data Analytics
```

A service can also be associated with multiple leads:

```text
Cloud Migration
  |
  +-- Lead A
  +-- Lead B
  +-- Lead C
```

The same relationship model is used for customers.

---

## Transactional Operations

Operations involving multiple database changes use PostgreSQL transactions.

For example, lead conversion performs:

```text
BEGIN
  |
  +-- Create customer
  |
  +-- Copy service mappings
  |
  +-- Mark lead Converted
  |
COMMIT
```

If an error occurs:

```text
ROLLBACK
```

This prevents partially completed conversions.

---

# Purpose

This project is intended as an demonstration of:

- Service-Oriented Architecture
- Microservice-style decomposition
- API Gateway patterns
- RESTful APIs
- JWT authentication
- Role-based access control
- Database persistence
- Relational data modelling
- Many-to-many relationships
- Transaction management
- Docker containerization
- Docker Compose
- Frontend/backend separation
- Service-to-service communication
- Email communication
- Caching with Redis
- Business workflow implementation
- Just-in-time and guest access control
- LLM tool-calling constrained by user permissions
- MCP server implementation
- Git submodule-based multi-repository architecture

It is an MVP and is **not intended to represent a production-ready enterprise CRM**.

---

# Future Improvements

Potential future enhancements include:

### Communication

Implemented: communication history, email automation, communication templates
and event-triggered communication — see **Email Service**.

Potential further capabilities include:

- Scheduled emails
- Lead nurturing sequences (automations currently start a new thread each time)
- SMS integration
- WhatsApp integration
- Omni-channel interaction history

### CRM

- Lead assignment to sales representatives
- Customer lifecycle management
- Customer activity timeline
- Opportunity management
- Tasks and reminders
- Advanced lead scoring

### Platform

- API rate limiting
- Centralized observability
- Distributed tracing
- Message broker integration
- Event-driven architecture
- Dedicated database per service
- Service-to-service authentication (calls currently forward the end user's token)
- Automated testing
- CI/CD pipeline
- Kubernetes deployment
- Secrets management

### AI

Implemented: a conversational CRM assistant, natural-language CRM operations and
an MCP-based application agent — see **Assistant Service**.

Potential further AI capabilities include:

- AI lead qualification
- Lead scoring recommendations
- Customer insights
- AI-drafted email replies
- AI-powered dashboard insights
- Streaming responses in the assistant panel
- Server-side conversation history

---

# Technology Stack

| Layer                   | Technology           |
| ----------------------- | -------------------- |
| Frontend                | React                |
| Build Tool              | Vite                 |
| Routing                 | React Router         |
| Language                | JavaScript           |
| Backend                 | Node.js              |
| API Framework           | Express              |
| API Gateway             | Kong                 |
| Database                | PostgreSQL           |
| Database Driver         | node-postgres (`pg`) |
| Cache                   | Redis                |
| Authentication          | JWT                  |
| Containerization        | Docker               |
| Orchestration           | Docker Compose       |
| Email                   | SMTP and IMAP        |
| AI provider             | OpenRouter           |
| Agent protocol          | Model Context Protocol (MCP) |
| Schema migrations       | Custom runner (SQL + ledger) |
| Version Control         | Git                  |
| Repository Architecture | Git Submodules       |

---

# License

This project is an MVP created for educational and demonstration purposes.
