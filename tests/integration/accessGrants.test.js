const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, createUser, unique } = require("./lib");

/*
 * Just-in-time access is read live on every request, so a grant and its
 * revocation take effect on an unchanged token. Guests get only what they
 * were granted.
 */

let admin;

before(async () => {
  admin = await adminToken();
});

describe("member grants", () => {
  test("take effect and are revoked on the same token", async () => {
    const support = await createUser(admin, "CUSTOMER_SUPPORT_AGENT");

    assert.equal((await api("GET", "/leads", { token: support.token })).status, 403, "before");

    const granted = await api("POST", "/access-grants", {
      token: admin,
      body: { user_id: support.id, permission_code: "leads.read", duration_minutes: 15, reason: "test" },
    });
    assert.equal(granted.status, 201, JSON.stringify(granted.body));

    assert.equal((await api("GET", "/leads", { token: support.token })).status, 200, "granted");

    const grantId = granted.body.grants[0].id;
    const revoked = await api("POST", `/access-grants/${grantId}/revoke`, { token: admin });
    assert.equal(revoked.status, 200);

    assert.equal((await api("GET", "/leads", { token: support.token })).status, 403, "revoked");
  });

  test("durations outside 5 minutes to 24 hours are refused", async () => {
    const support = await createUser(admin, "CUSTOMER_SUPPORT_AGENT");

    for (const minutes of [1, 60 * 24 + 1]) {
      const { status } = await api("POST", "/access-grants", {
        token: admin,
        body: { user_id: support.id, permission_code: "leads.read", duration_minutes: minutes, reason: "x" },
      });

      assert.equal(status, 400, `${minutes} minutes`);
    }
  });
});

describe("guest invites", () => {
  let guestToken;
  let inviteToken;

  before(async () => {
    const granted = await api("POST", "/access-grants", {
      token: admin,
      body: {
        subject_email: `${unique("guest")}@test.example`,
        permission_code: "leads.read",
        duration_minutes: 30,
        reason: "integration test",
      },
    });

    assert.equal(granted.status, 201, JSON.stringify(granted.body));
    inviteToken = granted.body.inviteToken;
    assert.ok(inviteToken, "an external grant returns an invite token");

    const redeemed = await api("POST", "/access-grants/redeem", { body: { token: inviteToken } });
    assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
    guestToken = redeemed.body.token;
  });

  test("the guest can use what was granted", async () => {
    assert.equal((await api("GET", "/leads", { token: guestToken })).status, 200);
  });

  test("and nothing else", async () => {
    for (const route of ["/customers", "/services", "/dashboard", "/roles"]) {
      assert.equal((await api("GET", route, { token: guestToken })).status, 403, route);
    }
  });

  test("a guest cannot sign in with a password", async () => {
    const { status } = await api("POST", "/auth/login", {
      body: { email: "guest@test.example", password: "anything-123" },
    });

    assert.equal(status, 401);
  });

  test("the link can be reopened while the grant is active (another device, lost session)", async () => {
    const again = await api("POST", "/access-grants/redeem", { body: { token: inviteToken } });

    assert.equal(again.status, 200);
    assert.equal((await api("GET", "/leads", { token: again.body.token })).status, 200);
  });

  test("a made-up invite token is refused", async () => {
    const { status } = await api("POST", "/access-grants/redeem", { body: { token: "not-a-real-token" } });

    assert.equal(status, 404);
  });
});

test("a revoked invite link stops working", async () => {
  const admin = await adminToken();
  const granted = await api("POST", "/access-grants", {
    token: admin,
    body: {
      subject_email: `${unique("revoked-guest")}@test.example`,
      permission_code: "leads.read",
      duration_minutes: 30,
      reason: "integration test",
    },
  });

  await api("POST", `/access-grants/${granted.body.grants[0].id}/revoke`, { token: admin });

  const { status } = await api("POST", "/access-grants/redeem", { body: { token: granted.body.inviteToken } });
  assert.equal(status, 404);
});
