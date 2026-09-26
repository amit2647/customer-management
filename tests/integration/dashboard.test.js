const { test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, createUser, unique } = require("./lib");

/*
 * Dashboard figures, and that its 30-second cache is never shared between
 * callers who can read different things.
 */

let admin;

async function dashboard(token) {
  return api("GET", "/dashboard", { token });
}

before(async () => {
  admin = await adminToken();
});

test("the figures agree with the underlying records", async () => {
  const { status, body } = await dashboard(admin);
  assert.equal(status, 200);

  const leads = (await api("GET", "/leads", { token: admin })).body;
  const customers = (await api("GET", "/customers", { token: admin })).body;
  const leadList = Array.isArray(leads) ? leads : leads.leads || [];
  const customerList = Array.isArray(customers) ? customers : customers.customers || [];

  // The cache may be up to 30s old; the other tests only ever add records.
  assert.ok(body.metrics.totalLeads <= leadList.length);
  assert.ok(body.metrics.totalCustomers <= customerList.length);
  assert.ok(body.metrics.convertedLeads <= body.metrics.totalLeads);
  assert.equal(body.managedRecords, body.metrics.totalLeads + body.metrics.totalCustomers);
});

test("a Dashboard-only grant never sees figures cached for an admin", async () => {
  // Warm the cache as the admin, with a recent lead only readers of leads may see.
  const name = unique("DashboardSecret");
  await api("POST", "/leads", { token: admin, body: { name, email: `${name}@test.example` } });
  await dashboard(admin);

  // Someone who holds only reports.read, via just-in-time access.
  const support = await createUser(admin, "CUSTOMER_SUPPORT_AGENT");
  const granted = await api("POST", "/access-grants", {
    token: admin,
    body: { user_id: support.id, permission_code: "reports.read", duration_minutes: 15, reason: "test" },
  });
  assert.equal(granted.status, 201);

  const { status, body } = await dashboard(support.token);

  assert.equal(status, 200, "a source they cannot read must not fail the dashboard");
  assert.equal(body.metrics.totalLeads, 0, "no lead figures without leads.read");
  assert.ok(!JSON.stringify(body).includes(name), "no lead names without leads.read");
});

test("the dashboard needs reports.read", async () => {
  const rep = await createUser(admin, "CUSTOMER_SUPPORT_AGENT");

  assert.equal((await dashboard(rep.token)).status, 403);
});
