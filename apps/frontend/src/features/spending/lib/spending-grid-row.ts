import type { Account, TaxonomyCategory } from "@/lib/types";

import type { CashActivity } from "../types/cash-activity";
import { getEffectiveCashActivityType } from "./constants";
import { toRowVM, type TransactionRowVM } from "./transactions-helpers";

/**
 * A cash activity flattened for the transactions grid.
 *
 * Everything the grid displays must live directly on this object. `DataGridRow`
 * is memoised on the `row.original` *reference* alone
 * (packages/ui/src/components/data-grid/data-grid-row.tsx), so a cell that read
 * account/category/event out of a lookup map instead would never re-render when
 * that map resolved. Denormalising here is a correctness requirement, not a
 * convenience.
 */
export interface SpendingGridRow {
  id: string;
  date: Date;
  accountId: string;
  accountName: string;
  accountType?: string;
  /** Effective type (override applied), matching what the view-mode row shows. */
  activityType: string;
  subtype?: string;
  amount: number;
  currency: string;
  notes: string;
  categoryId: string | null;
  categoryName: string;
  categoryColor: string | null;
  eventId: string | null;
  eventName: string;
  eventColor: string | null;
  splitCount: number;
  needsReview: boolean;
  /** Full view model, for the cells that drive the existing popovers/actions. */
  vm: TransactionRowVM;
}

export interface SpendingGridLookups {
  accountById: Map<string, Account>;
  allCategories: Map<string, TaxonomyCategory>;
  eventsById: Map<string, { id: string; name: string; eventTypeId: string }>;
  eventTypeById: Map<string, { color: string | null }>;
}

export function toSpendingGridRow(
  activity: CashActivity,
  lookups: SpendingGridLookups,
): SpendingGridRow {
  const vm = toRowVM(activity, lookups.allCategories);
  const account = lookups.accountById.get(activity.accountId);
  const eventId = activity.eventId ?? null;
  const event = eventId ? lookups.eventsById.get(eventId) : undefined;
  const eventColor = event ? (lookups.eventTypeById.get(event.eventTypeId)?.color ?? null) : null;
  const amount = Number(activity.amount ?? 0);

  return {
    id: activity.id,
    date: new Date(activity.activityDate),
    accountId: activity.accountId,
    accountName: account?.name ?? activity.accountId,
    accountType: account?.accountType,
    activityType: getEffectiveCashActivityType(activity),
    subtype: activity.subtype,
    amount: Number.isFinite(amount) ? amount : 0,
    currency: activity.currency,
    notes: activity.notes ?? "",
    categoryId: vm.category?.id ?? null,
    categoryName: vm.category?.name ?? "",
    categoryColor: vm.category?.color ?? null,
    eventId,
    eventName: event?.name ?? "",
    eventColor,
    splitCount: vm.splitCount,
    needsReview: vm.needsReview,
    vm,
  };
}
