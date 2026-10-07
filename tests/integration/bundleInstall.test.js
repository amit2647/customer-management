const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, caFirm, createUser, organizationWithAdmin: newOrganization, sql, unique } = require("./lib");

/*
 * Milestone M1: installing the CA Practice bundle, end to end through Kong.
 *
 * Installs go into organizations of their own, so the shared test
 * organization never has a bundle — every other suite keeps proving that an
 * organization without one sees exactly the product it saw before.
 */

let admin;

const organizationWithAdmin = (label) => newOrganization(admin, label);

const count = (query) => Number(sql(query));

before(async () => {
  admin = await adminToken();
});

describe("an organization without a bundle", () => {
  test("has none installed", async () => {
    const { status, body } = await api("GET", "/bundles/installed", { token: admin });

    assert.equal(status, 200);
    assert.deepEqual(body, { bundle: null });
  });

  test("is not offered the capability permissions in its role editor", async () => {
    const { body } = await api("GET", "/permissions", { token: admin });
    const codes = body.map((permission) => permission.code);

    assert.ok(codes.includes("leads.read"));
    assert.equal(codes.includes("profiles.read"), false);
    assert.equal(codes.includes("bundles.manage"), false);
    assert.equal(codes.some((code) => code.startsWith("ca.")), false);
  });

  test("cannot use the deadline events in an automation", async () => {
    const { status } = await api("POST", "/emails/automations", {
      token: admin,
      body: { name: unique("Reminder"), trigger_event: "obligation.due_soon", template_id: 1 },
    });

    assert.equal(status, 400);
  });
});

describe("the bundle registry", () => {
  test("offers CA Practice 0.7.2 to an administrator", async () => {
    const { status, body } = await api("GET", "/bundles", { token: admin });

    assert.equal(status, 200);

    const ca = body.bundles.find((bundle) => bundle.key === "ca-practice");

    assert.equal(ca.version, "0.7.2");
    assert.equal(ca.contents.services, 12);
    assert.deepEqual(ca.contents.roles, ["Partner", "Audit Manager", "Article Assistant", "Accounts Executive"]);
  });

  test("is closed to anyone without bundles.manage", async () => {
    const rep = await createUser(admin, "SALES_REP");

    assert.equal((await api("GET", "/bundles", { token: rep.token })).status, 403);
    assert.equal((await api("POST", "/bundles/ca-practice/install", { token: rep.token })).status, 403);
  });
});

