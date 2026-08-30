import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Badge, Checkbox, DataGridColumnHeader, Icons, PrivacyAmount } from "@wealthfolio/ui";

import type { Account } from "@/lib/types";

import {
  CASH_ACTIVITY_TYPE_LABELS,
  CASH_ACTIVITY_TYPES,
  getCashActivityLabel,
} from "../lib/constants";
import type { SpendingGridRow } from "../lib/spending-grid-row";
import { getTransactionDisplay, type TransactionRowVM } from "../lib/transactions-helpers";
import { QuickCategorizePopover } from "./quick-categorize-popover";
import { QuickEventPopover } from "./quick-event-popover";
import { TransactionRowActions } from "./transaction-row-actions";

interface UseSpendingColumnsOptions {
  accounts: Account[];
  onAssignCategory: (activityId: string, taxonomyId: string, categoryId: string) => void;
  onClearCategory: (activityId: string, taxonomyId: string) => void;
  onSetEvent: (activityId: string, eventId: string | null) => void;
  onEditSplits: (row: TransactionRowVM) => void;
  onMarkReimbursement: (row: TransactionRowVM) => void;
  onEdit: (row: TransactionRowVM) => void;
  onDuplicate: (row: TransactionRowVM) => void;
  onDelete: (row: TransactionRowVM) => void;
  onLinkTransfer?: (row: TransactionRowVM) => void;
  onUnlinkTransfer?: (row: TransactionRowVM) => void;
}

/**
 * Column definitions for the spending transactions grid (edit mode).
 * Structurally parallel to `pages/activity/.../use-activity-columns.tsx`.
 *
 * IMPORTANT: the category and event columns render interactive popovers, which
 * requires the *custom cell* path in `DataGridRow`. That path is taken only when
 * `columnDef.header` is a FUNCTION — with a string header the `cell` renderer is
 * silently discarded and the column falls back to an editable text cell. Both
 * columns below therefore use function headers deliberately; do not "simplify"
 * them to strings. `use-spending-columns.test.tsx` guards this.
 *
 * The same fork decides the header: a string header gets `DataGridColumnHeader`
 * (the pin / sort / hide menu), a function header gets a bare div. So the
 * function headers below render `DataGridColumnHeader` themselves, otherwise
 * these two columns would silently be the only ones without that menu. Which
 * items the menu offers is then governed per column by enableSorting /
 * enableHiding / enablePinning.
 */
