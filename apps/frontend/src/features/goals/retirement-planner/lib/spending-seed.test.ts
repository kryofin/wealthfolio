import { describe, expect, it } from "vitest";
import type { BudgetSnapshot } from "@/features/spending/types/budget";
import type { MonthlyReport } from "@/features/spending/types/report";
import {
  spendingSeedFromReport,
  trailingFullMonthsReportRequest,
  type SeedCategoryMeta,
} from "./spending-seed";

const LABELS = { uncategorized: "Uncategorized" };

function report(overrides: Partial<MonthlyReport> = {}): MonthlyReport {
  return {
    current: { income: 0, outflow: 0, saved: 0, net: 0, count: 0 },
    prior: { income: 0, outflow: 0, saved: 0, net: 0, count: 0 },
    spendingBreakdown: [],
    incomeBreakdown: [],
    savingsBreakdown: [],
    byDay: [],
    byDayByCategory: [],
    ...overrides,
  };
}

function daysAcrossMonths(months: number, outflow = 100) {
  return Array.from({ length: months }, (_, i) => ({
    date: `2026-${String(i + 1).padStart(2, "0")}-15`,
    income: 0,
    outflow,
  }));
}

function breakdown(categoryId: string, amount: number) {
  return { taxonomyId: "spending_categories", categoryId, amount, count: 1 };
}

function meta(entries: Record<string, SeedCategoryMeta>) {
  return new Map(Object.entries(entries));
}

/** Minimal budget snapshot: only the group key and category ids matter to the seed. */
function budgetWithGroups(groups: Record<string, string[]>): BudgetSnapshot {
  return {
    state: { groups: [], groupAssignments: [], targets: [], rolloverSettings: [] },
    computed: {
      currency: "USD",
      periodKey: "default",
      fxAsOf: null,
      groupRows: Object.entries(groups).map(([key, categoryIds]) => ({
        group: {
          id: `grp_${key}`,
          name: key,
          key,
          color: null,
          icon: null,
          sortOrder: 0,
          isSystem: true,
          createdAt: "",
          updatedAt: "",
        },
        categoryTargetTotal: 0,
        buffer: 0,
        plannedTotal: 0,
        actual: 0,
        rolloverIn: 0,
        rolloverOut: 0,
        remaining: 0,
        overspent: false,
        rolloverEnabled: false,
        categories: categoryIds.map((categoryId) => ({
          taxonomyId: "spending_categories",
          categoryId,
          groupId: `grp_${key}`,
          parentId: null,
          name: categoryId,
          color: null,
          icon: null,
          target: 0,
          actual: 0,
          rolloverIn: 0,
          rolloverOut: 0,
          remaining: 0,
          overspent: false,
          hasDefaultTarget: false,
          hasMonthOverride: false,
          rolloverEnabled: false,
        })),
      })),
      ungroupedRows: [],
      incomeRows: [],
      totals: {
        spendingPlanned: 0,
        spendingActual: 0,
        spendingRemaining: 0,
        incomePlanned: 0,
        incomeActual: 0,
        groupBuffer: 0,
        rolloverIn: 0,
        rolloverOut: 0,
        overspentCount: 0,
      },
    },
  };
}