describe("installing CA Practice", () => {
  let firm;

  before(async () => {
    firm = await organizationWithAdmin("CA Firm");
  });

  test("runs every step and ends installed", async () => {
    const { status, body } = await api("POST", "/bundles/ca-practice/install", { token: firm.token });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.bundle.status, "installed");
    assert.deepEqual(
      body.bundle.steps.map((step) => [step.step, step.status]),
      [["permissions", "done"], ["roles", "done"], ["catalog", "done"], ["engagementTypes", "done"], ["obligations", "done"], ["documents", "done"], ["vault", "done"], ["email", "done"], ["help", "done"]],
    );
  });

  test("the organization now reads its bundle's vocabulary and fields", async () => {
    const { body } = await api("GET", "/bundles/installed", { token: firm.token });

    assert.equal(body.bundle.key, "ca-practice");
    assert.equal(body.bundle.vocabulary.period.one, "Financial year");
    assert.deepEqual(body.bundle.pipeline.map((column) => column.label), ["Leads", "In Discussion", "Quote Sent"]);
    assert.equal(body.bundle.profiles.client.schema.properties.constitution.enum.length, 7);
    assert.equal(body.catalog, undefined, "only the public sections are shared");
  });

  test("its catalog holds the 12 services, keyed, and the packages", async () => {
    const { body } = await api("GET", "/services", { token: firm.token });
    const names = body.map((service) => service.name);

    for (const name of ["Statutory Audit", "Tax Audit", "GST Returns", "Income Tax Return", "PTRC / PTEC"]) {
      assert.ok(names.includes(name), `missing ${name}`);
    }

    assert.equal(count(`SELECT count(*) FROM services WHERE organization_id = ${firm.orgId} AND bundle_key = 'ca-practice'`), 12);
    assert.equal(
      count(`SELECT count(*) FROM service_package_items i JOIN service_packages p ON p.id = i.package_id WHERE p.organization_id = ${firm.orgId} AND p.key = 'company_annual'`),
      4,
    );
  });

  test("its role templates became the firm's roles — an Article Assistant sees no passwords", async () => {
    const { body } = await api("GET", "/roles", { token: firm.token });
    const assistant = body.find((role) => role.code === "CA_ARTICLE_ASSISTANT");

    assert.ok(assistant, "CA_ARTICLE_ASSISTANT missing");

    const detail = await api("GET", `/roles/${assistant.id}`, { token: firm.token });
    const codes = detail.body.permissions.map((permission) => permission.code);

    assert.ok(codes.includes("obligations.update"));
    assert.equal(codes.includes("vault.reveal"), false);
    assert.equal(codes.some((code) => code.startsWith("system.")), false);
  });

  test("its role editor now offers the capability and ca.* permissions", async () => {
    const { body } = await api("GET", "/permissions", { token: firm.token });
    const codes = body.map((permission) => permission.code);

    assert.ok(codes.includes("profiles.read"));
    assert.ok(codes.includes("ca.udin.manage"));
  });

  test("its reminder emails arrived switched off", async () => {
    const { body } = await api("GET", "/emails/automations", { token: firm.token });
    const reminders = body.automations.filter((automation) => automation.trigger_event.startsWith("obligation."));

    assert.equal(reminders.length, 2);
    assert.ok(reminders.every((automation) => automation.is_active === false));
  });

  test("installing again changes nothing", async () => {
    const before = sql(`SELECT
      (SELECT count(*) FROM services WHERE organization_id = ${firm.orgId}) || ',' ||
      (SELECT count(*) FROM roles WHERE organization_id = ${firm.orgId}) || ',' ||
      (SELECT count(*) FROM email_automations WHERE organization_id = ${firm.orgId})`);

    const { status, body } = await api("POST", "/bundles/ca-practice/install", { token: firm.token });

    assert.equal(status, 200);
    assert.equal(body.bundle.status, "installed");
    assert.equal(
      sql(`SELECT
        (SELECT count(*) FROM services WHERE organization_id = ${firm.orgId}) || ',' ||
        (SELECT count(*) FROM roles WHERE organization_id = ${firm.orgId}) || ',' ||
        (SELECT count(*) FROM email_automations WHERE organization_id = ${firm.orgId})`),
      before,
    );
  });

  test("the install is in the audit log", () => {
    assert.equal(count(`SELECT count(*) FROM audit_events WHERE organization_id = ${firm.orgId} AND action = 'bundle.installed'`), 1);
  });

  test("the first organization is untouched", () => {
    assert.equal(count("SELECT count(*) FROM services WHERE organization_id = 1 AND bundle_key IS NOT NULL"), 0);
    assert.equal(count("SELECT count(*) FROM organization_bundles WHERE organization_id = 1"), 0);
  });
});

describe("an install that fails part-way", () => {
  let firm;

  before(async () => {
    firm = await organizationWithAdmin("CA Firm Two");

    // A service already holding the name the bundle needs, under a key of its
    // own: the catalog step cannot adopt it, so the install must stop there.
    sql(`INSERT INTO services (organization_id, name, key) VALUES (${firm.orgId}, 'Tax Audit', 'our_tax_audit')`);
  });

  test("stops at the failing step and keeps what finished", async () => {
    const { status, body } = await api("POST", "/bundles/ca-practice/install", { token: firm.token });

    assert.equal(status, 502);
    assert.equal(body.step, "catalog");
    assert.match(body.error, /Install again to resume/);

    const progress = await api("GET", "/bundles/installed/status", { token: firm.token });

    assert.equal(progress.body.bundle.status, "failed");
    assert.deepEqual(
      progress.body.bundle.steps.map((step) => [step.step, step.status]),
      [["permissions", "done"], ["roles", "done"], ["catalog", "failed"], ["engagementTypes", "pending"], ["obligations", "pending"], ["documents", "pending"], ["vault", "pending"], ["email", "pending"], ["help", "pending"]],
    );

    // Not installed yet, so the organization still works as before.
    assert.deepEqual((await api("GET", "/bundles/installed", { token: firm.token })).body, { bundle: null });
  });

  test("installing again resumes at that step without repeating the finished ones", async () => {
    sql(`UPDATE services SET name = 'Tax Audit (old)' WHERE organization_id = ${firm.orgId} AND key = 'our_tax_audit'`);

    const { status, body } = await api("POST", "/bundles/ca-practice/install", { token: firm.token });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.bundle.status, "installed");
    assert.deepEqual(
      body.bundle.steps.map((step) => [step.step, step.attempts]),
      [["permissions", 1], ["roles", 1], ["catalog", 2], ["engagementTypes", 1], ["obligations", 1], ["documents", 1], ["vault", 1], ["email", 1], ["help", 1]],
    );
  });
});

