import type { TaxonomyCategory } from "@/lib/types";

import {
  getActivitySpendingAmount,
  getEffectiveCashActivityType,
  isCashActivityIncome,
} from "./constants";
import type {
  ActivitySplit,
  ActivityTaxonomyAssignment,
  CashActivity,
  TransferLinkStatus,
} from "../types/cash-activity";

/** Stable sorted Set→array used in React Query keys (insertion order is unstable). */
export function stableArr(s: Set<string>): string[] | undefined {
  if (s.size === 0) return undefined;
  return [...s].sort();
}

/** "transaction" / "transactions" given a count. */
export function pluralizeTransaction(n: number): string {
  return n === 1 ? "transaction" : "transactions";
}
export function pluralizeActivity(n: number): string {
  return n === 1 ? "activity" : "activities";
}

const SPENDING_TAXONOMY = "spending_categories";
const INCOME_TAXONOMY = "income_sources";
const SAVINGS_TAXONOMY = "savings_categories";

/**
 * View-model for a transaction row. Pulls the (single) activity-scope assignment
 * + its category metadata into a flat shape that the row component can render
 * without re-doing lookups.
 */
export interface TransactionRowVM {
  activity: CashActivity;
  category: {
    assignmentId: string;
    taxonomyId: string;
    id: string;
    name: string;
    color: string | null;
    parentName: string | null;
  } | null;
  splitCount: number;
  needsReview: boolean;
}

/** Amount sign + flow classification shared by the desktop row and mobile card. */
export interface TransactionDisplay {
  isOutflow: boolean;
  isIncome: boolean;
  isSaving: boolean;
  isRefund: boolean;
  isNeutral: boolean;
  /** "-" for outflow, "+" for income/refund, "" for neutral. */
  sign: string;
  /** Absolute-safe parsed amount (0 when unparseable). */
  safeAmount: number;
}

export function isTransferCashActivity(activity: {
  activityType: string;
  activityTypeOverride?: string | null;
}): boolean {
  const activityType = getEffectiveCashActivityType(activity);
  return activityType === "TRANSFER_IN" || activityType === "TRANSFER_OUT";
}

export function getTransferLinkStatus(activity: CashActivity): TransferLinkStatus | null {
  if (!isTransferCashActivity(activity)) {
    return null;
  }
  return activity.transferLinkStatus ?? (activity.sourceGroupId ? "linked" : "unlinked");
}

export function getTransactionDisplay(
  activity: CashActivity,
  accountType: string | undefined,
): TransactionDisplay {
  if (activity.cashFlowBucket) {
    const amount = parseFloat(activity.amount ?? "0");
    const safeAmount = Number.isFinite(amount) ? amount : 0;
    const spendingAmount = getActivitySpendingAmount(activity, accountType);
    const isIncome = activity.cashFlowBucket === "income";
    const isSaving = activity.cashFlowBucket === "saving";
    const isOutflow = isSaving || (activity.cashFlowBucket === "spending" && spendingAmount > 0);
    const isNeutral = activity.cashFlowBucket === "neutral";
    const isRefund = activity.cashFlowBucket === "spending" && spendingAmount < 0;
    const sign = isOutflow ? "-" : isIncome || isRefund ? "+" : "";
    return { isOutflow, isIncome, isSaving, isRefund, isNeutral, sign, safeAmount };
  }

  const spendingAmount = getActivitySpendingAmount(activity, accountType);
  const isOutflow = spendingAmount > 0;
  const activityType = getEffectiveCashActivityType(activity);
  const isInternalTransfer = !!activity.sourceGroupId && isTransferCashActivity(activity);
  const isIncome =
    !isInternalTransfer && isCashActivityIncome(activityType, accountType, activity.subtype);
  const isSaving = false;
  const isRefund = spendingAmount < 0;
  const isNeutral = !isOutflow && !isIncome && !isRefund;
  const sign = isOutflow ? "-" : isIncome || isRefund ? "+" : "";
  const amount = parseFloat(activity.amount ?? "0");
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  return { isOutflow, isIncome, isSaving, isRefund, isNeutral, sign, safeAmount };
}

/**
 * Net of the selected rows, signed the same way each row renders: income and
 * refunds add, spending outflows and savings transfers subtract, neutral rows
 * contribute nothing. Returns `null` when nothing is selected.
 *
 * Rows carry `convertedAmount` (the base-currency magnitude) so a selection
 * spanning currencies still sums; the native amount is the fallback when the
 * server did not convert. Because the signs mirror the row display, selecting
 * every row of a filtered set yields the server's filtered balance.
 */
export function computeSelectedBalance(
  rows: TransactionRowVM[],
  selectedRowIds: Set<string>,
  accountTypeFor: (accountId: string) => string | undefined,
): number | null {
  if (selectedRowIds.size === 0) return null;
  return rows
    .filter((row) => selectedRowIds.has(row.activity.id))
    .reduce((sum, row) => {
      const { sign, safeAmount } = getTransactionDisplay(
        row.activity,
        accountTypeFor(row.activity.accountId),
      );
      const magnitude = row.activity.convertedAmount ?? Math.abs(safeAmount);
      if (sign === "-") return sum - magnitude;
      if (sign === "+") return sum + magnitude;
      return sum;
    }, 0);
}

export function toRowVM(
  item: CashActivity,
  allCategories: Map<string, TaxonomyCategory>,
): TransactionRowVM {
  const expectedTaxonomy =
    item.cashFlowBucket === "income"
      ? INCOME_TAXONOMY
      : item.cashFlowBucket === "saving"
        ? SAVINGS_TAXONOMY
        : item.cashFlowBucket === "spending"
          ? SPENDING_TAXONOMY
          : null;
  const asg = expectedTaxonomy
    ? (item.assignments ?? []).find(
        (x: ActivityTaxonomyAssignment) => x.taxonomyId === expectedTaxonomy,
      )
    : undefined;
  const splits = expectedTaxonomy
    ? (item.splits ?? []).filter((x: ActivitySplit) => x.taxonomyId === expectedTaxonomy)
    : [];
  const cat = asg ? allCategories.get(asg.categoryId) : undefined;
  const parent = cat?.parentId ? allCategories.get(cat.parentId) : undefined;

  return {
    activity: item,
    category:
      splits.length === 0 && asg && cat
        ? {
            assignmentId: asg.id,
            taxonomyId: asg.taxonomyId,
            id: cat.id,
            name: cat.name,
            color: cat.color ?? null,
            parentName: parent?.name ?? null,
          }
        : null,
    splitCount: splits.length,
    needsReview: item.needsReview,
  };
}
