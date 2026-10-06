const { test, expect } = require("@playwright/test");

/*
 * The UI in a real browser, against the throwaway test stack. Besides the
 * assertions, every test saves a screenshot to tests/e2e/screenshots — the
 * first time anyone sees the assistant's glass, orb and history rail
 * actually rendered, in all four themes.
 */

const API = process.env.API_BASE || "http://localhost:18080/api";
const ADMIN = { email: "admin@test.example", password: "Test-Admin-123!", name: "Test Admin" };
const THEMES = ["lemon", "cobalt", "mint", "coral"];

const shot = (page, name) => page.screenshot({ path: `screenshots/${name}.png`, fullPage: false });

async function prepare(page, theme = "lemon") {
  // Skip the one-time onboarding; pin the theme under test.
  await page.addInitScript((value) => {
    localStorage.setItem("omnicore-onboarding-completed", "true");
    localStorage.setItem("omnicore-theme", value);
  }, theme);
}

async function signIn(page, { email, password } = ADMIN) {
  await page.goto("/login");
  await page.getByPlaceholder("you@company.com").fill(email);
  await page.getByPlaceholder("Enter your password").fill(password);
  await page.locator("button.login-submit").click();
  await expect(page).not.toHaveURL(/\/login/);
}

test("signing in lands on the dashboard", async ({ page }) => {
  await prepare(page);
  await signIn(page);

  await expect(page.getByRole("button", { name: new RegExp(ADMIN.name) })).toBeVisible();
  await shot(page, "dashboard");
});

test("the docked assistant panel opens in the bottom-right corner", async ({ page }) => {
  await prepare(page);
  await signIn(page);

  await page.locator("button.assistant-button").click();

  const panel = page.locator(".assistant-panel");
  await expect(panel).toBeVisible();

  // The glass rule once unpinned the panel; it must hug the corner.
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  expect(viewport.width - (box.x + box.width)).toBeLessThan(40);
  expect(viewport.height - (box.y + box.height)).toBeLessThan(40);

  await shot(page, "assistant-panel");
});

for (const theme of THEMES) {
  test(`the assistant page renders in the ${theme} theme`, async ({ page }) => {
    await prepare(page, theme);
    await signIn(page);
    await page.goto("/assistant");

    await expect(page.locator(".assistant-page-card")).toBeVisible();
    await expect(page.locator(".ai-orb-canvas").first()).toBeVisible();

    // Let the orb animate and the glass settle before capturing.
    await page.waitForTimeout(800);
    await shot(page, `assistant-${theme}`);
  });
}

test("a message sent from the UI is answered, listed and survives a reload", async ({ page }) => {
  await prepare(page, "mint");
  await signIn(page);
  await page.goto("/assistant");

  // The page reopens the most recent conversation; start a fresh one so this
  // message becomes its title in the history rail.
  await page.getByRole("button", { name: "New chat" }).first().click();

  const text = `hello from playwright ${Date.now()}`;

  await page.locator(".assistant-composer input").fill(text);
  await page.locator(".assistant-composer input").press("Enter");

  await expect(page.getByText(`Echo: ${text}`)).toBeVisible();
  await expect(page.locator(".assistant-history").getByText(text)).toBeVisible();

  // Rows stay one line tall: the hidden actions once wrapped under the title.
  const heights = await page
    .locator(".assistant-history-item")
    .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
  expect(Math.max(...heights)).toBeLessThan(64);

  await shot(page, "assistant-conversation");

  await page.reload();
  await expect(page.getByText(`Echo: ${text}`)).toBeVisible();
});

test("the account menu leads to My Profile", async ({ page }) => {
  await prepare(page);
  await signIn(page);

  await page.getByRole("button", { name: new RegExp(ADMIN.name) }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await shot(page, "account-menu");

  await page.getByRole("menuitem", { name: /my profile/i }).click();
  await expect(page.getByRole("heading", { name: "My Profile" })).toBeVisible();
  await shot(page, "profile");
});

test("a screen without permission says so", async ({ page, request }) => {
  const login = await request.post(`${API}/auth/login`, { data: ADMIN });
  const { token } = await login.json();

  const email = `e2e-support-${Date.now()}@test.example`;
  const created = await request.post(`${API}/users`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: "Support Agent", email, password: "Support-Pass-123!", roleCode: "CUSTOMER_SUPPORT_AGENT" },
  });
  expect(created.status()).toBe(201);

  await prepare(page);
  await signIn(page, { email, password: "Support-Pass-123!" });
  await page.goto("/leads");

  await expect(page.getByRole("heading", { name: /no access to this screen/i })).toBeVisible();
  await shot(page, "access-denied");
});