describe("upgrading", () => {
  test("an organization on 0.4.0 upgrades to 0.7.2 in place, gaining what is new and duplicating nothing", async () => {
    const firm = await caFirm(admin, "CA Firm (upgrade)");

    // Make it an organization that installed 0.4.0, before documents existed.
    sql(`INSERT INTO bundle_versions (bundle_key, version, contract_version, manifest, checksum)
         SELECT bundle_key, '0.4.0', contract_version, manifest, repeat('0', 64) FROM bundle_versions
         WHERE bundle_key = 'ca-practice' AND version = '0.7.2' ON CONFLICT DO NOTHING`);
    sql(`UPDATE organization_bundles SET version = '0.4.0' WHERE organization_id = ${firm.orgId}`);
    sql(`UPDATE bundle_install_steps SET version = '0.4.0'
         WHERE organization_bundle_id = (SELECT id FROM organization_bundles WHERE organization_id = ${firm.orgId})`);
    sql(`DELETE FROM document_templates WHERE organization_id = ${firm.orgId}`);
    const services = sql(`SELECT count(*) FROM services WHERE organization_id = ${firm.orgId}`);

    const refused = await api("POST", "/bundles/ca-practice/install", { token: firm.token });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /upgrade to 0.7.2 instead/);

    const upgraded = await api("POST", "/bundles/ca-practice/upgrade", { token: firm.token });

    assert.equal(upgraded.status, 200, JSON.stringify(upgraded.body));
    assert.equal(upgraded.body.bundle.version, "0.7.2");
    assert.equal(upgraded.body.bundle.status, "installed");
    assert.equal((await api("GET", "/bundles/installed", { token: firm.token })).body.bundle.version, "0.7.2");
    assert.equal(sql(`SELECT count(*) FROM document_templates WHERE organization_id = ${firm.orgId} AND is_current`), "8");
    assert.equal(sql(`SELECT count(*) FROM services WHERE organization_id = ${firm.orgId}`), services);
    assert.equal(sql(`SELECT count(*) FROM audit_events WHERE organization_id = ${firm.orgId} AND action = 'bundle.upgraded'`), "1");

    // Upgrading again: nothing left to do.
    assert.equal((await api("POST", "/bundles/ca-practice/upgrade", { token: firm.token })).status, 200);
  });

  test("an organization with nothing installed cannot upgrade", async () => {
    const empty = await newOrganization(admin, "No bundle (upgrade)");

    assert.equal((await api("POST", "/bundles/ca-practice/upgrade", { token: empty.token })).status, 409);
  });
});

describe("the plain CRM's default services", () => {
  test("installing a bundle removes the unused ones, switches off one in use, and leaves the firm's own", async () => {
    const firm = await organizationWithAdmin("CA Firm (defaults)");
    const defaults = [
      ["CRM Implementation", "Technology"], ["Cloud Migration", "Cloud"], ["Data Analytics", "Data"], ["IT Support", "Support"], ["Consulting", "Consulting"],
    ];

    for (const [name, category] of defaults) {
      sql(`INSERT INTO services (organization_id, name, description, category, status, seeded_default)
           VALUES (${firm.orgId}, '${name}', 'seeded', '${category}', 'Active', TRUE)`);
    }
    sql(`INSERT INTO services (organization_id, name, description, category, status) VALUES (${firm.orgId}, 'Our own advisory', 'the firm made it', 'Advisory', 'Active')`);

    const consulting = sql(`SELECT id FROM services WHERE organization_id = ${firm.orgId} AND name = 'Consulting'`);
    const client = await api("POST", "/customers", { token: firm.token, body: { name: unique("Existing client"), serviceIds: [Number(consulting)] } });
    assert.equal(client.status, 201, JSON.stringify(client.body));

    const installed = await api("POST", "/bundles/ca-practice/install", { token: firm.token });
    assert.equal(installed.status, 200, JSON.stringify(installed.body));

    const left = sql(`SELECT name || ':' || status FROM services WHERE organization_id = ${firm.orgId} AND key IS NULL ORDER BY name`).split("\n");
    assert.deepEqual(left, ["Consulting:Inactive", "Our own advisory:Active"]);
    // The client still has the service it took.
    assert.equal(count(`SELECT count(*) FROM customer_services WHERE service_id = ${consulting}`), 1);
  });
});

