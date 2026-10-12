const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");

const { api, adminToken, createUser, signIn, hop, statusFromInside, GATEWAY } = require("./lib");

/*
 * Hardening around sign-in (auth hardening P6): Hydra's admin API on its own
 * network, the per-account password lockout, the per-address rate limit, the
 * sign-in history, and the security headers on every API answer.
 */

let admin;

before(async () => {
  admin = await adminToken();
});

// A small script run inside a container of the test stack; prints its result.
function runInside(service, script) {
  const result = spawnSync(
    "docker",
    ["compose", "-p", process.env.TEST_PROJECT || "cmtest", "-f", "docker-compose.yml", "-f", "docker-compose.test.yml", "exec", "-T", service, "node", "-e", script],
    { cwd: path.join(__dirname, "..", ".."), encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`script in ${service} failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim());
}

describe("Hydra's admin API", () => {
  test("is reachable from identity-service, its one client", () => {
    assert.equal(statusFromInside("identity-service", "http://hydra-admin:4445/health/ready"), 200);
  });

  test("is not reachable from any other service, nor through the public process", () => {
    for (const service of ["lead-service", "assistant-service"]) {
      assert.throws(() => statusFromInside(service, "http://hydra-admin:4445/health/ready"), undefined, `${service} → hydra-admin`);
      assert.throws(() => statusFromInside(service, "http://hydra:4445/health/ready"), undefined, `${service} → hydra:4445`);
    }
    assert.equal(statusFromInside("lead-service", "http://hydra:4444/health/ready"), 200, "the public side still is");
  });
});

describe("wrong passwords", () => {
  test("lock the account after ten in a row, and then even the right password is refused", async () => {
    const member = await createUser(admin, "SALES_REP");

    for (let attempt = 1; attempt < 10; attempt += 1) {
      await assert.rejects(signIn(member.email, "not-the-password"), { status: 401 });
    }
    await assert.rejects(signIn(member.email, "not-the-password"), (error) => {
      assert.equal(error.status, 429);
      assert.match(error.message, /account_locked/);
      return true;
    });
    await assert.rejects(signIn(member.email, member.password), { status: 429 });

    const history = await api("GET", `/users/${member.id}/activity`, { token: admin });
    const events = history.body.events.map((event) => event.event);
    assert.ok(events.includes("login.locked"));
    assert.ok(events.includes("login.blocked"));
    assert.equal(events.filter((event) => event === "login.failed").length, 9);
  });
});

describe("the rate limit", () => {
  test("refuses one address after its requests for the minute, with Retry-After", () => {
    // Straight at identity-service from inside the network, as one made-up
    // address (the test stack allows 1000 a minute; Kong's own address would
    // be shared with every other test).
    const result = runInside(
      "lead-service",
      `(async () => {
        const counts = {}; let retryAfter = null;
        for (let i = 0; i < 1005; i += 1) {
          const r = await fetch("http://identity-service:4004/auth/verify-email", { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.77" }, body: JSON.stringify({ token: "x" }) });
          counts[r.status] = (counts[r.status] || 0) + 1;
          if (r.status === 429) retryAfter = r.headers.get("retry-after");
        }
        console.log(JSON.stringify({ counts, retryAfter }));
      })()`,
    );

    assert.equal(result.counts[400], 1000, "a junk link is refused normally until the limit");
    assert.equal(result.counts[429], 5);
    assert.ok(Number(result.retryAfter) > 0);
  });
});

describe("the sign-in history", () => {
  test("shows a member their own sign-ins and wrong passwords, with where from; an admin sees them too", async () => {
    const member = await createUser(admin, "SALES_REP");
    await assert.rejects(signIn(member.email, "wrong-once"), { status: 401 });
    const { token, jar } = await signIn(member.email, member.password);

    const own = await api("GET", "/profile/activity", { token });
    assert.equal(own.status, 200);
    const [latest, previous] = own.body.events;
    assert.equal(latest.event, "login.succeeded");
    assert.equal(latest.label, "Signed in");
    assert.ok(latest.ip, "where from");
    assert.ok(own.body.events.some((event) => event.event === "email.verified"));
    assert.equal(previous.event, "login.failed");

    await hop(jar, `${GATEWAY}/api/auth/logout`, { method: "POST" });
    const after = await api("GET", `/users/${member.id}/activity`, { token: admin });
    assert.equal(after.body.events[0].event, "logout");
  });

  test("another member's history needs system.settings", async () => {
    const member = await createUser(admin, "SALES_REP");
    const manager = await createUser(admin, "SALES_MANAGER");
    assert.equal((await api("GET", `/users/${member.id}/activity`, { token: manager.token })).status, 403);
  });
});

describe("security headers", () => {
  test("every API answer through the gateway forbids being rendered or framed", async () => {
    for (const path of ["/api/auth/start", "/api/leads"]) {
      const response = await fetch(`${GATEWAY}${path}`, { redirect: "manual" });
      assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'", path);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
      assert.equal(response.headers.get("x-frame-options"), "DENY", path);
    }
  });
});