test("a change proposed by the assistant is confirmed from its card", async ({ page, request }) => {
  await prepare(page);
  await signIn(page);
  await page.goto("/assistant");
  await page.getByRole("button", { name: "New chat" }).first().click();

  const name = `E2E Confirmed ${Date.now()}`;
  const input = page.locator(".assistant-composer input");

  await input.fill(`TOOL create_lead {"name": "${name}", "email": "e2e-${Date.now()}@test.example"}`);
  await input.press("Enter");

  const card = page.locator(".assistant-confirm");
  await expect(card).toBeVisible();
  await expect(card).toContainText(name);
  // While a change waits for a decision, nothing else can be sent.
  await expect(input).toBeDisabled();
  await shot(page, "assistant-confirm-card");

  await card.getByRole("button", { name: "Confirm" }).click();
  await expect(card).toBeHidden();
  await expect(page.getByText(/Tool said:/)).toBeVisible();

  const login = await request.post(`${API}/auth/login`, { data: ADMIN });
  const { token } = await login.json();
  const leads = await (
    await request.get(`${API}/leads?q=${encodeURIComponent(name)}`, { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  const list = Array.isArray(leads) ? leads : leads.leads || [];

  expect(list.filter((lead) => lead.name === name)).toHaveLength(1);
});

test.describe("on a phone-sized screen", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the page fits, and history opens as a drawer", async ({ page }) => {
    await prepare(page, "coral");
    await signIn(page);
    await page.goto("/assistant");

    // No sideways scrolling at phone width.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    const drawer = page.locator(".assistant-history");
    const toggle = page.getByRole("button", { name: "History" });

    await expect(toggle).toBeVisible();
    expect((await drawer.boundingBox()).x).toBeLessThan(0);
    await shot(page, "mobile-assistant");

    await toggle.click();
    await expect(drawer).toHaveClass(/is-open/);
    await page.waitForTimeout(400);
    expect((await drawer.boundingBox()).x).toBeGreaterThanOrEqual(0);
    await shot(page, "mobile-history-drawer");
  });

  test("the docked panel fits the screen", async ({ page }) => {
    await prepare(page);
    await signIn(page);

    await page.locator("button.assistant-button").click();

    const box = await page.locator(".assistant-panel").boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await shot(page, "mobile-panel");
  });
});

test("an automation's sending account is chosen on its form", async ({ page, request }) => {
  const login = await request.post(`${API}/auth/login`, { data: ADMIN });
  const { token } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };

  // A fresh stack has no email accounts. Connect the same test mailbox the
  // integration suite uses, unless an earlier run on this stack already did —
  // a second active account would leave the organization with no default.
  const existing = await (await request.get(`${API}/emails/accounts`, { headers })).json();
  if (!(existing.accounts || []).some((account) => account.email_address === "sender@test.example")) {
    const created = await request.post(`${API}/emails/accounts`, {
      headers,
      data: {
        name: "Test mailbox",
        email_address: "sender@test.example",
        provider: "smtp",
        smtp_host: "mailpit",
        smtp_port: 1025,
        smtp_secure: false,
        smtp_username: "sender@test.example",
        smtp_password: "any",
        imap_host: "greenmail",
        imap_port: 3143,
        imap_secure: false,
        imap_username: "sender@test.example",
        imap_password: "any",
        imap_mailbox: "INBOX",
      },
    });
    expect([200, 201]).toContain(created.status());
  }

  await prepare(page);
  await signIn(page);
  await page.goto("/settings/email-automations/new");

  const picker = page.getByLabel("Send from");
  await expect(picker).toBeVisible();

  // The connected account is offered by name and address.
  await expect(picker.locator("option", { hasText: "sender@test.example" })).toHaveCount(1);
  await shot(page, "automation-send-from");
});

