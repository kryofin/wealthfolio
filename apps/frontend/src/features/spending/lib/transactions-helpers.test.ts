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
  function row(
    id: string,
    native: number | undefined,
    currency = "USD",
    converted = native,
  ): TransactionRowVM {
    return {
      activity: cashActivity({
        id,
        currency,
        cashMovementNative: native,
        cashMovement: converted,
      }),
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
  const balance = (rows: TransactionRowVM[], ids: Set<string>, base = "EUR") =>
    computeSelectedBalance(rows, ids, base);

  it("returns null when nothing is selected", () => {
    expect(balance(all, new Set())).toBeNull();
  });

  it.each([
    ["inflows add", income, 1000],
    ["outflows subtract", outflow, -400],
    ["refunds add", refund, 150],
    ["transfers in add", transferIn, 900],
    ["transfers out subtract", transferOut, -900],
  ])("%s", (_label, selectedRow, expected) => {
    expect(balance(all, idsOf(selectedRow))?.amount).toBe(expected);
  });

  it("nets a mixed selection", () => {
    // 1000 - 400 + 150 + 900 - 900
    expect(balance(all, idsOf(...all))?.amount).toBe(750);
  });

  it("counts only the selected rows", () => {
    expect(balance(all, idsOf(income, outflow))?.amount).toBe(600);
  });

  // Both legs of an internal move cancel — the money never left the accounts.
  it("nets a transfer pair to zero", () => {
    expect(balance(all, idsOf(transferIn, transferOut))?.amount).toBe(0);
  });

  it("ignores ids that are not among the loaded rows", () => {
    expect(balance(all, new Set(["not-loaded"]))?.amount).toBe(0);
  });

  describe("currency", () => {
    it("reports a single-currency selection in its own currency, unconverted", () => {
      const usd = [row("a", -40, "USD", -80), row("b", -10, "USD", -20)];

      expect(balance(usd, idsOf(...usd))).toEqual({
        amount: -50,
        currency: "USD",
        converted: false,
      });
    });

    it("converts a selection spanning currencies to the base currency", () => {
      const mixed = [row("usd", -40, "USD", -80), row("gbp", -10, "GBP", -20)];

      expect(balance(mixed, idsOf(...mixed))).toEqual({
        amount: -100,
        currency: "EUR",
        converted: true,
      });
    });

    it("does not mark a selection already in the base currency as converted", () => {
      const eur = [row("a", -40, "EUR", -40)];

      expect(balance(eur, idsOf(...eur))).toEqual({
        amount: -40,
        currency: "EUR",
        converted: false,
      });
    });

    // A row that moves nothing cannot change the total, so it must not drag a
    // single-currency selection into a conversion it does not need.
    it("ignores zero-movement rows when deciding the currency", () => {
      const rows = [row("spend", -40, "USD", -80), row("draft", 0, "GBP", 0)];

      expect(balance(rows, idsOf(...rows))).toEqual({
        amount: -40,
        currency: "USD",
        converted: false,
      });
    });

    it("treats a row the server did not convert as contributing nothing", () => {
      const rows = [row("unconverted", undefined, "USD", undefined)];

      expect(balance(rows, idsOf(...rows))).toEqual({
        amount: 0,
        currency: "EUR",
        converted: false,
      });
    });

    // Selection is always a subset of the filtered set, so the two pills can
    // differ only this way round: a single-currency selection inside a wider
    // multi-currency filter. Each pill reports what it actually measured.
    it("stays in its own currency even when the wider filter is mixed", () => {
      const loaded = [
        row("usd-1", -40, "USD", -80),
        row("usd-2", -10, "USD", -20),
        row("gbp", -5, "GBP", -10),
      ];

      expect(balance(loaded, idsOf(loaded[0], loaded[1]))).toEqual({
        amount: -50,
        currency: "USD",
        converted: false,
      });
    });
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
