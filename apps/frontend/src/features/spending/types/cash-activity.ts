import type { Activity } from "@/lib/types";

export interface CashActivityFilter {
  accountIds?: string[];
  startDate?: string;
  endDate?: string;
  activityTypes?: string[];
}

export interface ActivityTaxonomyAssignment {
  id: string;
  activityId: string;
  taxonomyId: string;
  categoryId: string;
  weight: number;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActivitySplit {
  id: string;
  activityId: string;
  taxonomyId: string;
  categoryId: string;
  amount: string | number;
  note?: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewActivitySplit {
  taxonomyId: string;
  categoryId: string;
  amount: string | number;
  note?: string | null;
  sortOrder?: number | null;
}

export type CashFlowBucket = "spending" | "income" | "saving" | "neutral";
export type TransferLinkStatus = "linked" | "unlinked" | "invalid";

export type CashActivityStatusFilter = "all" | "needs_review" | "uncategorized" | "categorized";

export type CashActivitySortField = "date" | "amount";
export type CashActivitySortDirection = "asc" | "desc";

/** Search request — mirrors `wealthfolio_spending::cash_activities::CashActivitySearchRequest`. */
export interface CashActivitySearchRequest {
  search?: string;
  accountIds?: string[];
  activityTypes?: string[];
  categoryIds?: string[];
  subcategoryIds?: string[];
  eventIds?: string[];
  status?: CashActivityStatusFilter;
  startDate?: string;
  endDate?: string;
  minAmount?: number;
  maxAmount?: number;
  sortBy?: CashActivitySortField;
  sortDir?: CashActivitySortDirection;
  offset?: number;
  limit?: number;
}

/**
 * Canonical cash-activity row. Mirrors
 * `wealthfolio_spending::cash_activities::CashActivity` — the portfolio-wide
 * `Activity` flattened with spending-domain enrichments (single-select
 * assignment + optional event tag). Both `list()` and `search()` return this
 * shape; consumers should always use it instead of bare `Activity` when in
 * the spending feature.
 */
export interface CashActivity extends Activity {
  cashFlowBucket: CashFlowBucket;
  assignments: ActivityTaxonomyAssignment[];
  splits: ActivitySplit[];
  /** Spending event tag from the `activity_events` join. `undefined` when untagged. */
  eventId?: string | null;
  /** Transfer pair validity for effective TRANSFER_IN / TRANSFER_OUT rows. */
  transferLinkStatus?: TransferLinkStatus | null;
  /**
   * Signed cash movement in the base currency: positive when money entered the
   * account, negative when it left. Computed server-side by the same resolver
   * that builds account balances, so clients sum these directly rather than
   * re-deriving a sign from `cashFlowBucket`.
   */
  cashMovement?: number;
  /**
   * The same signed movement in the row's own currency, unconverted. Lets a
   * single-currency selection total exactly, with no FX rounding.
   */
  cashMovementNative?: number;
}

/** Net balance over the full filtered set, in the base currency. */
export interface FilteredBalance {
  amount: number;
  /**
   * The currency shared by every matching row, or the base currency when they
   * differ.
   */
  currency: string;
  /**
   * True when the set spanned more than one currency and had to be FX-converted.
   * Disclosed in the UI, because the visible rows may all share a currency while
   * an unloaded one does not.
   */
  converted: boolean;
}

export interface CashActivitySearchResponse {
  items: CashActivity[];
  totalCount: number;
  /** Only present on the first page (offset 0). */
  filteredBalance?: FilteredBalance;
}
