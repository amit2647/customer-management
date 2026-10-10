const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, createUser, signIn, refresh, hop, hydraCli, statusFromInside, GATEWAY, ADMIN } = require("./lib");

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

/*
 * Sign-in through Ory Hydra (auth-hardening P1): signed RS256 access tokens
 * for our API only, a rotating refresh token in an httpOnly cookie, and
 * claims rebuilt on every refresh.
 */
const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
const headerOf = (token) => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());

describe("sign-in through Hydra", () => {
  test("ends in the app with an RS256 token for omnicore-api carrying today's claims", async () => {
    const { token, landedOn, jar } = await signIn(ADMIN.email, ADMIN.password);

    assert.match(landedOn, /^http:\/\/localhost:\d+\/$/);
    assert.equal(headerOf(token).alg, "RS256");
    const claims = claimsOf(token);
    assert.ok(claims.aud.includes("omnicore-api"));
    assert.equal(claims.iss, `${GATEWAY}/`);
    assert.equal(claims.role, "SUPER_ADMIN");
    assert.ok(claims.permissions.includes("system.settings"));
    assert.ok(Number(claims.organizationId) > 0);
    // Short-lived: it expires about 5 minutes from now (a few seconds of slack
    // for the stack's clock and rounding against this process's).
    const lifetime = claims.exp - Math.floor(Date.now() / 1000);
    assert.ok(lifetime > 0 && lifetime <= 305, `a short-lived access token (${lifetime} s left)`);

    assert.equal((await api("GET", "/auth/me", { token })).status, 200);
    assert.equal((await api("GET", "/leads", { token })).status, 200);
    assert.equal(jar.get("omnicore_oauth"), undefined, "the PKCE/state cookie is gone");
    assert.ok(jar.get("omnicore_refresh"), "the refresh token is a cookie");
  });

  test("a wrong password through the flow is refused the same way as before", async () => {
    await assert.rejects(signIn(ADMIN.email, "wrong-password"), { status: 401 });
    await assert.rejects(signIn("nobody@test.example", "whatever-123"), { status: 401 });
  });

  test("within the grace period an old refresh token still works (a reload mid-refresh)", async () => {
    const { jar } = await signIn(ADMIN.email, ADMIN.password);
    const earlier = jar.get("omnicore_refresh");
    assert.equal((await refresh(jar)).status, 200);

    jar.set("omnicore_refresh", earlier);
    assert.equal((await refresh(jar)).status, 200, "the page that never stored the rotated cookie");
  });

  test("refresh rotates the refresh token, and both access tokens work", async () => {
    const { jar } = await signIn(ADMIN.email, ADMIN.password);
    const first = jar.get("omnicore_refresh");

    const again = await refresh(jar);
    assert.equal(again.status, 200);
    assert.notEqual(jar.get("omnicore_refresh"), first, "rotated");
    assert.ok(again.body.expiresIn > 0);
    assert.equal((await api("GET", "/leads", { token: again.body.accessToken })).status, 200);
  });

  test("reusing an old refresh token revokes the whole chain", async () => {
    const { jar } = await signIn(ADMIN.email, ADMIN.password);
    const stolen = jar.get("omnicore_refresh");
    assert.equal((await refresh(jar)).status, 200);
    const current = jar.get("omnicore_refresh");

    // Hydra's 10 s rotation grace period (hydra.yml) forgives a page that
    // reloaded mid-refresh; reuse after it is theft.
    await new Promise((resolve) => setTimeout(resolve, 11 * 1000));

    jar.set("omnicore_refresh", stolen);
    assert.equal((await refresh(jar)).status, 401, "the reused token");

    jar.set("omnicore_refresh", current);
    assert.equal((await refresh(jar)).status, 401, "and the newest one with it");
  });

  test("logout revokes the refresh token and clears the cookie", async () => {
    const { jar } = await signIn(ADMIN.email, ADMIN.password);
    const before = jar.get("omnicore_refresh");

    const out = await hop(jar, `${GATEWAY}/api/auth/logout`, { method: "POST" });
    assert.equal(out.status, 204);
    assert.equal(jar.get("omnicore_refresh"), undefined, "cleared");

    jar.set("omnicore_refresh", before);
    assert.equal((await refresh(jar)).status, 401, "revoked");
  });

  test("a role change reaches the token at the next refresh", async () => {
    const admin = await adminToken();
    const member = await createUser(admin, "SALES_REP");
    const { token, jar } = await signIn(member.email, member.password);
    assert.equal(claimsOf(token).role, "SALES_REP");

    const changed = await api("PUT", `/users/${member.id}`, { token: admin, body: { roleCode: "SALES_MANAGER" } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));

    const refreshed = await refresh(jar);
    assert.equal(refreshed.status, 200);
    assert.equal(claimsOf(refreshed.body.accessToken).role, "SALES_MANAGER");
    assert.ok(claimsOf(refreshed.body.accessToken).organizationId, "the full claim set, not just what changed");
  });

  test("a deactivated user's next refresh is refused", async () => {
    const admin = await adminToken();
    const member = await createUser(admin, "SALES_REP");
    const { jar } = await signIn(member.email, member.password);

    assert.equal((await api("PUT", `/users/${member.id}`, { token: admin, body: { status: "Inactive" } })).status, 200);
    assert.equal((await refresh(jar)).status, 401);
  });

  test("a Hydra token for another audience is refused by every service", async () => {
    const client = JSON.parse(hydraCli("create", "oauth2-client", "--name", "integration-other-audience", "--grant-type", "client_credentials", "--audience", "other-api", "--format", "json"));

    try {
      const response = await fetch(`${GATEWAY}/oauth2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString("base64")}`,
        },
        body: new URLSearchParams({ grant_type: "client_credentials", audience: "other-api" }),
      });
      const { access_token: token } = await response.json();
      assert.equal(headerOf(token).alg, "RS256");
      assert.deepEqual(claimsOf(token).aud, ["other-api"]);

      for (const route of ["/leads", "/customers", "/services", "/auth/me", "/dashboard"]) {
        assert.equal((await api("GET", route, { token })).status, 401, route);
      }
    } finally {
      hydraCli("delete", "oauth2-client", client.client_id);
    }
  });

  test("the token hook is not routed, and refuses a caller without Hydra's secret", async () => {
    assert.equal((await fetch(`${GATEWAY}/internal/token-hook`, { method: "POST" })).status, 404, "not on the gateway");
    assert.equal((await fetch(`${GATEWAY}/api/auth/../internal/token-hook`, { method: "POST" })).status, 404, "nor behind /api/auth");

    const body = JSON.stringify({ session: { id_token: { subject: "1" } }, request: { client_id: "omnicore-web" } });
    const headers = { "Content-Type": "application/json" };
    assert.equal(statusFromInside("lead-service", "http://identity-service:4004/internal/token-hook", { method: "POST", headers, body }), 401, "no secret");
    assert.equal(
      statusFromInside("lead-service", "http://identity-service:4004/internal/token-hook", { method: "POST", headers: { ...headers, "X-Token-Hook-Secret": "guess" }, body }),
      401,
      "a wrong secret",
    );
  });

  test("the legacy HS256 login still works during this phase", async () => {
    const { status, body } = await api("POST", "/auth/login", { body: ADMIN });
    assert.equal(status, 200);
    assert.equal(headerOf(body.token).alg, "HS256");
    assert.equal((await api("GET", "/leads", { token: body.token })).status, 200);
  });
});
