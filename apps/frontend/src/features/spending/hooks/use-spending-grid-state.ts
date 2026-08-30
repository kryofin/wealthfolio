import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { deleteActivity, updateActivity } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";

import { invalidateSpendingCaches } from "../lib/invalidation";
import type { SpendingGridRow } from "../lib/spending-grid-row";

/**
 * Fields the grid lets the user edit inline. Everything else on a
 * `SpendingGridRow` is derived and read-only.
 */
const EDITABLE_FIELDS = [
  "date",
  "accountId",
  "activityType",
  "amount",
  "currency",
  "notes",
] as const;

function rowsDiffer(server: SpendingGridRow, local: SpendingGridRow): boolean {
  return EDITABLE_FIELDS.some((field) =>
    field === "date"
      ? server.date.getTime() !== local.date.getTime()
      : server[field] !== local[field],
  );
}

/**
 * Dirty-tracking for the spending transactions grid.
 *
 * Deliberately not `useActivityGridState`: that hook is bound to
 * `LocalTransaction` and its save path needs asset/instrument currency
 * resolution, which has no meaning for cash activities.
 */
export function useSpendingGridState(serverRows: SpendingGridRow[]) {
  const [localRows, setLocalRows] = useState<SpendingGridRow[]>(serverRows);
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(() => new Set());
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(() => new Set());

  const serverById = useMemo(() => new Map(serverRows.map((row) => [row.id, row])), [serverRows]);

  // Adopt fresh server data only when there is nothing unsaved to clobber —
  // pending deletions included, or a refetch would resurrect the deleted rows.
  useEffect(() => {
    if (dirtyIds.size === 0 && pendingDeleteIds.size === 0) setLocalRows(serverRows);
  }, [serverRows, dirtyIds.size, pendingDeleteIds.size]);

  const onDataChange = useCallback(
    (next: SpendingGridRow[]) => {
      setLocalRows(next);
      const dirty = new Set<string>();
      for (const row of next) {
        const server = serverById.get(row.id);
        if (server && rowsDiffer(server, row)) dirty.add(row.id);
      }
      setDirtyIds(dirty);
    },
    [serverById],
  );

  /**
   * Deletion is staged, not immediate: the grid routes here from the context
   * menu and Ctrl+Backspace, neither of which confirms first. Rows vanish from
   * view straight away (as they do on the investments grid) but the activities
   * are only destroyed once the user hits Save.
   */
  const markRowsForDeletion = useCallback((rows: SpendingGridRow[]) => {
    if (rows.length === 0) return;
    const ids = new Set(rows.map((row) => row.id));

    setLocalRows((prev) => prev.filter((row) => !ids.has(row.id)));
    setDirtyIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    setPendingDeleteIds((prev) => new Set([...prev, ...ids]));
  }, []);

  const discardChanges = useCallback(() => {
    setLocalRows(serverRows);
    setDirtyIds(new Set());
    setPendingDeleteIds(new Set());
  }, [serverRows]);

  const dirtyRows = useMemo(
    () => localRows.filter((row) => dirtyIds.has(row.id)),
    [localRows, dirtyIds],
  );

  return {
    localRows,
    dirtyRows,
    pendingDeleteIds,
    pendingCount: dirtyIds.size + pendingDeleteIds.size,
    hasChanges: dirtyIds.size > 0 || pendingDeleteIds.size > 0,
    onDataChange,
    markRowsForDeletion,
    discardChanges,
    resetChanges: useCallback(() => {
      setDirtyIds(new Set());
      setPendingDeleteIds(new Set());
    }, []),
  };
}

/** Batch-saves edited rows and commits staged deletions. */
export function useSaveSpendingRows(onSaved: () => void) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({
      rows,
      deleteIds,
    }: {
      rows: SpendingGridRow[];
      deleteIds: Set<string>;
    }) => {
      for (const row of rows) {
        const activity = row.vm.activity;
        await updateActivity({
          id: row.id,
          accountId: row.accountId,
          activityType: row.activityType,
          subtype: activity.subtype,
          activityDate: row.date.toISOString(),
          amount: row.amount,
          currency: row.currency,
          comment: row.notes.trim() === "" ? null : row.notes,
        });
      }

      for (const id of deleteIds) {
        await deleteActivity(id);
      }
    },
    onSuccess: () => {
      invalidateSpendingCaches(qc);
      void qc.invalidateQueries({ queryKey: [QueryKeys.ACTIVITIES] });
      onSaved();
    },
  });
}
