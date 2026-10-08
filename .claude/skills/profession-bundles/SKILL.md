---
name: profession-bundles
description: Per-milestone detail of the profession bundle capabilities (M2 client profiles and prospects, M3 engagements and fees, M4 deadlines and reminders, M5 documents, M6 vault and files, M7 assistant/dashboard/CSV, M8 customized items and the second bundle). Use when editing customer-, lead-, engagement-, obligation-, document-, vault- or bundle-service bundle code, the bundle frontend screens, or their tests.
---

# Profession bundles — capability detail

The rules and the install/upgrade model are in the root `CLAUDE.md` (**Profession bundles**). This is the per-capability detail.

## Client profiles, prospects and the firm (M2)

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
  lead fields. The prospect wizard records the source (`leads.channel`, default Referral), which
  the Dashboard's Lead Sources counts. Convert links lead and client (see **Lead conversion**); the frontend then opens
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

## Engagements and fees (M3)

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

## Deadlines and reminders (M4)

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

## Documents (M5)

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
- Editing a template's text needs `system.settings` (Documents → a letter → Edit); previewing
  unsaved text through `POST /documents/preview` with a `body` needs it too.
- **CA letters are skeletons**: every field, condition and pre-fill is wired, but the legal
  wording is `[Wording: …]` gaps until the firm supplies it — so none can be finalized as
  shipped. The order letters are offered in is their folder order (`documents/01-…`).


## Vault and files (M6)

- vault-service owns `vault_keys`, `vault_settings`, `portals`, `portal_credentials`,
  `credential_reveals` and `client_files` (migration 019); file bytes live in SeaweedFS.
- **Envelope encryption** (`keyService.js`): `VAULT_MASTER_KEY` (32 bytes, base64; only
  vault-service holds it) wraps one random data key per organization; each credential's secret
  fields are AES-256-GCM under it, with additional data naming organization, client and portal,
  so a ciphertext moved to another row does not decrypt. **Without a valid key the vault
  refuses (503)** rather than storing weakly. **Back up `VAULT_MASTER_KEY`**: losing it makes
  every stored password unreadable. The test stack sets a fixed public test key
  (`docker-compose.test.yml`), so the suite never touches the real one.
- Secrets leave the service in one place only: `POST …/reveal` (`vault.reveal`, a reason of at
  least five characters, rate limited, `Cache-Control: no-store`), recorded in
  `credential_reveals` (plain ids, outlives a purge) and `audit_events`. Listings return the
  fields that are not secret and `hasSecret`. A secret left blank on save keeps the stored one.
  **No credential is saved until the bundle's consent file category (CA:
  `consent_poa_signed`) is on file**, and that file cannot be deleted while credentials rely on
  it. The assistant has no vault tool, and `VAULT_MASTER_KEY`/`S3_*` are blanked for it.
- Files: uploads are multipart, capped at 25 MB (Kong's `request-size-limiting` refuses larger
  bodies first), hashed (sha256) and stored under a random key `org/<id>/<uuid>`; downloads are
  always `attachment` with `nosniff` and `application/octet-stream`. A purge sets
  `client_files.customer_id` NULL; the sweeper (every `VAULT_SWEEP_INTERVAL_MS`, or
  `POST /vault/files/sweep`) deletes the object, then the row.
- A route that streams must finish streaming before it returns: the shared `respond()` wrapper
  answers `{ ok: true }` when nothing has been sent yet (this once corrupted downloads).
- Documents can read `client.portals` (the portals a client has credentials for), so the CA
  power of attorney lists only those (FIX-22).

## Assistant, dashboard and CSV (M7)

- **Assistant.** `middleware/withBundle.js` puts `req.auth.bundle` (`key`, `capabilities`,
  `vocabulary`, or `null`) on every assistant and MCP route, through the copied
  `bundleContext.js`. A tool may declare `capability` (needs that capability in the installed
  bundle) or `needsBundle`; `toolsFor(permissions, bundle)` drops them otherwise, so an
  organization without a bundle has exactly the old catalog. Bundle tools: reads
  `list_obligations`, `get_client_profile` (no bank accounts), `get_engagement`; confirmed
  writes `update_obligation_status`, `record_payment`, `generate_document`. **No tool reaches
  vault-service** — a unit test checks names and run code. The bundle's vocabulary is appended
  to the system prompt.
- **Bundle help.** The last install step, `help`, sends the bundle's `knowledge/*.md` to
  assistant-service (`PUT /assistant/bundles/:key/:version`), stored in `assistant_knowledge`
  tagged `bundle`. The core knowledge sync only replaces points without that tag, and
  `search_help` returns core docs plus the caller's own bundle's.