export function useSpendingColumns({
  accounts,
  onAssignCategory,
  onClearCategory,
  onSetEvent,
  onEditSplits,
  onMarkReimbursement,
  onEdit,
  onDuplicate,
  onDelete,
  onLinkTransfer,
  onUnlinkTransfer,
}: UseSpendingColumnsOptions) {
  const { t } = useTranslation();

  const accountOptions = useMemo(
    () => accounts.map((account) => ({ value: account.id, label: account.name })),
    [accounts],
  );

  const typeOptions = useMemo(
    () =>
      CASH_ACTIVITY_TYPES.map((type) => ({
        value: type,
        label: CASH_ACTIVITY_TYPE_LABELS[type],
      })),
    [],
  );

  return useMemo<ColumnDef<SpendingGridRow>[]>(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllRowsSelected() || (table.getIsSomeRowsSelected() && "indeterminate")
            }
            onCheckedChange={(checked) => table.toggleAllRowsSelected(Boolean(checked))}
            aria-label={t("activity:datagrid.select_all_rows")}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(checked) => row.toggleSelected(Boolean(checked))}
            aria-label={t("activity:datagrid.select_row")}
          />
        ),
        size: 36,
        minSize: 36,
        maxSize: 36,
        enableResizing: false,
        enableSorting: false,
        enableHiding: false,
      },
      {
        id: "date",
        accessorKey: "date",
        header: t("activity:datagrid.column.date_time"),
        size: 180,
        meta: { label: t("activity:datagrid.column.date_time"), cell: { variant: "datetime" } },
      },
      {
        id: "accountName",
        accessorKey: "accountId",
        header: t("common:account"),
        size: 170,
        enableSorting: false,
        meta: { label: t("common:account"), cell: { variant: "select", options: accountOptions } },
      },
      {
        id: "activityType",
        accessorKey: "activityType",
        header: t("common:type"),
        size: 150,
        enableSorting: false,
        meta: {
          label: t("common:type"),
          cell: {
            variant: "select",
            options: typeOptions,
            valueRenderer: (value: string, _option, rowData) => {
              const row = rowData as SpendingGridRow | undefined;
              return (
                <Badge variant={badgeVariantFor(row)} className="rounded-sm text-xs font-normal">
                  {getCashActivityLabel(value, row?.accountType, row?.subtype)}
                </Badge>
              );
            },
          },
        },
      },
      {
        id: "currency",
        accessorKey: "currency",
        meta: { label: t("common:currency") },
        header: t("common:currency"),
        size: 90,
        enableSorting: false,
      },
      {
        id: "notes",
        accessorKey: "notes",
        meta: { label: t("spending:txTab.nameNotes") },
        header: t("spending:txTab.nameNotes"),
        size: 240,
        enableSorting: false,
      },
      {
        id: "category",
        accessorKey: "categoryName",
        meta: { label: t("spending:filters.category") },
        // Function header on purpose — see the note above.
        header: ({ header, table }) => <DataGridColumnHeader header={header} table={table} />,
        size: 190,
        enableSorting: false,
        cell: ({ row }) => {
          const data = row.original;
          const display = getTransactionDisplay(data.vm.activity, data.accountType);

          if (display.isNeutral) {
            return (
              <span className="text-muted-foreground text-xs">
                {t("spending:transactions.neutral")}
              </span>
            );
          }

          if (data.splitCount > 0) {
            return (
              <button
                type="button"
                className="hover:bg-muted/60 -mx-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors"
                onClick={() => onEditSplits(data.vm)}
              >
                <Icons.SplitHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate text-sm">
                  {t("spending:transactions.splitLines", { count: data.splitCount })}
                </span>
              </button>
            );
          }

          return (
            <QuickCategorizePopover
              scope={display.isIncome ? "income" : display.isSaving ? "saving" : "expense"}
              selectedCategoryId={data.categoryId}
              onSelect={(taxonomyId, categoryId) =>
                onAssignCategory(data.id, taxonomyId, categoryId)
              }
              onClear={() =>
                data.vm.category && onClearCategory(data.id, data.vm.category.taxonomyId)
              }
              trigger={
                <button
                  type="button"
                  aria-label={
                    data.categoryName
                      ? t("spending:transactions.changeCategory", { name: data.categoryName })
                      : t("spending:transactions.assignCategory")
                  }
                  className="hover:bg-muted/60 -mx-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors"
                >
                  {data.categoryName ? (
                    <>
                      {data.categoryColor && (
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: data.categoryColor }}
                          aria-hidden="true"
                        />
                      )}
                      <span className="truncate text-sm">{data.categoryName}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground inline-flex items-center gap-1 text-xs italic">
                      <Icons.Plus className="h-3 w-3" aria-hidden="true" />
                      {t("spending:transactions.categorize")}
                    </span>
                  )}
                </button>
              }
            />
          );
        },
      },
      {
        id: "event",
        accessorKey: "eventName",
        meta: { label: t("spending:filters.event") },
        // Function header on purpose — see the note above.
        header: ({ header, table }) => <DataGridColumnHeader header={header} table={table} />,
        size: 170,
        enableSorting: false,
        cell: ({ row }) => {
          const data = row.original;
          return (
            <QuickEventPopover
              selectedEventId={data.eventId}
              onSelect={(eventId) => onSetEvent(data.id, eventId)}
              onClear={() => onSetEvent(data.id, null)}
              activityId={data.id}
              defaultDate={data.date}
              trigger={
                <button
                  type="button"
                  aria-label={
                    data.eventName
                      ? t("spending:transactions.changeEvent", { name: data.eventName })
                      : t("spending:transactions.tagEvent")
                  }
                  className="hover:bg-muted/60 -mx-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left transition-colors"
                >
                  {data.eventName ? (
                    <span className="bg-muted/60 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: data.eventColor ?? "var(--muted-foreground)" }}
                        aria-hidden="true"
                      />
                      <span className="truncate">{data.eventName}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground inline-flex items-center gap-1 text-xs italic">
                      <Icons.Plus className="h-3 w-3" aria-hidden="true" />
                      {t("spending:transactions.tagEvent")}
                    </span>
                  )}
                </button>
              }
            />
          );
        },
      },
      {
        id: "amount",
        accessorKey: "amount",
        header: t("common:amount"),
        size: 140,
        meta: {
          label: t("common:amount"),
          cell: {
            variant: "number",
            valueRenderer: (value: string | number | null, rowData) => {
              const row = rowData as SpendingGridRow | undefined;
              if (!row) return null;
              const numeric = typeof value === "number" ? value : Number(value ?? 0);
              const display = getTransactionDisplay(row.vm.activity, row.accountType);
              return (
                <span className="tabular-nums">
                  {display.sign}
                  <PrivacyAmount
                    value={Math.abs(Number.isFinite(numeric) ? numeric : 0)}
                    currency={row.currency}
                  />
                </span>
              );
            },
          },
        },
      },
      {
        id: "actions",
        // Renders nothing, but must stay a function: a string header would send
        // this column down the editable-text-cell path and drop the menu.
        header: () => null,
        size: 64,
        enableSorting: false,
        enableHiding: false,
        enableResizing: false,
        cell: ({ row }) => (
          <div className="flex size-full items-center justify-center">
            <TransactionRowActions
              row={row.original.vm}
              accountType={row.original.accountType}
              onMarkReimbursement={onMarkReimbursement}
              onEditSplits={onEditSplits}
              onEdit={onEdit}
              onDuplicate={onDuplicate}
              onDelete={onDelete}
              onLinkTransfer={onLinkTransfer}
              onUnlinkTransfer={onUnlinkTransfer}
            />
          </div>
        ),
      },
    ],
    [
      t,
      accountOptions,
      typeOptions,
      onAssignCategory,
      onClearCategory,
      onSetEvent,
      onEditSplits,
      onMarkReimbursement,
      onEdit,
      onDuplicate,
      onDelete,
      onLinkTransfer,
      onUnlinkTransfer,
    ],
  );
}

function badgeVariantFor(row: SpendingGridRow | undefined) {
  if (!row) return "secondary" as const;
  const { isIncome, isSaving, isRefund, isOutflow } = getTransactionDisplay(
    row.vm.activity,
    row.accountType,
  );
  if (isIncome || isSaving || isRefund) return "success" as const;
  if (isOutflow) return "destructive" as const;
  return "secondary" as const;
}
