import { describe, expect, it } from "vitest";

import type { CashActivity } from "../types/cash-activity";
import {
  computeSelectedBalance,
  getTransactionDisplay,
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
  function row(id: string, cashMovement: number | undefined): TransactionRowVM {
    return {
      activity: cashActivity({ id, cashMovement }),
      category: null,
      splitCount: 0,
      needsReview: false,
    };
  }

  // Server-signed movements: money in is positive, money out negative.
  const income = row("income", 1000);
  const outflow = row("outflow", -400);
  const refund = row("refund", 150);
  const transferIn = row("transfer-in", 900);
  const transferOut = row("transfer-out", -900);

  const all = [income, outflow, refund, transferIn, transferOut];
  const idsOf = (...rows: TransactionRowVM[]) => new Set(rows.map((r) => r.activity.id));

  it("returns null when nothing is selected", () => {
    expect(computeSelectedBalance(all, new Set())).toBeNull();
  });

  it.each([
    ["inflows add", income, 1000],
    ["outflows subtract", outflow, -400],
    ["refunds add", refund, 150],
    ["transfers in add", transferIn, 900],
    ["transfers out subtract", transferOut, -900],
  ])("%s", (_label, selectedRow, expected) => {
    expect(computeSelectedBalance(all, idsOf(selectedRow))).toBe(expected);
  });

  it("nets a mixed selection", () => {
    // 1000 - 400 + 150 + 900 - 900
    expect(computeSelectedBalance(all, idsOf(...all))).toBe(750);
  });

  it("counts only the selected rows", () => {
    expect(computeSelectedBalance(all, idsOf(income, outflow))).toBe(600);
  });

  // Both legs of an internal move cancel — the money never left the accounts.
  it("nets a transfer pair to zero", () => {
    expect(computeSelectedBalance(all, idsOf(transferIn, transferOut))).toBe(0);
  });

  it("ignores rows the server did not convert", () => {
    const unconverted = row("unconverted", undefined);
    expect(computeSelectedBalance([unconverted], idsOf(unconverted))).toBe(0);
  });

  it("ignores ids that are not among the loaded rows", () => {
    expect(computeSelectedBalance(all, new Set(["not-loaded"]))).toBe(0);
  });
});

// The balance counts transfers by direction, but the table still draws them
// unsigned. Pinned so a later edit cannot silently repaint every transfer row.
describe("transfer rows stay visually neutral", () => {
  it("gives neutral rows no sign", () => {
    const transfer = cashActivity({
      id: "transfer",
      activityType: "TRANSFER_IN",
      sourceGroupId: "pair",
      cashFlowBucket: "neutral",
      cashMovement: 900,
    });

    const display = getTransactionDisplay(transfer, "CASH");

    expect(display.sign).toBe("");
    expect(display.isNeutral).toBe(true);
  });
});
