const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");

const { api, adminToken, waitFor, sql } = require("./lib");

/*
 * Milestone M0 of the profession-bundle platform: the foundations are in place
 * and change nothing for an organization without a bundle (every other suite
 * in this directory is the proof of that half).
 */

// Capability services that have no routes of their own yet (bundle-service
// gained its routes in M1, engagement- and obligation-service in M3 and M4;
// each has its own tests).
const CAPABILITIES = ["documents", "vault"];

// Runs a command inside one of this stack's containers.
function exec(service, command) {
  return spawnSync(
    "docker",
    ["compose", "-p", "cmtest", "-f", "docker-compose.yml", "-f", "docker-compose.test.yml", "exec", "-T", service, "sh", "-c", command],
    { cwd: path.join(__dirname, "..", ".."), encoding: "utf8" },
  );
}

function tokenPermissions(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).permissions;
}

let admin;

before(async () => {
  admin = await adminToken();
});

describe("capability services", () => {
  test("/api/bundles reaches bundle-service through Kong", async () => {
    const response = await waitFor(
      async () => {
        const result = await api("GET", "/bundles/installed", { token: admin });

        return [502, 503].includes(result.status) ? null : result;
      },
      { timeout: 60000, what: "bundle-service" },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { bundle: null });
  });

  for (const prefix of CAPABILITIES) {
    test(`/api/${prefix} reaches its own service through Kong`, async () => {
      // Kong answers a path it has no route for itself, with JSON; a request
      // it forwarded is answered by Express, which has no routes yet in M0.
      const response = await waitFor(
        async () => {
          const result = await api("GET", `/${prefix}`, { token: admin });

          return [502, 503].includes(result.status) ? null : result;
        },
        { timeout: 60000, what: `${prefix} upstream` },
      );

      assert.equal(response.status, 404);
      assert.match(String(response.body), new RegExp(`Cannot GET /${prefix}`));
    });
  }
});

describe("schema", () => {
  test("migrations 013 and 014 are applied", () => {
    const applied = sql("SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations WHERE version >= '013'");

    assert.match(applied, /013_bundles/);
    assert.match(applied, /014_bundle_hooks/);
  });

  test("the administrator holds the capability permissions", () => {
    const permissions = tokenPermissions(admin);

    for (const code of ["bundles.manage", "customers.purge", "profiles.read", "obligations.rules", "vault.reveal", "files.upload"]) {
      assert.ok(permissions.includes(code), `missing ${code}`);
    }
  });

  test("an organization has one bundle at most", () => {
    const constraint = sql(
      "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'organization_bundles_organization_unique'",
    );

    assert.equal(constraint, "UNIQUE (organization_id)");
  });

  test("automations accept the capability events", () => {
    const check = sql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'email_automations_trigger_event_check'");

    for (const event of ["lead.created", "obligation.due_soon", "obligation.overdue", "engagement.created"]) {
      assert.ok(check.includes(event), `missing ${event}`);
    }
  });

  test("existing customers carry empty bundle attributes, not nulls", () => {
    assert.equal(sql("SELECT count(*) FROM customers WHERE attributes IS NULL"), "0");
  });
});

describe("object store (SeaweedFS)", () => {
  test("is healthy", () => {
    const result = exec("seaweedfs", "wget -qO- http://127.0.0.1:8333/healthz >/dev/null && echo ok");

    assert.equal(result.stdout.trim(), "ok", result.stderr);
  });

  test("refuses unsigned requests — never anonymous", () => {
    const result = exec("seaweedfs", "wget -S -qO- http://127.0.0.1:8333/client-files 2>&1 | head -1");

    assert.match(result.stdout, /403/);
  });

  test("its keys reach vault-service and never the assistant", () => {
    const vault = exec("vault-service", 'test -n "$S3_SECRET_KEY" && echo set');
    const assistant = exec("assistant-service", 'test -z "$S3_SECRET_KEY$VAULT_MASTER_KEY" && echo blank');

    assert.equal(vault.stdout.trim(), "set");
    assert.equal(assistant.stdout.trim(), "blank");
  });
});