// Last on purpose: it installs the CA bundle into the test organization.
test("a profession bundle is installed from Settings", async ({ page }) => {
  await prepare(page);
  await signIn(page);
  await page.goto("/settings");

  await page.getByRole("button", { name: /Profession Bundle/ }).click();
  await expect(page.getByRole("heading", { name: /CA Practice/ })).toBeVisible();
  await expect(page.getByText("12 services and 2 packages")).toBeVisible();
  await shot(page, "bundle-offer");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Install CA Practice" }).click();

  const installed = page.getByRole("region", { name: "Installed bundle" });

  await expect(installed.getByText("Installed", { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(installed.getByText("Services and packages")).toBeVisible();
  await expect(page.getByText(/reminder emails are switched off/)).toBeVisible();
  await shot(page, "bundle-installed");
});

// ---------------------------------------------------------------------------
// Milestone M2 — run after the install above, in the same organization.
// ---------------------------------------------------------------------------

const unique = (label) => `${label} ${Date.now().toString(36)}`;
// A wizard's Continue, one step at a time: a click while a step is still
// changing can be lost.
const continueTo = async (page, step) => {
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.getByText(`STEP 0${step}`)).toBeVisible();
};

const pickOption = async (page, label, optionText) => {
  const select = page.getByLabel(label);
  const value = await select.locator("option", { hasText: optionText }).first().getAttribute("value");
  await select.selectOption(value);
};

test("with a bundle, the navigation says Clients and offers the prospect board", async ({ page }) => {
  await prepare(page);
  await signIn(page);

  await expect(page.getByRole("link", { name: "Clients" })).toHaveAttribute("href", "/clients");
  await expect(page.getByRole("link", { name: "Prospects" })).toBeVisible();
});

test("the client wizard adds a company with its CIN, director and bank account", async ({ page }) => {
  await prepare(page);
  await signIn(page);
  await page.goto("/clients/new");

  const name = unique("Acme Pvt Ltd");

  await page.getByLabel("Entity name").fill(name);
  await page.getByLabel("Email").first().fill("accounts@acme.example");
  await pickOption(page, /Constitution/, "Private Limited");

  // CIN appears for a company and is required (WIZ-02/03).
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.getByText("CIN is required")).toBeVisible();

  await page.getByLabel("PAN").fill(`AAACA${String(Date.now()).slice(-4)}A`);
  await page.getByLabel(/CIN/).fill(`U72200MH2015PTC${String(Date.now()).slice(-6)}`);
  await shot(page, "client-wizard-entity");
  await page.getByRole("button", { name: /Continue/ }).click();

  await page.getByRole("button", { name: "+ Add person" }).click();
  await page.getByLabel("Name", { exact: true }).fill("A. Rao");
  await page.getByLabel("Designation").fill("Managing Director");
  await page.getByLabel(/DIN/).fill("01234567");
  await page.getByRole("button", { name: /Continue/ }).click();

  await page.getByRole("button", { name: /Statutory Audit/ }).click();
  await shot(page, "client-wizard-services");
  await page.getByRole("button", { name: /Continue/ }).click();

  await page.getByRole("button", { name: "+ Add bank account" }).click();
  await page.getByLabel("Bank").fill("State Bank of India");
  await page.getByLabel("Account number").fill("123456789012");
  await page.getByRole("button", { name: /Continue/ }).click();

  await expect(page.getByText(name)).toBeVisible();
  await page.getByRole("button", { name: "Save Client" }).click();

  await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
  await expect(page.getByText("Private Limited").first()).toBeVisible();
  await shot(page, "client-detail");

  await page.getByRole("tab", { name: "Bank accounts" }).click();
  await expect(page.getByText("•••• 9012")).toBeVisible();
  await expect(page.getByText("Primary")).toBeVisible();
  await shot(page, "client-bank-accounts");

  await page.getByRole("tab", { name: "People" }).click();
  await expect(page.getByRole("cell", { name: "A. Rao" })).toBeVisible();

  await page.goto("/clients");
  await expect(page.getByRole("button", { name })).toBeVisible();
  await expect(page.getByText("Private Limited").first()).toBeVisible();
  await shot(page, "clients-list");
});

test("a prospect moves along the board and converts into a client", async ({ page }) => {
  await prepare(page);
  await signIn(page);
  await page.goto("/prospects");

  const name = unique("Iyer & Sons");

  await page.getByRole("button", { name: "+ Add prospect" }).click();
  await page.getByLabel("Name").fill(name);
  await continueTo(page, 2);
  await continueTo(page, 3);
  await page.getByLabel("Quoted fee").fill("45000");
  await page.getByLabel("Next meeting").fill("2026-10-20");
  await continueTo(page, 4);
  await page.getByRole("button", { name: "Add prospect", exact: true }).click();

  const leads = page.getByRole("region", { name: "Leads" });
  await expect(leads.getByText(name)).toBeVisible();

  await page.getByRole("button", { name: `Move ${name} on` }).click();
  await expect(page.getByRole("region", { name: "In Discussion" }).getByText(name)).toBeVisible();
  await shot(page, "prospect-board");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("region", { name: "In Discussion" }).locator("article", { hasText: name }).getByRole("button", { name: "Convert" }).click();

  await expect(page.getByText("Converted from a prospect")).toBeVisible();
  await expect(page.getByLabel("Entity name")).toHaveValue(name);
  await shot(page, "prospect-converted-wizard");
});

test("the firm's FRN and signing partner are set in Settings", async ({ page }) => {
  await prepare(page);
  await signIn(page);
  await page.goto("/settings");

  await page.getByRole("button", { name: /^⌂?\s*Firm/ }).click();
  await page.getByLabel("Legal name").fill("Rao & Co LLP");
  await page.getByLabel(/Firm registration number/).fill("123456W");
  await page.getByRole("button", { name: "Save firm" }).click();
  await expect(page.getByText("Firm saved.")).toBeVisible();

  await page.getByRole("button", { name: "+ Add partner" }).click();
  await page.getByRole("form", { name: "Signing partner" }).getByLabel("Name").fill("CA A. Rao");
  await page.getByLabel(/ICAI membership number/).fill("123456");
  await page.getByLabel("Default signatory").check();
  await page.getByRole("button", { name: "Save partner" }).click();

  await expect(page.getByText("Default signatory", { exact: true }).first()).toBeVisible();
  await shot(page, "firm-settings");
});

// Milestone M3 — engagements and fees, after the CA install.
test("a client's first engagement carries its fees, and a payment settles them", async ({ page }) => {
  await prepare(page);
  await signIn(page);
  await page.goto("/clients/new");

  const name = unique("Sharma Traders");

  await page.getByLabel("Entity name").fill(name);
  await pickOption(page, /Constitution/, "Proprietorship");
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("button", { name: /Continue/ }).click();

  // Step 3: services, and the first financial year's fees (WIZ-08).
  await page.getByRole("button", { name: /Income Tax Return/ }).click();
  await expect(page.getByLabel("Financial year")).toBeVisible();
  await page.getByLabel("Fee for Income Tax Return").fill("15000");
  await page.getByLabel("Expenses for Income Tax Return").fill("500");
  await expect(page.getByText("fees and expenses for the period")).toBeVisible();
  await shot(page, "wizard-engagement");

  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("button", { name: "Save Client" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();

  await page.getByRole("tab", { name: "Engagement" }).click();
  await expect(page.getByRole("article", { name: /Annual engagement/ })).toBeVisible();
  await shot(page, "client-engagement");

  await page.getByRole("tab", { name: "Fees" }).click();
  await expect(page.getByText("Balance ₹15,500")).toBeVisible();

  await page.getByRole("button", { name: "Update payment" }).click();
  await expect(page.getByLabel("Amount")).toHaveValue("15500");
  await page.getByLabel("Reference").fill("UTR-0042");
  await page.getByRole("button", { name: "Record payment" }).click();

  await expect(page.getByText("Fully paid")).toBeVisible();
  await expect(page.getByText(/UTR-0042/)).toBeVisible();
  await shot(page, "client-fees");
});

// Milestone M4 — deadlines, after the CA install.
test("a client's deadlines show on its Compliance tab and in the firm-wide feed", async ({ page, request }) => {
  const login = await request.post(`${API}/auth/login`, { data: ADMIN });
  const headers = { Authorization: `Bearer ${(await login.json()).token}` };

  // A client engaged for GST returns and ITR in the current year.
  const name = unique("Mehta Exports");
  const services = await (await request.get(`${API}/services`, { headers })).json();
  const serviceId = (key) => services.find((service) => service.key === key).id;
  const { current } = await (await request.get(`${API}/engagements/periods?type=annual`, { headers })).json();

  const created = await request.post(`${API}/customers`, { headers, data: { name, profile: { attributes: { constitution: "proprietorship" } } } });
  expect(created.status()).toBe(201);
  const customerId = (await created.json()).id;

  const engaged = await request.post(`${API}/engagements`, {
    headers,
    data: { customerId, typeKey: "annual", period: current, lines: [{ serviceId: serviceId("gst_returns") }, { serviceId: serviceId("itr") }] },
  });
  expect(engaged.status()).toBe(201);

  await prepare(page);
  await signIn(page);
  await page.goto(`/clients/${customerId}`);

  await page.getByRole("tab", { name: "Compliance" }).click();
  const compliance = page.getByRole("tabpanel", { name: "Compliance" });
  await expect(compliance.getByText("0/24 done")).toBeVisible();
  await expect(compliance.getByText("0/1 done")).toBeVisible();

  const itr = compliance.getByLabel(/Status of Income tax return/i);
  await itr.selectOption("filed");
  await expect(compliance.getByText("1/1 done")).toBeVisible();
  await shot(page, "client-compliance");

  await page.getByRole("link", { name: "Deadlines" }).click();
  await expect(page.getByRole("heading", { name: "Deadlines" })).toBeVisible();
  await page.getByRole("group", { name: "Deadlines by state" }).getByRole("button", { name: /Completed/ }).click();
  const feed = page.getByRole("region", { name: "Deadlines" });
  await expect(feed.getByRole("button", { name: new RegExp(name) }).first()).toBeVisible();
  await shot(page, "deadlines-feed");

  // A deadline in the feed opens its client on the Compliance tab.
  await feed.getByRole("button", { name: new RegExp(name) }).first().click();
  await expect(page.getByRole("tabpanel", { name: "Compliance" })).toBeVisible();

  await page.goto("/settings/deadlines");
  await expect(page.getByRole("heading", { name: "Deadline rules" })).toBeVisible();
  await expect(page.getByLabel("GSTR-1 active")).toBeChecked();
  await shot(page, "deadline-rules");
});

// Before M5 — one screen for leads, and a prospect and its client as one.
test("with a bundle, Prospects and Clients replace Leads and Customers, and a converted prospect follows its client", async ({ page }) => {
  await prepare(page);
  await signIn(page);

  // The Leads list is gone from the navigation, and its URL lands on the board.
  await expect(page.getByRole("link", { name: "Leads", exact: true })).toHaveCount(0);
  await page.goto("/leads");
  await expect(page).toHaveURL(/\/prospects$/);

  // Likewise the Customers screens: each lands on its Clients twin.
  await page.goto("/customers/new");
  await expect(page).toHaveURL(/\/clients\/new$/);
  await page.goto("/prospects");

  const name = unique("Desai Holdings");

  // Adding a prospect is a wizard of its own, like adding a client.
  await page.getByRole("button", { name: "+ Add prospect" }).click();
  await expect(page).toHaveURL(/\/prospects\/new$/);
  const form = page.getByRole("form", { name: "Prospect" });
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Constitution").selectOption({ label: "Proprietorship" });
  await continueTo(page, 2);
  await page.getByRole("button", { name: /Income Tax Return/ }).click();
  await shot(page, "prospect-wizard-services");
  await continueTo(page, 3);
  await form.getByLabel("Quoted fee").fill("38000");
  await form.getByLabel("Notes").fill("Referred by Mehta Exports");
  await continueTo(page, 4);
  await expect(form.getByText("Income Tax Return")).toBeVisible();
  await shot(page, "prospect-form");
  await page.getByRole("button", { name: "Add prospect", exact: true }).click();

  // The same prospects as a list.
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "List" }).click();
  const list = page.getByRole("region", { name: "Prospect list" });
  await page.getByLabel("Search prospects").fill(name);
  await expect(list.getByText(name)).toBeVisible();
  await shot(page, "prospects-list");

  // Convert: the wizard starts from what the prospect stage learned.
  page.once("dialog", (dialog) => dialog.accept());
  await list.locator("tr", { hasText: name }).getByRole("button", { name: "Convert" }).click();
  await expect(page.getByText("Converted from a prospect")).toBeVisible();
  await expect(page.getByLabel(/Constitution/).locator("option:checked")).toHaveText("Proprietorship");
  await shot(page, "prospect-onboarding-prefilled");

  for (let step = 2; step <= 5; step += 1) {
    await continueTo(page, step);
  }
  await page.getByRole("button", { name: /^Update / }).click();

  // The client shows the prospect it was won from.
  const origin = page.getByRole("region", { name: "Won from prospect" });
  await expect(origin.getByText("₹38,000")).toBeVisible();
  await expect(origin.getByText("Referred by Mehta Exports")).toBeVisible();
  await shot(page, "client-won-from-prospect");

  // And the prospect, listed as converted, leads back to it.
  await page.goto("/prospects");
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "List" }).click();
  await page.getByLabel("Show converted").check();
  await page.getByLabel("Search prospects").fill(name);
  await page.getByRole("region", { name: "Prospect list" }).getByRole("link", { name: "Open client" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
});
