const { describe, test, before } = require("node:test");
const assert = require("node:assert/strict");

const { api, adminToken, caFirm, organizationWithAdmin, sql, unique, uuid, waitFor } = require("./lib");

/*
 * Milestone M7: the assistant with the bundle's tools and help, the bundle's
 * dashboard cards (DASH-01) and clients as CSV (DATA-03–05, FIX-13), in a CA
 * firm of its own. The shared test organization has no bundle and must see
 * none of it.
 */

const API = process.env.API_BASE || "http://localhost:18080/api";

let admin;
let firm;
let plain;
let services;
let years;

let sequence = 0;
const letters = (n) => Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
const pan = () => `${letters(5)}${String((sequence += 1) % 10000).padStart(4, "0")}${letters(1)}`;

const send = (token, content) =>
  api("POST", `/assistant/conversations/${uuid()}/messages`, { token, body: { clientMessageId: uuid(), content } });
const lastText = (result) => result.body.messages.at(-1)?.content;

async function raw(method, path, token, body, type = "text/csv") {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": type } : {}) },
    body,
  });
  return { status: response.status, type: response.headers.get("content-type"), disposition: response.headers.get("content-disposition"), text: await response.text() };
}

async function client(name, extra = {}) {
  const { status, body } = await api("POST", "/customers", {
    token: firm.token,
    body: { name, profile: { attributes: { constitution: "proprietorship", client_type: "regular" } }, ...extra },
  });
  assert.equal(status, 201, JSON.stringify(body));
  return body.id;
}

before(async () => {
  admin = await adminToken();
  firm = await caFirm(admin, "CA Firm (M7)");
  plain = await organizationWithAdmin(admin, "No bundle (M7)");

  const list = (await api("GET", "/services", { token: firm.token })).body;
  services = Object.fromEntries(list.filter((service) => service.key).map((service) => [service.key, service.id]));
  years = (await api("GET", "/engagements/periods?type=annual", { token: firm.token })).body;
});

describe("the assistant", () => {
  let overdueClient;

  before(async () => {
    // Engaged for GST this year: the monthly returns already past are overdue.
    overdueClient = unique("Overdue Traders");
    const id = await client(overdueClient);
    const engaged = await api("POST", "/engagements", {
      token: firm.token,
      body: { customerId: id, typeKey: "annual", period: years.current, lines: [{ serviceId: services.gst_returns }] },
    });
    assert.equal(engaged.status, 201, JSON.stringify(engaged.body));
  });

  test("answers what is overdue by calling list_obligations", async () => {
    const result = await send(firm.token, 'TOOL list_obligations {"state": "overdue"}');

    assert.equal(result.status, 200, JSON.stringify(result.body));
    const text = lastText(result);
    assert.match(text, /^Tool said:/);
    assert.ok(text.includes(overdueClient), text);
    assert.match(text, /GSTR-1/);
    assert.match(text, /"state":"overdue"/);
  });

  test("offers the bundle's tools only to an organization with a bundle", async () => {
    const withBundle = (await api("GET", "/assistant/capabilities", { token: firm.token })).body;
    const without = (await api("GET", "/assistant/capabilities", { token: plain.token })).body;
    const names = (body) => (body.tools || []).map((tool) => tool.name ?? tool);

    for (const tool of ["list_obligations", "get_client_profile", "get_engagement", "update_obligation_status", "record_payment", "generate_document"]) {
      assert.ok(names(withBundle).includes(tool), `CA firm lacks ${tool}`);
      assert.ok(!names(without).includes(tool), `organization without a bundle has ${tool}`);
    }

    const refused = await send(plain.token, 'TOOL list_obligations {"state": "overdue"}');
    assert.match(lastText(refused), /not available/);
  });

  test("never has a tool that reaches the vault", async () => {
    const { body } = await api("GET", "/assistant/capabilities", { token: firm.token });
    const names = (body.tools || []).map((tool) => tool.name ?? tool);

    // Whole words of a tool name: "profile" is not a file.
    const words = names.flatMap((name) => name.split("_"));
    assert.equal(words.some((word) => /^(vault|credentials?|reveal|password|portals?|files?)$/.test(word)), false, names.join(", "));
  });

  test("the bundle's help is searchable in its firm only", async () => {
    const ask = 'TOOL search_help {"question": "How do I save a client\'s GST portal password?"}';

    const asFirm = await waitFor(
      async () => {
        const text = lastText(await send(firm.token, ask));
        return /signed consent/i.test(text) ? text : null;
      },
      { what: "bundle help in search results" },
    );
    assert.match(asFirm, /Portal credentials and client files/);

    assert.doesNotMatch(lastText(await send(plain.token, ask)), /Portal credentials and client files/);
  });

  test("a mutating bundle tool is proposed, not run", async () => {
    const id = sql(`SELECT id FROM obligations WHERE organization_id = ${firm.orgId} ORDER BY due_on LIMIT 1`);
    const result = await send(firm.token, `TOOL update_obligation_status {"id": ${id}, "status": "filed"}`);

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(result.body.pendingAction, JSON.stringify(result.body));
    assert.equal(sql(`SELECT status FROM obligations WHERE id = ${id}`), "pending");
  });
});

