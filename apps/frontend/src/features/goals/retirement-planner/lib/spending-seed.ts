import { topCategoryId, type RollupMeta } from "@/features/spending/lib/category-rollup";
import {
  addCalendarMonths,
  daysInCalendarMonth,
  getZonedDateParts,
  zonedCalendarDateBoundaryToDate,
} from "@/features/spending/lib/timezone";
import type { BudgetSnapshot } from "@/features/spending/types/budget";
import type { MonthlyReport, ReportRequest } from "@/features/spending/types/report";
import type { ExpenseItem } from "../types";
import { createExpenseItem } from "./expense-items";

export const SPENDING_SEED_MONTHS = 12;
export const SPENDING_SEED_MIN_MONTHS = 3;

const UNCATEGORIZED_CATEGORY_ID = "__uncategorized__";

/** Budget groups whose categories become flexible retirement spending; everything else is must-have. */
const FLEXIBLE_GROUP_KEYS = new Set(["wants", "personal", "giving"]);

export interface SpendingSeed {
  items: ExpenseItem[];
  monthlyTotal: number;
  monthsWithData: number;
}

export interface SpendingSeedLabels {
  uncategorized: string;
}

/** Category lookup: parent chain for rollup plus the display name. */
export interface SeedCategoryMeta extends RollupMeta {
  name?: string;
}

/** Report window covering the last `months` full calendar months, excluding the current one. */
export function trailingFullMonthsReportRequest(
  months: number,
  now: Date,
  timezone?: string | null,
): ReportRequest {
  const today = getZonedDateParts(now, timezone);
  const endMonth = addCalendarMonths({ ...today, day: 1 }, -1);
  const startMonth = addCalendarMonths(endMonth, -(months - 1));
  const end = { ...endMonth, day: daysInCalendarMonth(endMonth.year, endMonth.month) };
  return {
    startDate: zonedCalendarDateBoundaryToDate(startMonth, "start", timezone).toISOString(),
    endDate: zonedCalendarDateBoundaryToDate(end, "end", timezone).toISOString(),
  };
}

function countMonthsWithOutflow(report: MonthlyReport): number {
  const byMonth = new Map<string, number>();
  for (const day of report.byDay) {
    const month = day.date.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + day.outflow);
  }
  return [...byMonth.values()].filter((outflow) => outflow > 0).length;
}

function roundToTen(value: number): number {
  return Math.round(value / 10) * 10;
}

/**
 * Turn a trailing spending report into retirement expense items: one per
 * top-level spending category (subcategories roll up to their parent), each
 * a monthly average over the window. The category's budget group sets the
 * flag: Needs is must-have, Wants/Personal/Giving are flexible, Savings is
 * excluded. Ungrouped and uncategorized spending is must-have so unknown
 * spending is protected rather than trimmed in lean scenarios. Returns null
 * when there is too little data to be meaningful.
 */
export function spendingSeedFromReport(
  report: MonthlyReport,
  budget: BudgetSnapshot | undefined,
  categoryMeta: Map<string, SeedCategoryMeta>,
  labels: SpendingSeedLabels,
  months = SPENDING_SEED_MONTHS,
): SpendingSeed | null {
  const monthsWithData = countMonthsWithOutflow(report);
  if (monthsWithData < SPENDING_SEED_MIN_MONTHS) return null;

  const groupKeyByCategory = new Map<string, string>();
  for (const row of budget?.computed.groupRows ?? []) {
    for (const category of row.categories) {
      groupKeyByCategory.set(category.categoryId, row.group.key);
    }
  }

  const totalsByTopCategory = new Map<string, number>();
  for (const row of report.spendingBreakdown) {
    const topId = topCategoryId(row.categoryId, categoryMeta);
    if (groupKeyByCategory.get(topId) === "savings") continue;
    totalsByTopCategory.set(topId, (totalsByTopCategory.get(topId) ?? 0) + row.amount);
  }

  const items = [...totalsByTopCategory]
    .map(([categoryId, total]) => {
      const groupKey = groupKeyByCategory.get(categoryId);
      const essential = !(groupKey && FLEXIBLE_GROUP_KEYS.has(groupKey));
      const label =
        categoryId === UNCATEGORIZED_CATEGORY_ID
          ? labels.uncategorized
          : (categoryMeta.get(categoryId)?.name ?? categoryId);
      return createExpenseItem(label, roundToTen(total / months), { id: categoryId, essential });
    })
    .filter((item) => item.monthlyAmount > 0)
    .sort((a, b) => Number(b.essential) - Number(a.essential) || b.monthlyAmount - a.monthlyAmount);
  if (items.length === 0) return null;

  return {
    items,
    monthlyTotal: items.reduce((sum, item) => sum + item.monthlyAmount, 0),
    monthsWithData,
  };
}
