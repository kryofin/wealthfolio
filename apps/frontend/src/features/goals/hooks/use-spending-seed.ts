import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useBudget } from "@/features/spending/hooks/use-budget";
import { useSpendingReport } from "@/features/spending/hooks/use-spending-report";
import { useSpendingSettings } from "@/features/spending/hooks/use-spending-settings";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { useSettingsContext } from "@/lib/settings-provider";
import {
  SPENDING_SEED_MONTHS,
  spendingSeedFromReport,
  trailingFullMonthsReportRequest,
  type SeedCategoryMeta,
  type SpendingSeed,
} from "../retirement-planner/lib/spending-seed";

const SPENDING_TAXONOMY = "spending_categories";

/**
 * Retirement expense items derived from the user's trailing spending history.
 * `seed` is null while loading, when spending tracking is off, or when there
 * is too little data.
 */
export function useSpendingSeed(enabled = true): { seed: SpendingSeed | null } {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const spendingSettings = useSpendingSettings();
  const active = enabled && spendingSettings.isEnabled && spendingSettings.accountIds.length > 0;
  const timezone = settings?.timezone;

  const request = useMemo(
    () => trailingFullMonthsReportRequest(SPENDING_SEED_MONTHS, new Date(), timezone),
    [timezone],
  );
  const report = useSpendingReport(request, active);
  const budget = useBudget(undefined, active);
  const taxonomy = useTaxonomy(active ? SPENDING_TAXONOMY : null);

  const seed = useMemo(() => {
    if (!active || !report.data || budget.isLoading || taxonomy.isLoading) return null;
    const meta = new Map<string, SeedCategoryMeta>(
      (taxonomy.data?.categories ?? []).map((category) => [category.id, category]),
    );
    return spendingSeedFromReport(report.data, budget.data, meta, {
      uncategorized: t("goals:spending_seed.uncategorized_label"),
    });
  }, [active, report.data, budget.isLoading, budget.data, taxonomy.isLoading, taxonomy.data, t]);

  return { seed };
}
