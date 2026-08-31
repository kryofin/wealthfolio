import { describe, expect, it } from "vitest";

import type { CashActivity } from "../types/cash-activity";
import {
  computeSelectedBalance,
  getTransferLinkStatus,
  isTransferCashActivity,
  toRowVM,
  type TransactionRowVM,
} from "./transactions-helpers";

function cashActivity(overrides: Partial<CashActivity>): CashActivity {
  return {
    id: "activity-1",
    activityType: "WITHDRAWAL",
    activityDate: "2026-01-01T00:00:00.000Z",
    accountId: "account-1",
    amount: "100",
    currency: "USD",
    cashFlowBucket: "neutral",
    assignments: [],
    splits: [],
    isUserModified: false,
    needsReview: false,
    status: "POSTED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as CashActivity;
}

describe("spending transaction helpers", () => {
  it("treats activity type overrides as transfer rows", () => {
    const activity = cashActivity({
      activityTypeOverride: "TRANSFER_OUT",
      transferLinkStatus: "unlinked",
    });

    expect(isTransferCashActivity(activity)).toBe(true);
    expect(getTransferLinkStatus(activity)).toBe("unlinked");
  });

  it("does not expose transfer link status for non-transfer effective types", () => {
    expect(getTransferLinkStatus(cashActivity({ sourceGroupId: "group-1" }))).toBeNull();
  });

  it("prefers split display state over a single category assignment", () => {
    const activity = cashActivity({
      cashFlowBucket: "spending",
      assignments: [
        {
          id: "assignment-1",
          activityId: "activity-1",
          taxonomyId: "spending_categories",
          categoryId: "groceries",
          weight: 10_000,
          source: "manual",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      splits: [
        {
          id: "split-1",
          activityId: "activity-1",
          taxonomyId: "spending_categories",
          categoryId: "groceries",
          amount: "80.00",
          note: null,
          sortOrder: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "split-2",
          activityId: "activity-1",
          taxonomyId: "spending_categories",
          categoryId: "household",
          amount: "40.00",
          note: null,
          sortOrder: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const row = toRowVM(
      activity,
      new Map([
        [
          "groceries",
          {
            id: "groceries",
            taxonomyId: "spending_categories",
            name: "Groceries",
            key: "groceries",
            color: "#4385be",
            sortOrder: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      ]),
    );

    expect(row.category).toBeNull();
    expect(row.splitCount).toBe(2);
  });
});

describe("computeSelectedBalance", () => {
  const cashAccount = () => "CASH";

  function row(overrides: Partial<CashActivity>): TransactionRowVM {
    return {
      activity: cashActivity(overrides),
      category: null,
      splitCount: 0,
      needsReview: false,
    };
  }

  const income = row({ id: "income", activityType: "DEPOSIT", amount: "1000", cashFlowBucket: "income" }); // prettier-ignore
  const outflow = row({ id: "outflow", activityType: "WITHDRAWAL", amount: "400", cashFlowBucket: "spending" }); // prettier-ignore
  const refund = row({ id: "refund", activityType: "CREDIT", subtype: "REFUND", amount: "150", cashFlowBucket: "spending" }); // prettier-ignore
  const saving = row({ id: "saving", activityType: "TRANSFER_OUT", sourceGroupId: "x", amount: "250", cashFlowBucket: "saving" }); // prettier-ignore
  const neutral = row({ id: "neutral", activityType: "TRANSFER_IN", sourceGroupId: "y", amount: "900", cashFlowBucket: "neutral" }); // prettier-ignore

  const all = [income, outflow, refund, saving, neutral];
  const idsOf = (...rows: TransactionRowVM[]) => new Set(rows.map((r) => r.activity.id));

  it("returns null when nothing is selected", () => {
    expect(computeSelectedBalance(all, new Set(), cashAccount)).toBeNull();
  });

  it.each([
    ["income adds", income, 1000],
    ["spending outflows subtract", outflow, -400],
    ["refunds add", refund, 150],
    ["savings transfers subtract", saving, -250],
    ["neutral transfers contribute nothing", neutral, 0],
  ])("%s", (_label, selectedRow, expected) => {
    expect(computeSelectedBalance(all, idsOf(selectedRow), cashAccount)).toBe(expected);
  });

  it("nets a mixed selection", () => {
    // 1000 - 400 + 150 - 250 + 0
    expect(computeSelectedBalance(all, idsOf(...all), cashAccount)).toBe(500);
  });

  it("counts only the selected rows", () => {
    expect(computeSelectedBalance(all, idsOf(income, outflow), cashAccount)).toBe(600);
  });

  it("uses the base-currency amount so a mixed-currency selection still sums", () => {
    const foreign = row({
      id: "foreign",
      activityType: "WITHDRAWAL",
      amount: "40",
      currency: "EUR",
      cashFlowBucket: "spending",
      convertedAmount: 80,
    });

    expect(computeSelectedBalance([foreign], idsOf(foreign), cashAccount)).toBe(-80);
  });

  it("falls back to the native amount when the server did not convert", () => {
    expect(computeSelectedBalance([outflow], idsOf(outflow), cashAccount)).toBe(-400);
  });

  it("ignores ids that are not among the loaded rows", () => {
    expect(computeSelectedBalance(all, new Set(["not-loaded"]), cashAccount)).toBe(0);
  });
});
