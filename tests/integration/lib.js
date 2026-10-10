/*
 * Shared helpers for the integration tests. Everything goes through the Kong
 * gateway of the throwaway `cmtest` stack (see tests/run-integration.sh),
 * exactly as the browser would.
 */

const crypto = require("crypto");
const path = require("path");
const { spawnSync } = require("child_process");

const API = process.env.API_BASE || "http://localhost:18080/api";
const FAKE_MODEL = process.env.FAKE_MODEL_URL || "http://localhost:18099";

// Seeded by docker-compose.test.yml.
const ADMIN = { email: "admin@test.example", password: "Test-Admin-123!" };

async function api(method, path, { token, body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return { status: response.status, body: data };
}

/*
 * Sign-in through Ory Hydra, as the browser does it (auth-hardening P1):
 * /auth/start → Hydra → our login page's challenge → POST /auth/login →
 * consent → /auth/callback (refresh cookie) → POST /auth/refresh (access
 * token). Redirects are followed by hand with a cookie jar, and the login
 * page itself is skipped: only its login_challenge is needed.
 */
const GATEWAY = new URL(API).origin;

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  store(response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute) || /^\s*expires=thu, 01 jan 1970/i.test(attribute));
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  get(name) {
    return this.cookies.get(name);
  }

  set(name, value) {
    this.cookies.set(name, value);
  }
}

// One request, never following a redirect; cookies go only to the gateway.
async function hop(jar, url, init = {}) {
  const sameSite = new URL(url).origin === GATEWAY;
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    headers: { ...(init.headers || {}), ...(sameSite && jar.cookies.size ? { Cookie: jar.header() } : {}) },
  });
  if (sameSite) jar.store(response);
  return response;
}

// Follows redirects through the gateway until one leaves it (into the app).
async function follow(jar, url) {
  let location = url;
  for (let step = 0; step < 10; step += 1) {
    if (new URL(location).origin !== GATEWAY) return location;
    const response = await hop(jar, location);
    const next = response.headers.get("location");
    if (!next) throw new Error(`sign-in stopped at ${location}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    location = new URL(next, location).toString();
  }
  throw new Error("too many redirects");
}

// /auth/start until Hydra hands over to the login page: its login_challenge.
async function loginChallenge(jar) {
  const loginPage = await follow(jar, `${API}/auth/start`);
  const challenge = new URL(loginPage).searchParams.get("login_challenge");
  if (!challenge) throw new Error(`no login_challenge in ${loginPage}`);
  return challenge;
}

async function refresh(jar) {
  const response = await hop(jar, `${API}/auth/refresh`, { method: "POST" });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// The full sign-in: { token, jar, landedOn }. The jar holds the refresh cookie.
async function signIn(email, password) {
  const jar = new CookieJar();
  const challenge = await loginChallenge(jar);

  const login = await hop(jar, `${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, login_challenge: challenge }),
  });
  const body = await login.json().catch(() => null);
  if (login.status !== 200 || !body?.redirect_to) {
    const error = new Error(`login failed for ${email}: ${login.status} ${JSON.stringify(body)}`);
    error.status = login.status;
    throw error;
  }

  const landedOn = await follow(jar, body.redirect_to);
  const session = await refresh(jar);
  if (session.status !== 200) throw new Error(`refresh after sign-in failed: ${session.status} ${JSON.stringify(session.body)}`);

  return { token: session.body.accessToken, jar, landedOn };
}

async function login(email, password) {
  return (await signIn(email, password)).token;
}

