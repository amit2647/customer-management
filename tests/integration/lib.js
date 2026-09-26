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

async function login(email, password) {
  const { status, body } = await api("POST", "/auth/login", { body: { email, password } });

  if (status !== 200 || !body?.token) {
    throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(body)}`);
  }

  return body.token;
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
      "cmtest",
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

module.exports = { api, login, adminToken, createUser, unique, uuid, modelCalls, waitFor, sql, ADMIN };