describe("spendingSeedFromReport", () => {
  it("returns null with fewer than three months of outflow", () => {
    const seed = spendingSeedFromReport(
      report({ byDay: daysAcrossMonths(2), spendingBreakdown: [breakdown("cat_housing", 2400)] }),
      undefined,
      new Map(),
      LABELS,
    );
    expect(seed).toBeNull();
  });

  it("ignores months whose net outflow is zero or a refund", () => {
    const byDay = [
      ...daysAcrossMonths(3),
      { date: "2026-04-10", income: 0, outflow: -50 },
      { date: "2026-05-10", income: 200, outflow: 0 },
    ];
    const seed = spendingSeedFromReport(
      report({ byDay, spendingBreakdown: [breakdown("cat_housing", 1200)] }),
      undefined,
      new Map(),
      LABELS,
    );
    expect(seed?.monthsWithData).toBe(3);
  });

  it("creates one item per top-level category tagged by budget group, must-have first", () => {
    const budget = budgetWithGroups({
      needs: ["cat_housing", "cat_groceries"],
      wants: ["cat_entertainment"],
      personal: ["cat_personal"],
      giving: ["cat_gifts"],
      savings: ["cat_savings"],
    });
    const seed = spendingSeedFromReport(
      report({
        byDay: daysAcrossMonths(12),
        spendingBreakdown: [
          breakdown("cat_entertainment", 2400),
          breakdown("cat_groceries", 6000),
          breakdown("cat_gifts", 1200),
          breakdown("cat_housing", 18000),
          breakdown("cat_personal", 3600),
          breakdown("cat_savings", 12000),
        ],
      }),
      budget,
      meta({
        cat_housing: { name: "Housing" },
        cat_groceries: { name: "Groceries" },
        cat_entertainment: { name: "Entertainment" },
        cat_personal: { name: "Personal" },
        cat_gifts: { name: "Gifts" },
        cat_savings: { name: "Savings" },
      }),
      LABELS,
    );
    expect(seed?.items).toEqual([
      expect.objectContaining({ label: "Housing", monthlyAmount: 1500, essential: true }),
      expect.objectContaining({ label: "Groceries", monthlyAmount: 500, essential: true }),
      expect.objectContaining({ label: "Personal", monthlyAmount: 300, essential: false }),
      expect.objectContaining({ label: "Entertainment", monthlyAmount: 200, essential: false }),
      expect.objectContaining({ label: "Gifts", monthlyAmount: 100, essential: false }),
    ]);
    expect(seed?.monthlyTotal).toBe(2600);
  });

  it("rolls subcategories up into their top-level parent before grouping", () => {
    const budget = budgetWithGroups({ wants: ["cat_entertainment"] });
    const seed = spendingSeedFromReport(
      report({
        byDay: daysAcrossMonths(12),
        spendingBreakdown: [breakdown("cat_streaming", 1200), breakdown("cat_entertainment", 1200)],
      }),
      budget,
      meta({
        cat_entertainment: { name: "Entertainment" },
        cat_streaming: { name: "Streaming", parentId: "cat_entertainment" },
      }),
      LABELS,
    );
    expect(seed?.items).toEqual([
      expect.objectContaining({ id: "cat_entertainment", monthlyAmount: 200, essential: false }),
    ]);
  });

  it("treats uncategorized and ungrouped spending as must-have and rounds to tens", () => {
    const seed = spendingSeedFromReport(
      report({
        byDay: daysAcrossMonths(12),
        spendingBreakdown: [breakdown("__uncategorized__", 6000), breakdown("cat_x", 6543)],
      }),
      undefined,
      new Map(),
      LABELS,
    );
    expect(seed?.items).toEqual([
      expect.objectContaining({ id: "cat_x", label: "cat_x", monthlyAmount: 550, essential: true }),
      expect.objectContaining({
        id: "__uncategorized__",
        label: "Uncategorized",
        monthlyAmount: 500,
        essential: true,
      }),
    ]);
  });

  it("returns null when every item rounds to zero", () => {
    const seed = spendingSeedFromReport(
      report({ byDay: daysAcrossMonths(3, 1), spendingBreakdown: [breakdown("cat_x", 3)] }),
      undefined,
      new Map(),
      LABELS,
    );
    expect(seed).toBeNull();
  });
});

describe("trailingFullMonthsReportRequest", () => {
  it("covers the previous twelve full calendar months", () => {
    const request = trailingFullMonthsReportRequest(12, new Date("2026-09-08T12:00:00Z"), "UTC");
    expect(request.startDate).toBe("2025-09-01T00:00:00.000Z");
    expect(request.endDate).toBe("2026-08-31T23:59:59.999Z");
  });
});
