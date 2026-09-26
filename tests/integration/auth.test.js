const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, ADMIN } = require("./lib");

/*
 * Sign-in, and that every route behind the gateway refuses an anonymous or
 * forged request.
 */

let admin;

before(async () => {
  admin = await adminToken();
});

describe("login", () => {
  test("the bootstrap admin can sign in", () => {
    assert.ok(admin);
  });

  test("a wrong password is refused", async () => {
    const { status } = await api("POST", "/auth/login", {
      body: { email: ADMIN.email, password: "wrong-password" },
    });

    assert.equal(status, 401);
  });

  test("an unknown email is refused the same way", async () => {
    const { status } = await api("POST", "/auth/login", {
      body: { email: "nobody@test.example", password: "whatever-123" },
    });

    assert.equal(status, 401);
  });

  test("/auth/me describes the caller", async () => {
    const { status, body } = await api("GET", "/auth/me", { token: admin });

    assert.equal(status, 200);
    assert.equal(body.user.role, "SUPER_ADMIN");
  });
});

describe("every service refuses anonymous and forged requests", () => {
  const routes = [
    "/leads",
    "/customers",
    "/services",
    "/dashboard",
    "/users/1",
    "/roles",
    "/access-grants",
    "/emails/templates",
    "/assistant/conversations",
    "/profile",
  ];

  for (const route of routes) {
    test(`GET ${route}`, async () => {
      assert.equal((await api("GET", route)).status, 401, "no token");
      assert.equal((await api("GET", route, { token: "not.a.jwt" })).status, 401, "forged token");
    });
  }
});
