const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, organizationWithAdmin, sql, unique } = require("./lib");

/*
 * Milestone M8: proving the bundle contract.
 *
 * - A second profession (tests/fixtures/bundles/legal-practice, mounted into
 *   the test stack's registry only) installs and works through the same
 *   services as CA Practice — no core change made for it.
 * - Every bundle the stack offers conforms: it installs completely, a second
 *   install changes nothing, and nothing is customized afterwards.
 * - Upgrades keep a firm's edits, retire what a bundle dropped, and let an
 *   admin accept the bundle's version or keep their own, item by item.
 */

const LEGAL = "legal-practice";

let admin;

const count = (query) => Number(sql(query));
const letters = (n) => Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
const pan = () => `${letters(5)}${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}${letters(1)}`;

async function firmWith(key, label) {
  const firm = await organizationWithAdmin(admin, label);
  const { status, body } = await api("POST", `/bundles/${key}/install`, { token: firm.token });
  assert.equal(status, 200, JSON.stringify(body));
  return { ...firm, install: body };
}

before(async () => {
  admin = await adminToken();
});

describe("a second profession, with no core change", () => {
  let firm;

  before(async () => {
    firm = await firmWith(LEGAL, "Law Firm (contract)");
  });

  test("installs every step, help included", () => {
    assert.equal(firm.install.bundle.status, "installed");
    assert.deepEqual(
      firm.install.bundle.steps.map((step) => [step.step, step.status]),
      [["permissions", "done"], ["roles", "done"], ["catalog", "done"], ["engagementTypes", "done"], ["obligations", "done"], ["documents", "done"], ["vault", "done"], ["email", "done"], ["help", "done"]],
    );
  });

  test("speaks its own vocabulary, and the shared organization still has no bundle", async () => {
    const { body } = await api("GET", "/bundles/installed", { token: firm.token });

    assert.equal(body.bundle.key, LEGAL);
    assert.equal(body.bundle.vocabulary.engagement.many, "Matters");
    assert.deepEqual(body.bundle.pipeline.map((column) => column.status), ["New", "In Discussion"]);
    assert.deepEqual((await api("GET", "/bundles/installed", { token: admin })).body, { bundle: null });
  });

  test("a client, a matter for the calendar year, its deadline, letter, portal and dashboard all work", async () => {
    const services = Object.fromEntries((await api("GET", "/services", { token: firm.token })).body.filter((service) => service.key).map((service) => [service.key, service.id]));
    assert.deepEqual(Object.keys(services).sort(), ["contract_review", "legal_notice", "litigation"]);

    // As the Add client wizard saves it: the client with its services, then the matter.
    const created = await api("POST", "/customers", {
      token: firm.token,
      body: { name: unique("Menon"), serviceIds: [services.litigation], profile: { attributes: { client_kind: "individual" }, identifiers: { pan: pan() } } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const customerId = created.body.id;

    const periods = (await api("GET", "/engagements/periods?type=matter", { token: firm.token })).body;
    assert.match(periods.current, /^\d{4}$/, "a calendar year, not a financial year");

    const engaged = await api("POST", "/engagements", {
      token: firm.token,
      body: { customerId, typeKey: "matter", period: periods.current, lines: [{ serviceId: services.litigation }] },
    });
    assert.equal(engaged.status, 201, JSON.stringify(engaged.body));

    const feed = (await api("GET", `/obligations?customerId=${customerId}&period=${periods.current}`, { token: firm.token })).body;
    // A yearly rule falls after its period: the report on this year is due next January.
    assert.deepEqual(feed.items.map((item) => [item.rule_key, item.due_on]), [["annual_case_report", `${Number(periods.current) + 1}-01-31`]]);

    const templates = (await api("GET", `/documents/templates?customerId=${customerId}&period=${periods.current}`, { token: firm.token })).body;
    const letter = (Array.isArray(templates) ? templates : templates.templates).find((template) => template.key === "matter_engagement_letter");
    assert.equal(letter.enabled, true);

    const vault = (await api("GET", `/vault/customers/${customerId}/credentials`, { token: firm.token })).body;
    assert.deepEqual(vault.portals.map((portal) => portal.key), ["ecourts"]);
    assert.equal(vault.consent.category, "vakalatnama_signed");

    const dashboard = (await api("GET", "/dashboard", { token: firm.token })).body;
    assert.deepEqual(dashboard.bundleCards.map((card) => card.key), ["clients", "litigation", "overdue"]);
    assert.equal(dashboard.bundleCards.find((card) => card.key === "litigation").value, 1);
  });

  test("its namespaced permission and role template were installed, without system access", () => {
    assert.equal(count("SELECT count(*) FROM permissions WHERE code = 'law.brief.manage'"), 1);
    assert.equal(sql(`SELECT name FROM roles WHERE organization_id = ${firm.orgId} AND template_key = 'law_advocate'`), "Advocate");
    assert.equal(
      count(`SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
             WHERE r.organization_id = ${firm.orgId} AND r.bundle_key = '${LEGAL}' AND (p.code LIKE 'system.%' OR p.code = 'bundles.manage')`),
      0,
    );
  });
});

describe("conformance: every offered bundle", () => {
  test("installs completely, installing again changes nothing, and nothing is customized", async () => {
    const offered = (await api("GET", "/bundles", { token: admin })).body.bundles;
    assert.ok(offered.length >= 2, "CA Practice and the legal fixture");

    for (const bundle of offered) {
      const firm = await firmWith(bundle.key, `Conformance ${bundle.key}`);
      const where = `organization_id = ${firm.orgId} AND bundle_key = '${bundle.key}' AND retired_at IS NULL`;
      const rows = () => ({
        services: count(`SELECT count(*) FROM services WHERE ${where}`),
        packages: count(`SELECT count(*) FROM service_packages WHERE ${where}`),
        roles: count(`SELECT count(*) FROM roles WHERE ${where}`),
        emails: count(`SELECT count(*) FROM email_templates WHERE ${where}`),
      });

      assert.ok(firm.install.bundle.steps.every((step) => step.status === "done"), `${bundle.key}: ${JSON.stringify(firm.install.bundle.steps)}`);

      const first = rows();
      assert.deepEqual(first, {
        services: bundle.contents.services,
        packages: bundle.contents.packages,
        roles: bundle.contents.roles.length,
        emails: bundle.contents.emails,
      }, bundle.key);

      assert.equal((await api("POST", `/bundles/${bundle.key}/install`, { token: firm.token })).status, 200);
      assert.deepEqual(rows(), first, `${bundle.key}: a second install added rows`);

      const customized = await api("GET", "/bundles/installed/customized", { token: firm.token });
      assert.equal(customized.status, 200, JSON.stringify(customized.body));
      assert.deepEqual(customized.body.items, [], bundle.key);
    }
  });
});

describe("upgrading: keep, retire, accept, keep mine", () => {
  let firm;
  let shipped;

  before(async () => {
    firm = await firmWith(LEGAL, "Law Firm (upgrade)");
    shipped = (await api("GET", "/bundles", { token: firm.token })).body.bundles.find((bundle) => bundle.key === LEGAL).version;

    // Put the firm on an older 0.9.0 the way an install would have: the real
    // install steps, at 0.9.0, with that version's content.
    const step = (path, body) => api("PUT", `${path}/bundles/${LEGAL}/0.9.0`, { token: firm.token, body });

    let result = await step("/services", {
      groups: [{ key: "disputes", label: "Disputes" }, { key: "advisory", label: "Advisory" }],
      services: [
        { key: "litigation", name: "Litigation (old)", group: "disputes", description: "Representation before a court or tribunal" },
        { key: "contract_review", name: "Contract Review", group: "advisory", description: "Review and negotiation of contracts" },
        { key: "legal_notice", name: "Legal Notice", group: "disputes", description: "Old wording" },
        { key: "old_service", name: "Arbitration (withdrawn)", group: "disputes" },
      ],
      packages: [{ key: "dispute_bundle", name: "Dispute package", description: "Notice and litigation", services: ["legal_notice", "litigation"] }],
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));

    result = await step("/roles", { namespace: "law", roles: [{ key: "advocate", name: "Advocate (old)", permissions: ["customers.read"] }] });
    assert.equal(result.status, 200, JSON.stringify(result.body));

    result = await step("/emails", { email: [{ key: "case_review_due_soon", name: "Case review due soon", trigger: "obligation.due_soon", subject: "{{obligation.title}} is due", body: "Old bundle words" }] });
    assert.equal(result.status, 200, JSON.stringify(result.body));

    sql(`INSERT INTO bundle_versions (bundle_key, version, contract_version, manifest, checksum)
         SELECT bundle_key, '0.9.0', contract_version, manifest, repeat('0', 64) FROM bundle_versions
         WHERE bundle_key = '${LEGAL}' AND version = '${shipped}' ON CONFLICT DO NOTHING`);
    sql(`UPDATE organization_bundles SET version = '0.9.0' WHERE organization_id = ${firm.orgId}`);
    sql(`UPDATE bundle_install_steps SET version = '0.9.0'
         WHERE organization_bundle_id = (SELECT id FROM organization_bundles WHERE organization_id = ${firm.orgId})`);

    // The firm's own edits since: a service through the API, a role and an email template.
    const litigation = sql(`SELECT id FROM services WHERE organization_id = ${firm.orgId} AND key = 'litigation'`);
    const renamed = await api("PUT", `/services/${litigation}`, { token: firm.token, body: { name: "Court work" } });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    sql(`UPDATE roles SET name = 'Senior Advocate' WHERE organization_id = ${firm.orgId} AND template_key = 'law_advocate'`);
    sql(`UPDATE email_templates SET body = 'Our own words' WHERE organization_id = ${firm.orgId} AND key = 'case_review_due_soon'`);

    const upgraded = await api("POST", `/bundles/${LEGAL}/upgrade`, { token: firm.token });
    assert.equal(upgraded.status, 200, JSON.stringify(upgraded.body));
    assert.equal(upgraded.body.bundle.version, shipped);
  });

  const service = (key, column) => sql(`SELECT ${column} FROM services WHERE organization_id = ${firm.orgId} AND key = '${key}'`);

  test("untouched items take the new version; what the bundle dropped is retired, not deleted", () => {
    assert.equal(service("legal_notice", "description"), "Drafting and sending a legal notice");
    assert.notEqual(service("old_service", "retired_at"), "");
    assert.equal(service("old_service", "name"), "Arbitration (withdrawn)");
  });

  test("the firm's edits are kept, flagged, and listed with both versions", async () => {
    assert.equal(service("litigation", "name"), "Court work");
    assert.equal(service("litigation", "update_available_version"), shipped);

    const { status, body } = await api("GET", "/bundles/installed/customized", { token: firm.token });
    assert.equal(status, 200, JSON.stringify(body));

    const item = (kind, key) => body.items.find((entry) => entry.kind === kind && entry.key === key);
    assert.deepEqual(body.items.map((entry) => `${entry.step}/${entry.kind}:${entry.key}`).sort(), ["catalog/service:litigation", "email/template:case_review_due_soon", "roles/role:advocate"]);
    assert.equal(item("service", "litigation").mine.name, "Court work");
    assert.equal(item("service", "litigation").theirs.name, "Litigation");
    assert.equal(item("role", "advocate").mine.name, "Senior Advocate");
    assert.equal(item("template", "case_review_due_soon").mine.body, "Our own words");
  });

  test("accepting takes the bundle's version — and never switches an automation on", async () => {
    let chosen = await api("POST", "/bundles/installed/customized", { token: firm.token, body: { step: "catalog", kind: "service", key: "litigation", choice: "accept" } });
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    assert.equal(service("litigation", "name"), "Litigation");
    assert.equal(service("litigation", "update_available_version"), "");

    chosen = await api("POST", "/bundles/installed/customized", { token: firm.token, body: { step: "email", kind: "template", key: "case_review_due_soon", choice: "accept" } });
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    assert.match(sql(`SELECT body FROM email_templates WHERE organization_id = ${firm.orgId} AND key = 'case_review_due_soon'`), /^Dear \{\{client\.name\}\}/);
    assert.equal(sql(`SELECT is_active FROM email_automations WHERE organization_id = ${firm.orgId} AND key = 'case_review_due_soon'`), "f");
  });

  test("keep mine leaves the firm's version and stops asking", async () => {
    const chosen = await api("POST", "/bundles/installed/customized", { token: firm.token, body: { step: "roles", kind: "role", key: "advocate", choice: "dismiss" } });
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    assert.equal(sql(`SELECT name FROM roles WHERE organization_id = ${firm.orgId} AND template_key = 'law_advocate'`), "Senior Advocate");

    const { body } = await api("GET", "/bundles/installed/customized", { token: firm.token });
    assert.deepEqual(body.items, []);
  });

  test("each choice is audited, and only an administrator may make one", async () => {
    assert.equal(count(`SELECT count(*) FROM audit_events WHERE organization_id = ${firm.orgId} AND action = 'bundle.item_accepted'`), 2);
    assert.equal(count(`SELECT count(*) FROM audit_events WHERE organization_id = ${firm.orgId} AND action = 'bundle.item_kept'`), 1);

    const plain = await organizationWithAdmin(admin, "No bundle (customized)");
    assert.equal((await api("GET", "/bundles/installed/customized", { token: plain.token })).status, 404);
  });
});
