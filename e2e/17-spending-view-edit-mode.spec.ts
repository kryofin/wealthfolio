import { expect, Page, test } from "@playwright/test";
import { BASE_URL, gotoAppPath, loginIfNeeded } from "./helpers";

test.describe.configure({ mode: "serial" });

const SPENDING_ACCOUNT = "E2E Spending Grid";
const API = `${BASE_URL}/api/v1`;

/**
 * The spending tab only appears once the module is enabled for at least one
 * account, so this spec seeds its own cash account and activities over the API
 * (same approach as spec 16) instead of driving the forms. That keeps it
 * runnable against a fresh `prep-e2e.mjs` database with no manual setup.
 */
test.describe("Spending View/Edit Mode", () => {
  let page: Page;
  let accountId: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  async function openSpendingTab() {
    await gotoAppPath(page, "/activities?tab=spending");
    // The dev server can take several seconds to mount the route; wait for the
    // tab's own chrome rather than a fixed guess.
    await expect(page.getByTestId("add-activities-button")).toBeVisible({ timeout: 45000 });
    await page.waitForTimeout(1500);
  }

  /**
   * The grid row for a given note. Tests must not use `.first()` for category
   * work: the category popover scopes to the row's cash-flow bucket, so an
   * income row offers income sources rather than spending categories.
   */
  function gridRow(note: string) {
    return page.locator('[data-slot="grid-row"]').filter({ hasText: note });
  }

  /**
   * Switches modes through the real toggle rather than poking localStorage.
   * The group marks the active item with `aria-pressed`, and turning edit mode
   * *off* means selecting the sibling "View mode" item — clicking the pressed
   * item again is a no-op.
   */
  async function setEditMode(on: boolean) {
    const editToggle = page.getByTestId("edit-mode-toggle");
    await expect(editToggle).toBeVisible({ timeout: 45000 });
    if (((await editToggle.getAttribute("aria-pressed")) === "true") === on) return;

    await (on ? editToggle : page.locator('[title="View mode"]').first()).click();
    await page.waitForTimeout(1500);
  }

  test("1. Setup: seed a cash account and enable spending", async () => {
    test.setTimeout(180000);
    await loginIfNeeded(page);

    const accountResponse = await page.request.post(`${API}/accounts`, {
      data: {
        name: SPENDING_ACCOUNT,
        accountType: "CASH",
        currency: "USD",
        isDefault: false,
        isActive: true,
        group: null,
        platformId: null,
        accountNumber: null,
        meta: null,
        provider: null,
        providerAccountId: null,
      },
    });
    expect(accountResponse.ok()).toBeTruthy();
    accountId = ((await accountResponse.json()) as { id: string }).id;

    const settingsResponse = await page.request.put(`${API}/spending/settings`, {
      data: { enabled: true, accountIds: [accountId] },
    });
    expect(settingsResponse.ok()).toBeTruthy();
  });

  test("2. With no transactions, edit mode still reaches the grid", async () => {
    test.setTimeout(120000);
    await openSpendingTab();

    // Runs before any activity exists, so it is also the only chance to observe
    // the untouched default.
    await expect(page.getByTestId("edit-mode-toggle")).toHaveAttribute("aria-pressed", "false", {
      timeout: 45000,
    });
    await expect(page.getByText("No transactions")).toBeVisible({ timeout: 15000 });

    await setEditMode(true);

    // Regression guard: the render chain used to test the view-mode row count
    // before the mode, so an empty account fell through to the placeholder and
    // the grid — with its Add button and column toggle — was unreachable.
    await expect(page.locator('[data-slot="grid"]')).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole("button", { name: "Add transaction" })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText("No transactions")).not.toBeVisible();

    await setEditMode(false);
  });

  test("3. Setup: seed transactions", async () => {
    test.setTimeout(120000);

    // Distinct dates so the grid's date-desc order is deterministic and the
    // tests below can rely on which row is which.
    const activities = [
      { activityType: "DEPOSIT", amount: "4200.00", comment: "Payroll", date: "2026-08-26" },
      { activityType: "WITHDRAWAL", amount: "89.40", comment: "Supermarket", date: "2026-08-27" },
      { activityType: "WITHDRAWAL", amount: "35.75", comment: "Gas station", date: "2026-08-28" },
    ];
    for (const activity of activities) {
      const response = await page.request.post(`${API}/activities`, {
        data: {
          accountId,
          activityType: activity.activityType,
          activityDate: `${activity.date}T07:12:50Z`,
          amount: activity.amount,
          currency: "USD",
          comment: activity.comment,
          status: "POSTED",
        },
      });
      expect(response.ok()).toBeTruthy();
    }
  });

  test("4. View mode shows the table", async () => {
    await openSpendingTab();
    await setEditMode(false);

    await expect(page.getByRole("table")).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-slot="grid"]')).not.toBeVisible();
  });

  test("5. Toggling edit mode swaps in the data grid", async () => {
    await openSpendingTab();
    await setEditMode(true);

    await expect(page.locator('[data-slot="grid"]')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('[data-slot="grid-row"]').first()).toBeVisible({ timeout: 20000 });
    // The grid replaces the plain table rather than rendering alongside it.
    await expect(page.getByRole("table")).not.toBeVisible();
  });

  test("6. The mode is shared with the investments tab", async () => {
    await openSpendingTab();
    await setEditMode(true);

    await gotoAppPath(page, "/activities?tab=investments");
    await page.waitForTimeout(2000);

    // Both tabs read the same `activity-view-mode` key, so investments must
    // already be in edit mode without touching its own toggle.
    await expect(page.locator('[data-slot="grid"]')).toBeVisible({ timeout: 20000 });
  });

  test("7. Mode survives a reload", async () => {
    await openSpendingTab();
    await setEditMode(true);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    await expect(page.locator('[data-slot="grid"]')).toBeVisible({ timeout: 20000 });
  });

  test("8. The category popover works inside a grid cell", async () => {
    test.setTimeout(120000);
    await openSpendingTab();
    await setEditMode(true);
    await expect(page.locator('[data-slot="grid-row"]').first()).toBeVisible({ timeout: 20000 });

    await gridRow("Gas station").getByRole("button", { name: "Assign category" }).click();
    await page.waitForTimeout(800);

    // Guards the interaction this design depends on: the grid runs
    // capture-phase key handlers that must not steal from the typeahead.
    const search = page.getByPlaceholder(/search categor/i);
    await expect(search).toBeVisible({ timeout: 10000 });
    await search.click();
    await page.keyboard.type("gro");
    await page.waitForTimeout(500);
    expect(await search.inputValue()).toBe("gro");

    // Backspace must edit the input, not clear the selected grid cells.
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    expect(await search.inputValue()).toBe("gr");

    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  });

  test("9. Assigning a category from the grid persists", async () => {
    test.setTimeout(120000);
    await openSpendingTab();
    await setEditMode(true);
    await expect(page.locator('[data-slot="grid-row"]').first()).toBeVisible({ timeout: 20000 });

    await gridRow("Gas station").getByRole("button", { name: "Assign category" }).click();
    await page.waitForTimeout(800);
    await page.getByPlaceholder(/search categor/i).fill("Groceries");
    await page.waitForTimeout(600);
    await page
      .getByRole("option", { name: /Groceries/i })
      .first()
      .click();
    await page.waitForTimeout(2500);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-slot="grid-row"]').first()).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(1500);

    await expect(gridRow("Gas station").getByText("Groceries")).toBeVisible({ timeout: 15000 });
  });

  test("10. Editing a note inline saves and persists", async () => {
    test.setTimeout(120000);
    await openSpendingTab();
    await setEditMode(true);
    const row = gridRow("Supermarket");
    await expect(row).toBeVisible({ timeout: 20000 });

    // Double-click selects the cell's existing text, so this replaces the note
    // rather than appending. Use a distinctive token so the assertion below is
    // unambiguous either way.
    await row.locator('[data-column-id="notes"]').dblclick();
    await page.waitForTimeout(400);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("EDITED-E2E");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(600);

    const save = page.getByRole("button", { name: /^Save$/i });
    await expect(save).toBeVisible({ timeout: 10000 });
    await save.click();
    await page.waitForTimeout(3000);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-slot="grid-row"]').first()).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(1500);

    await expect(gridRow("EDITED-E2E")).toBeVisible({ timeout: 15000 });
  });

  test("11. The grid offers the same row actions as the table", async () => {
    test.setTimeout(120000);
    await openSpendingTab();
    await setEditMode(true);
    await expect(gridRow("Gas station")).toBeVisible({ timeout: 20000 });

    await gridRow("Gas station").getByRole("button", { name: "Row actions" }).click();
    await page.waitForTimeout(600);

    // Same menu component the view-mode row renders, so the two tabs cannot
    // drift apart on what a row can do.
    await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("menuitem", { name: "Split transaction" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();

    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  });

  test("12. Row deletion is staged until Save", async () => {
    test.setTimeout(180000);
    await openSpendingTab();
    await setEditMode(true);
    await expect(gridRow("Payroll")).toBeVisible({ timeout: 20000 });

    // Ctrl+Backspace deletes without confirming, so it must only stage.
    await gridRow("Payroll").locator('[data-column-id="notes"]').click();
    await page.waitForTimeout(400);
    await page.keyboard.press("ControlOrMeta+Backspace");
    await page.waitForTimeout(800);

    await expect(gridRow("Payroll")).toHaveCount(0);

    const cancel = page.getByRole("button", { name: /^Cancel$/i });
    await expect(cancel).toBeVisible({ timeout: 10000 });
    await cancel.click();
    await page.waitForTimeout(1200);

    // Discarding brings it back, which proves nothing was destroyed.
    await expect(gridRow("Payroll")).toBeVisible({ timeout: 15000 });

    await gridRow("Payroll").locator('[data-column-id="notes"]').click();
    await page.waitForTimeout(400);
    await page.keyboard.press("ControlOrMeta+Backspace");
    await page.waitForTimeout(800);

    const save = page.getByRole("button", { name: /^Save$/i });
    await expect(save).toBeVisible({ timeout: 10000 });
    await save.click();
    await page.waitForTimeout(3000);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-slot="grid-row"]').first()).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(1500);

    await expect(gridRow("Payroll")).toHaveCount(0);
  });
});
