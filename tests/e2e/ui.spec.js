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