// A guest opening their invite link: the same flow, with the invite token in
// place of a password.
async function redeemInvite(inviteToken) {
  const jar = new CookieJar();
  const challenge = await loginChallenge(jar);

  const redeem = await hop(jar, `${API}/access-grants/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: inviteToken, login_challenge: challenge }),
  });
  const body = await redeem.json().catch(() => null);
  if (redeem.status !== 200) return { status: redeem.status, body };

  await follow(jar, body.redirect_to);
  const session = await refresh(jar);
  return { status: session.status, token: session.body?.accessToken, email: body.email, jar };
}

// A request made from inside a container of the stack (for what the gateway
// does not route): returns the HTTP status.
function statusFromInside(service, url, { method = "GET", headers = {}, body } = {}) {
  const script = `fetch(${JSON.stringify(url)}, ${JSON.stringify({ method, headers, body })}).then((r) => console.log(r.status), (e) => { console.error(e.message); process.exit(1); })`;
  const result = spawnSync(
    "docker",
    ["compose", "-p", process.env.TEST_PROJECT || "cmtest", "-f", "docker-compose.yml", "-f", "docker-compose.test.yml", "exec", "-T", service, "node", "-e", script],
    { cwd: path.join(__dirname, "..", ".."), encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`request from ${service} failed: ${result.stderr || result.stdout}`);
  return Number(result.stdout.trim());
}

// Hydra's own CLI inside the cmtest stack (its admin API is not published).
function hydraCli(...args) {
  const result = spawnSync(
    "docker",
    ["compose", "-p", process.env.TEST_PROJECT || "cmtest", "-f", "docker-compose.yml", "-f", "docker-compose.test.yml", "exec", "-T", "hydra", "hydra", ...args, "--endpoint", "http://localhost:4445"],
    { cwd: path.join(__dirname, "..", ".."), encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`hydra ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

const adminToken = () => login(ADMIN.email, ADMIN.password);

function unique(label) {
  return `${label}-${crypto.randomBytes(4).toString("hex")}`;
}

/*
 * A fresh user with the given role, signed in. Each test makes its own, so
 * tests never depend on one another's leftovers.
 */
async function createUser(admin, roleCode, { password = "Member-Pass-123!" } = {}) {
  const email = `${unique(roleCode.toLowerCase())}@test.example`;

  const { status, body } = await api("POST", "/users", {
    token: admin,
    body: { name: unique("Member"), email, password, roleCode },
  });

  if (status !== 201 && status !== 200) {
    throw new Error(`createUser ${roleCode}: ${status} ${JSON.stringify(body)}`);
  }

  return { id: body.id ?? body.user?.id, email, password, token: await login(email, password) };
}

async function modelCalls() {
  const response = await fetch(`${FAKE_MODEL}/__calls`);
  return (await response.json()).calls;
}

async function waitFor(check, { timeout = 30000, interval = 500, what = "condition" } = {}) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const value = await check();

    if (value) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`timed out waiting for ${what}`);
}

const uuid = () => crypto.randomUUID();

/*
 * Direct SQL on the test stack's database, for fixtures the API deliberately
 * cannot create (a user in a second organization). Only ever the `cmtest`
 * project, and it reads the container's own credentials.
 */
function sql(query) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      process.env.TEST_PROJECT || "cmtest",
      "-f",
      "docker-compose.yml",
      "-f",
      "docker-compose.test.yml",
      "exec",
      "-T",
      "postgres",
      "sh",
      "-c",
      'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$0"',
      query,
    ],
    { cwd: path.join(__dirname, "..", ".."), encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(`sql failed: ${result.stderr}`);
  }

  return result.stdout.trim();
}

/*
 * A new organization with its own SUPER_ADMIN, signed in to it — for tests
 * that must not touch the shared test organization (bundle installs). No
 * API creates an organization, so this one SQL step does.
 */
async function organizationWithAdmin(admin, label) {
  const created = await createUser(admin, "SUPER_ADMIN");
  const orgId = sql(
    `INSERT INTO organizations (name, slug) VALUES ('${label}', '${unique("org").toLowerCase()}') RETURNING id`,
  ).split("\n")[0];

  sql(`UPDATE organization_users SET organization_id = ${orgId} WHERE user_id = ${created.id}`);

  // The creation token carried the first organization; sign in again.
  return { orgId: Number(orgId), token: await login(created.email, created.password) };
}

// An organization with the CA Practice bundle installed.
async function caFirm(admin, label = "CA Firm") {
  const firm = await organizationWithAdmin(admin, label);
  const { status, body } = await api("POST", "/bundles/ca-practice/install", { token: firm.token });

  if (status !== 200) {
    throw new Error(`installing ca-practice: ${status} ${JSON.stringify(body)}`);
  }

  return firm;
}

module.exports = { api, login, signIn, refresh, redeemInvite, hop, hydraCli, statusFromInside, CookieJar, GATEWAY, adminToken, createUser, organizationWithAdmin, caFirm, unique, uuid, modelCalls, waitFor, sql, ADMIN };
