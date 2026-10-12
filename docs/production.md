# Running OmniCore in production

The repository boots on a laptop with nothing configured: every secret has a
public development default and everything speaks plain HTTP on localhost. A
real deployment changes the items below. `.env.example` documents every value;
copy it to `.env` and work through this list.

## 1. One site, behind HTTPS

- Serve the web app and the gateway from **one site** — for example
  `https://app.example.com` for the app and `https://app.example.com/api` (or
  `https://api.example.com`, the same registrable domain) for Kong. The refresh
  token is a `SameSite=Strict` cookie: it is only sent when the app and the
  gateway are the same site.
- Put a TLS-terminating proxy or load balancer in front of the `frontend` and
  `kong` containers. Then set:

  | Setting | Value |
  |---|---|
  | `PUBLIC_APP_URL` | `https://app.example.com` |
  | `VITE_API_BASE_URL` | the gateway's public URL, ending `/api` (rebuild the frontend) |
  | `API_ORIGIN` | the gateway's origin, e.g. `https://app.example.com` |
  | `AUTH_COOKIE_SECURE` | `true` — the refresh cookie is sent over HTTPS only |
  | `HYDRA_SERVE_FLAGS` | empty — drops Hydra's `--dev`, which allows plain-HTTP URLs |

- Hydra's issuer and redirect URLs are written for `http://localhost` in
  `docker-compose.yml` (`x-hydra-environment`): change `URLS_SELF_ISSUER`,
  `URLS_CONSENT`, `URLS_LOGOUT` and identity-service's `OAUTH_REDIRECT_URI`
  and `HYDRA_ISSUER` (every service's) to the public HTTPS URLs. Tokens carry
  the issuer as `iss`, and every service checks it.
- Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` at the
  TLS proxy, or in Kong's `response-transformer` (`kong/kong.yml`) and the
  frontend's `security-headers.conf`. It is deliberately absent on plain HTTP.

## 1a. Production on this machine only

Without a domain and HTTPS, the stack can still run with production secrets
and settings for use on the machine itself: `docker-compose.prod.yml`
publishes only the web app and the gateway, on `127.0.0.1`, and nothing else.
Set `COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml` in `.env` so
plain `docker compose` uses it. `AUTH_COOKIE_SECURE` stays `false` and
`HYDRA_SERVE_FLAGS` keeps `--dev` there, since both need HTTPS.

## 2. Publish only the front door

`docker-compose.yml` publishes every service's port (4001–4012) for local
debugging, plus Redis. In production publish **only** the TLS proxy (or the
`frontend` and `kong` ports behind it). Nothing else should be reachable from
outside the host:

- the services trust `X-Forwarded-For` from one proxy hop (Kong); reached
  directly, a caller could choose the address the sign-in rate limit counts;
- Postgres, Qdrant, SeaweedFS and Hydra's admin API already publish nothing,
  and Hydra's admin side sits on the internal `hydra-admin` network, which only
  identity-service and Postgres join.

## 3. Your own secrets

Every secret below has a public development default. Generate each one
(`openssl rand -hex 32`, or `-base64 32` where noted) and keep them in a
secrets manager, not in the repository:

| Setting | Held by | Notes |
|---|---|---|
| `DB_PASSWORD`, `HYDRA_DB_PASSWORD` | Postgres, services, Hydra | |
| `HYDRA_SECRETS_SYSTEM` | Hydra | ≥ 32 characters; encrypts Hydra's data at rest — see rotation below |
| `OAUTH_CLIENT_SECRET` | identity-service | the `omnicore-web` client |
| `TOKEN_HOOK_SECRET` | Hydra, identity-service | |
| `SERVICE_JWT_SECRET` | obligation-, identity-, email-service | service-to-service tokens |
| `MFA_ENCRYPTION_KEY` | identity-service | `-base64 32`; **back it up** — without it every two-factor secret is unreadable and everyone must be reset |
| `VAULT_MASTER_KEY` | vault-service | `-base64 32`; **back it up** — without it every stored portal password is lost |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | SeaweedFS, vault-service | |
| `QDRANT_API_KEY` | Qdrant, assistant-service | |
| `SYSTEM_SMTP_*` | email-service | the account that sends verification email |
| `OPENROUTER_API_KEY` | assistant-service | |

assistant-service loads the whole `.env` (its `env_file`), so every new secret
must also be blanked under its `environment:` — see the Configuration section
of `CLAUDE.md`.

Set `SEED_DEMO_DATA=false`, and either leave `BOOTSTRAP_ADMIN_*` unset (the
first visit runs browser setup with a one-time code from the `migrate` log) or
set both to create the first admin from the environment.

## 4. Rotating `HYDRA_SECRETS_SYSTEM`

Hydra takes a **list** of system secrets: the first encrypts, every one
decrypts, so a rotation adds the new secret first and keeps the old one after
it until nothing encrypted under it remains (sessions expire within
`HYDRA_TTL_REFRESH_TOKEN`, 7 days by default).

Verified on Hydra v26.2.0 (2026-10-12): `SECRETS_SYSTEM` takes a
comma-separated list, so set `HYDRA_SECRETS_SYSTEM=new,old` in `.env` — never
in `hydra/hydra.yml`, which is committed. Hydra kept serving the signing keys
encrypted under the old secret, and sign-in worked end to end. Drop `,old`
once sessions issued before the rotation have expired.

Restart both Hydra containers after changing it.

## 5. Sign-in protection to review

| Setting | Default | What it does |
|---|---|---|
| `AUTH_RATE_LIMIT_PER_MINUTE` | 30 | requests per address per minute to each sign-in endpoint; raise it if many people share one office address |
| `LOGIN_MAX_FAILED_ATTEMPTS` / `LOGIN_LOCK_MINUTES` | 10 / 15 | wrong passwords in a row before an account locks, and for how long |
| `MFA_MAX_FAILED_CODES` / `MFA_LOCK_MINUTES` | 5 / 15 | the same for two-factor codes |
| `AUTH_SESSION_MAX_AGE` / `HYDRA_TTL_REFRESH_TOKEN` | 30 days / 7 days | a session's longest life, and its idle timeout |
| `PASSWORD_MIN_LENGTH` / `ADMIN_PASSWORD_MIN_LENGTH` | 8 / 12 | rebuild the frontend after changing them, so its forms agree |

Consider requiring two-factor sign-in for the whole organization (Settings →
Organization). The sign-in history (Profile → Sign-in activity; Users →
Activity for admins) shows wrong passwords, lockouts and two-factor changes.

## 6. Backups

Back up the Postgres volume (`postgres_data`: the application and Hydra's
databases), the SeaweedFS volume (`seaweedfs_data`: client files) and the two
keys above. Qdrant's index (`qdrant_data`) can be rebuilt from Postgres.
