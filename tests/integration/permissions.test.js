const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, createUser, unique } = require("./lib");

/*
 * Role-based access, enforced by the service that owns the data. A support
 * agent reads customers but not leads; a sales rep works leads but cannot
 * delete them or manage people.
 */

let admin;
let rep;
let support;

before(async () => {
  admin = await adminToken();
  rep = await createUser(admin, "SALES_REP");
  support = await createUser(admin, "CUSTOMER_SUPPORT_AGENT");
});

describe("Sales Representative", () => {
  test("can read leads", async () => {
    assert.equal((await api("GET", "/leads", { token: rep.token })).status, 200);
  });

  test("cannot delete a lead", async () => {
    const { status } = await api("DELETE", "/leads/1", { token: rep.token });

    assert.equal(status, 403);
  });

  test("cannot list users or roles", async () => {
    assert.equal((await api("GET", "/roles", { token: rep.token })).status, 403);
  });

  test("cannot grant access", async () => {
    const { status } = await api("POST", "/access-grants", {
      token: rep.token,
      body: { user_id: rep.id, permission_code: "leads.delete", duration_minutes: 15, reason: "x" },
    });

    assert.equal(status, 403);
  });
});

describe("Customer Support Agent", () => {
  test("can read customers", async () => {
    assert.equal((await api("GET", "/customers", { token: support.token })).status, 200);
  });

  test("cannot read leads", async () => {
    assert.equal((await api("GET", "/leads", { token: support.token })).status, 403);
  });
});

describe("assigning permissions needs system.settings", () => {
  test("a user cannot change their own role, even as an admin", async () => {
    const me = (await api("GET", "/profile", { token: admin })).body;

    const { status } = await api("PUT", `/users/${me.id}`, {
      token: admin,
      body: { roleCode: "SALES_REP" },
    });

    assert.equal(status, 400);
  });
});

describe("creating users cannot escalate", () => {
  // Operations Manager holds users.create but not system.settings; of the
  // built-in roles, only Customer Support Agent is within its permissions.
  let ops;

  before(async () => {
    ops = await createUser(admin, "OPERATIONS_MANAGER");
  });

  function create(token, roleCode) {
    const email = `${unique("made")}@test.example`;

    return api("POST", "/users", {
      token,
      body: { name: "Made", email, password: "Made-Pass-123!", roleCode },
    });
  }

  test("cannot create a Super Admin", async () => {
    assert.equal((await create(ops.token, "SUPER_ADMIN")).status, 403);
  });

  test("cannot create a role with permissions it lacks", async () => {
    assert.equal((await create(ops.token, "SALES_REP")).status, 403);
  });

  test("can create a role within its own permissions", async () => {
    assert.equal((await create(ops.token, "CUSTOMER_SUPPORT_AGENT")).status, 201);
  });

  test("with system.settings, any role can be assigned", async () => {
    assert.equal((await create(admin, "SALES_REP")).status, 201);
  });

  test("an unknown role is refused", async () => {
    assert.equal((await create(ops.token, "NOT_A_ROLE")).status, 400);
  });
});
