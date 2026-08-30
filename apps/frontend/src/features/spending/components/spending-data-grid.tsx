import type { SortingState, Updater, VisibilityState } from "@tanstack/react-table";
import { useTranslation } from "react-i18next";

import {
  Button,
  DataGrid,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icons,
  useDataGrid,
} from "@wealthfolio/ui";

import { usePersistentState } from "@/hooks/use-persistent-state";
import type { Account } from "@/lib/types";
import { ActivityDataGridPagination } from "@/pages/activity/components/activity-data-grid/activity-data-grid-pagination";

import { useSaveSpendingRows, useSpendingGridState } from "../hooks/use-spending-grid-state";
import type { SpendingGridRow } from "../lib/spending-grid-row";
import type { TransactionRowVM } from "../lib/transactions-helpers";
import { useSpendingColumns } from "./use-spending-columns";

const COLUMN_VISIBILITY_KEY = "spending-datagrid-column-visibility";

const DEFAULT_COLUMN_VISIBILITY: VisibilityState = {
  currency: false,
};

/** Same shape as the investments grid: selection on the left, actions on the right. */
const PINNED_COLUMNS = { left: ["select"], right: ["actions"] };

interface SpendingDataGridProps {
  rows: SpendingGridRow[];
  accounts: Account[];
  pageIndex: number;
  pageSize: number;
  pageCount: number;
  totalRowCount: number;
  isFetching: boolean;
  onPageChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onAssignCategory: (activityId: string, taxonomyId: string, categoryId: string) => void;
  onClearCategory: (activityId: string, taxonomyId: string) => void;
  onSetEvent: (activityId: string, eventId: string | null) => void;
  onEditSplits: (row: TransactionRowVM) => void;
  onAddTransaction: () => void;
  onMarkReimbursement: (row: TransactionRowVM) => void;
  onEdit: (row: TransactionRowVM) => void;
  onDuplicate: (row: TransactionRowVM) => void;
  onDelete: (row: TransactionRowVM) => void;
  onLinkTransfer?: (row: TransactionRowVM) => void;
  onUnlinkTransfer?: (row: TransactionRowVM) => void;
  /** Owned by the tab: the backend sorts, so the request has to carry it. */
  sorting: SortingState;
  onSortingChange: (updater: Updater<SortingState>) => void;
}

/**
 * Spending transactions in edit mode — the counterpart to `ActivityDataGrid` on
 * the investments tab, so both tabs offer the same view/edit pair.
 */
export function SpendingDataGrid({
  rows,
  accounts,
  pageIndex,
  pageSize,
  pageCount,
  totalRowCount,
  isFetching,
  onPageChange,
  onPageSizeChange,
  onAssignCategory,
  onClearCategory,
  onSetEvent,
  onEditSplits,
  onAddTransaction,
  onMarkReimbursement,
  onEdit,
  onDuplicate,
  onDelete,
  onLinkTransfer,
  onUnlinkTransfer,
  sorting,
  onSortingChange,
}: SpendingDataGridProps) {
  const { t } = useTranslation();

  const [columnVisibility, setColumnVisibility] = usePersistentState<VisibilityState>(
    COLUMN_VISIBILITY_KEY,
    DEFAULT_COLUMN_VISIBILITY,
  );

  const gridState = useSpendingGridState(rows);
  const saveRows = useSaveSpendingRows(gridState.resetChanges);

  const columns = useSpendingColumns({
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
  });

  const dataGrid = useDataGrid<SpendingGridRow>({
    data: gridState.localRows,
    columns,
    getRowId: (row) => row.id,
    enableRowSelection: true,
    enableMultiRowSelection: true,
    enableColumnFilters: true,
    enableSearch: true,
    enablePaste: true,
    // Server-side sort; the backend only supports date/amount ordering, so only
    // those two columns enable sorting. Without onSortingChange the header menu
    // would offer a sort that silently does nothing.
    manualSorting: true,
    onDataChange: gridState.onDataChange,
    onRowsDelete: gridState.markRowsForDeletion,
    onSortingChange,
    onColumnVisibilityChange: setColumnVisibility,
    state: { columnVisibility },
    initialState: {
      sorting,
      columnPinning: PINNED_COLUMNS,
    },
  });

  const toggleableColumns = dataGrid.table
    .getAllColumns()
    .filter((column) => column.getCanHide() && column.id !== "select");

  return (
    <div className="flex min-h-0 flex-1 flex-col space-y-3">
      <div className="flex items-center gap-2">
        {gridState.hasChanges && (
          <span className="text-muted-foreground text-xs">
            {t("activity:datagrid.pending_changes", { count: gridState.pendingCount })}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button
            onClick={onAddTransaction}
            variant="outline"
            size="xs"
            className="shrink-0 rounded-md"
            title={t("activity:datagrid.add_transaction")}
            aria-label={t("activity:datagrid.add_transaction")}
          >
            <Icons.Plus className="h-3.5 w-3.5" />
            <span>{t("activity:datagrid.add")}</span>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="xs"
                className="shrink-0 rounded-md px-2"
                title={t("activity:table_toggle_columns")}
                aria-label={t("activity:table_toggle_columns")}
              >
                <Icons.Settings2 className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel className="text-xs">
                {t("activity:table_toggle_columns")}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {toggleableColumns.map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  className="text-xs"
                  checked={column.getIsVisible()}
                  onCheckedChange={(value) => column.toggleVisibility(!!value)}
                >
                  {(column.columnDef.meta as { label?: string } | undefined)?.label ?? column.id}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {gridState.hasChanges && (
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            onClick={() =>
              saveRows.mutate({
                rows: gridState.dirtyRows,
                deleteIds: gridState.pendingDeleteIds,
              })
            }
            disabled={saveRows.isPending}
          >
            {saveRows.isPending && (
              <Icons.Spinner className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            )}
            {t("common:save")}
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={gridState.discardChanges}
            disabled={saveRows.isPending}
          >
            {t("common:cancel")}
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        <DataGrid
          {...dataGrid}
          stretchColumns
          height="calc(100vh - 260px)"
          rowClassName={(row) => (row.original.needsReview ? "bg-amber-500/5" : undefined)}
        />
      </div>

      <ActivityDataGridPagination
        pageIndex={pageIndex}
        pageSize={pageSize}
        pageCount={pageCount}
        totalRowCount={totalRowCount}
        isFetching={isFetching}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />
    </div>
  );
}