- **Dashboard (DASH-01).** `GET /bundles/installed` also returns `dashboard` (the bundle's
  cards). dashboard-service computes them from named queries only — `clients_total`,
  `clients_with_service` (`params.services`, catalog keys), `obligations_by_state`
  (`params.state`), `prospects_open` (leads neither converted nor lost; hint: how many are
  quoted) — filtered by each card's permission. CA ships four: clients, prospects, overdue,
  in progress, and returns `bundleCards` (`null`
  without a bundle). With cards the frontend shows them in place of the four core figures;
  everything below is unchanged. dashboard-service carries the whole `Authorization` header as
  its "token", while the copied `bundleContext` adds `Bearer ` itself — strip it before calling
  (a doubled prefix once made every lookup fail quietly and the cards never appeared).
- **CSV (DATA-03–05, FIX-13)**, customer-service `csvService.js`, bundle organizations only:
  `GET /customers/import-template.csv`, `GET /customers/export.csv` (`customers.read`) and
  `POST /customers/import` (`customers.create` + `profiles.update`, a `text/csv` body up to
  2 MB, 1000 rows). Columns follow the bundle (core fields, client schema fields, identifiers,
  `services` as `;`-separated keys, three people, one bank account). Export masks account
  numbers and prefixes `'` to cells a spreadsheet would run as a formula. Import parses real
  CSV (`csv-parse`; quoted fields may span lines), ignores `//` lines, and sends each row
  through `validateProfile` and `createCustomer` with the wizard's `extend` hook, each in its
  own transaction: a duplicate identifier is *skipped*, any other refusal is reported by line.
  The frontend's page is `/clients/import`.
## Customized items and the second bundle (M8)

- **Accept or keep, per item.** An upgrade keeps a firm's edit and flags it; Settings →
  Profession Bundle → *Customized items* (`BundleCustomized.jsx`) lists every item the firm
  edited that the installed version ships differently — only the differing fields, the firm's
  beside the bundle's — with **Accept new** / **Keep mine**. bundle-service
  (`customizedService.js`, `GET`/`POST /bundles/installed/customized`, `bundles.manage`) adds
  no rules of its own: it calls each editable step's **own install endpoint** at the installed
  version — `?dryRun=1` to list (the install runs in its transaction, reports the `customized`
  items it kept, and rolls back), then once more with `accept` or `dismiss: ["kind:key"]` for
  the choice. Audited as `bundle.item_accepted` / `bundle.item_kept`.
- `bundleSync.decide(existing, shipped, { accept, dismiss })`: accept turns a keep into an
  update; dismiss keeps the firm's row and sets its `source_checksum` to the shipped one, so it
  is flagged again only when a later version changes that item. `choicesOf(req)` /
  `optionsFor()` read the request. Still identical in all seven copies. Accepting an email
  automation never switches it on; accepting a document template adds the bundle's text as the
  current version (the firm's stays in the history).
- **A second profession proves the contract.** `tests/fixtures/bundles/legal-practice` (matters
  per calendar year, a court portal, its own namespace `law`) is mounted into the **test**
  stack's registry by `docker-compose.test.yml` and never shipped; `tests/integration/contract.test.js`
  installs it, runs a matter through deadlines, letters, the vault and the dashboard, checks every
  offered bundle for conformance (installs fully, reinstall adds nothing, nothing customized),
  and walks an upgrade through keep / retire / accept / keep mine. A new bundle should pass that
  file unchanged.

## Services own their deadlines and letters

- Every service has a permanent `key`: bundle services from the catalog,
  firm-made ones from their name when created (service-service `uniqueKey`;
  migration 022 backfilled the rest). Seeded defaults stay keyless on purpose:
  the catalog step clears out keyless defaults.
- Deadline rules attach to services by key. A firm adds and edits them on the
  service page (Services → a service → Deadlines), through obligation-service
  `POST/PUT/DELETE /obligations/rules[/:key]` (`obligations.rules`). Each rule is
  checked by bundle-sdk `checkRule` (the contract, the organization's service
  keys, a one-year dry run) and the engagements using that service regenerate,
  so open deadlines move and filed ones never do. A bundle rule is edited or
  switched off, never deleted (an upgrade would bring it back); editing it
  makes it the firm's version at the next upgrade through `bundleSync`.
- The editor (`components/services/RuleForm.jsx`, `ruleTiming.js`) shows
  periodic rules with an optional `{ engaged: <service> }` condition and
  `else`; anything else (relative, manual, other conditions) shows "Set by
  bundle".
- Letters live under **Documents** (top-level, `documents.read`), with what
  each is offered for; `GET /documents/templates` reports `services` and
  `needs`. A service's Letters tab lists the letters whose condition names it.
  Settings → **Update** holds only the profession bundle.