describe("the dashboard (DASH-01)", () => {
  test("a CA firm sees the bundle's four cards, counted from its own clients and deadlines", async () => {
    const { status, body } = await api("GET", "/dashboard", { token: firm.token });
    assert.equal(status, 200, JSON.stringify(body));

    const card = (key) => body.bundleCards.find((entry) => entry.key === key);
    assert.deepEqual(body.bundleCards.map((entry) => entry.key), ["clients", "prospects", "overdue", "in_progress"]);

    const clients = Number(sql(`SELECT count(*) FROM customers WHERE organization_id = ${firm.orgId} AND archived_at IS NULL`));
    assert.equal(card("clients").value, clients);
    assert.match(card("clients").hint, /regular · \d+ one-time/);

    const leads = (await api("GET", "/leads", { token: firm.token })).body;
    const open = (Array.isArray(leads) ? leads : leads.leads).filter((lead) => !["Converted", "Lost"].includes(lead.status));
    assert.equal(card("prospects").value, open.length);
    assert.match(card("prospects").hint, /^\d+ with a quote$/);

    const deadlines = (await api("GET", "/obligations", { token: firm.token })).body.counts;
    assert.ok(card("overdue").value > 0, "the GST client's past returns are overdue");
    assert.equal(card("overdue").value, deadlines.overdue);
    assert.equal(card("in_progress").value, deadlines.in_progress);
  });

  test("an organization without a bundle gets none", async () => {
    const { status, body } = await api("GET", "/dashboard", { token: plain.token });

    assert.equal(status, 200);
    assert.equal(body.bundleCards, null);
  });
});

describe("clients as CSV (DATA-03–05)", () => {
  test("the template carries the bundle's columns behind // instructions", async () => {
    const result = await raw("GET", "/customers/import-template.csv", firm.token);

    assert.equal(result.status, 200);
    assert.match(result.type, /text\/csv/);
    assert.match(result.disposition, /attachment/);

    const lines = result.text.trim().split("\r\n");
    assert.ok(lines.slice(0, -1).every((line) => line.startsWith("//")));
    const header = lines.at(-1).split(",");
    for (const column of ["name", "constitution", "pan", "cin", "services", "person1_name", "bank_account_number"]) {
      assert.ok(header.includes(column), `missing ${column}`);
    }
  });

  test("export masks bank numbers and neutralises formulas", async () => {
    const name = `=HYPERLINK("http://evil.example") ${unique("Export")}`;
    await client(name, {
      profile: {
        attributes: { constitution: "proprietorship", client_type: "regular" },
        identifiers: { pan: pan() },
        bankAccounts: [{ bankName: "State Bank of India", accountNumber: "998877665544", routingCode: "SBIN0000123" }],
      },
    });

    const result = await raw("GET", "/customers/export.csv", firm.token);
    assert.equal(result.status, 200);
    assert.ok(!result.text.includes("998877665544"), "account number left the system");
    assert.ok(result.text.includes("•••• 5544"));
    assert.ok(result.text.includes(`"'=HYPERLINK(""http://evil.example"")`), "formula not neutralised");
  });

  test("import adds valid rows, skips a duplicate PAN and reports errors by line", async () => {
    const taken = pan();
    await client(unique("Holds PAN"), { profile: { attributes: { constitution: "proprietorship", client_type: "regular" }, identifiers: { pan: taken } } });

    const fresh = pan();
    const multiline = unique("Multiline Co");
    const csv = [
      "// exported by hand",
      "name,email,address,constitution,client_type,pan,services,person1_name,person1_role",
      `${unique("Imported One")},one@test.example,"12 MG Road\nPune, 411001",proprietorship,regular,${fresh},gst_returns;itr,R. Kumar,director`,
      `${multiline},,"line one\nline two",proprietorship,One-Time,,,,`,
      `${unique("Duplicate")},,,proprietorship,regular,${taken},,,`,
      `${unique("Bad Service")},,,proprietorship,regular,,no_such_service,,`,
      `,,,proprietorship,regular,,,,`,
      `${unique("Bad PAN")},,,proprietorship,regular,NOTAPAN,,,`,
    ].join("\r\n");

    const result = await raw("POST", "/customers/import", firm.token, csv);
    assert.equal(result.status, 200, result.text);
    const report = JSON.parse(result.text);

    assert.equal(report.added, 2, result.text);
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /already belongs/);
    assert.deepEqual(report.errors.map((error) => error.line).sort((a, b) => a - b), [8, 9, 10]);
    assert.equal(report.skipped[0].line, 7);

    const imported = (await api("GET", `/customers?q=${fresh}`, { token: firm.token })).body;
    const found = (Array.isArray(imported) ? imported : imported.customers || imported.items || [])[0];
    assert.ok(found, "imported client not found by PAN");
    const detail = (await api("GET", `/customers/${found.id}`, { token: firm.token })).body;
    assert.equal(detail.address, "12 MG Road\nPune, 411001");
    assert.equal(detail.people[0].name, "R. Kumar");
    assert.deepEqual(detail.services.map((service) => service.key).sort(), ["gst_returns", "itr"]);

    assert.equal(sql(`SELECT attributes->>'client_type' FROM customers WHERE organization_id = ${firm.orgId} AND name = '${multiline}'`), "one_time");
    assert.equal(sql(`SELECT count(*) FROM audit_events WHERE organization_id = ${firm.orgId} AND action = 'customers.imported'`), "1");
  });

  test("an organization without a bundle has no CSV routes", async () => {
    assert.equal((await raw("GET", "/customers/export.csv", plain.token)).status, 404);
    assert.equal((await raw("POST", "/customers/import", plain.token, "name\r\nX")).status, 404);
  });
});
