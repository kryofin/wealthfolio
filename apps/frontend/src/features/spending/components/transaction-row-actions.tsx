import { useTranslation } from "react-i18next";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icons,
} from "@wealthfolio/ui";

import { getEffectiveCashActivityType, isCreditCardAccountType } from "../lib/constants";
import {
  getTransactionDisplay,
  getTransferLinkStatus,
  isTransferCashActivity,
  type TransactionRowVM,
} from "../lib/transactions-helpers";

interface TransactionRowActionsProps {
  row: TransactionRowVM;
  accountType: string | undefined;
  onMarkReimbursement: (row: TransactionRowVM) => void;
  onEditSplits: (row: TransactionRowVM) => void;
  onEdit: (row: TransactionRowVM) => void;
  onDuplicate: (row: TransactionRowVM) => void;
  onDelete: (row: TransactionRowVM) => void;
  onLinkTransfer?: (row: TransactionRowVM) => void;
  onUnlinkTransfer?: (row: TransactionRowVM) => void;
}

/**
 * The per-row action menu, shared by the view-mode table row and the edit-mode
 * grid's actions column.
 *
 * Extracted rather than duplicated on purpose: the two tabs are meant to differ
 * in the *columns* they show, never in the actions they offer, and every drift
 * between them found so far started as a copy of one of these menus.
 */
export function TransactionRowActions({
  row,
  accountType,
  onMarkReimbursement,
  onEditSplits,
  onEdit,
  onDuplicate,
  onDelete,
  onLinkTransfer,
  onUnlinkTransfer,
}: TransactionRowActionsProps) {
  const { t } = useTranslation();
  const a = row.activity;
  const { isIncome, isNeutral } = getTransactionDisplay(a, accountType);
  const activityType = getEffectiveCashActivityType(a);
  const isTransfer = isTransferCashActivity(a);
  const transferLinkStatus = getTransferLinkStatus(a);
  const canMarkReimbursement =
    isIncome && !isCreditCardAccountType(accountType) && activityType !== "CREDIT";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          aria-label={t("spending:transactions.rowActions")}
        >
          <Icons.MoreVertical className="h-4 w-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onEdit(row)}>
          <Icons.Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
          {t("common:edit")}
        </DropdownMenuItem>
        {canMarkReimbursement && (
          <DropdownMenuItem onClick={() => onMarkReimbursement(row)}>
            <Icons.RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            {t("spending:transactions.markReimbursement")}
          </DropdownMenuItem>
        )}
        {!isNeutral && (
          <DropdownMenuItem onClick={() => onEditSplits(row)}>
            <Icons.SplitHorizontal className="mr-2 h-4 w-4" aria-hidden="true" />
            {t("spending:transactions.splitTransaction")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => onDuplicate(row)}>
          <Icons.Copy className="mr-2 h-4 w-4" aria-hidden="true" />
          {t("spending:transactions.duplicate")}
        </DropdownMenuItem>
        {isTransfer && (onLinkTransfer || onUnlinkTransfer) ? (
          transferLinkStatus === "linked" ? (
            onUnlinkTransfer ? (
              <DropdownMenuItem onClick={() => onUnlinkTransfer(row)}>
                <Icons.Unlink className="mr-2 h-4 w-4" aria-hidden="true" />
                {t("spending:transactions.unlinkTransfer")}
              </DropdownMenuItem>
            ) : null
          ) : onLinkTransfer ? (
            <DropdownMenuItem onClick={() => onLinkTransfer(row)}>
              <Icons.Link className="mr-2 h-4 w-4" aria-hidden="true" />
              {t("spending:transactions.linkTransfer")}
            </DropdownMenuItem>
          ) : null
        ) : null}
        <DropdownMenuItem className="text-destructive" onClick={() => onDelete(row)}>
          <Icons.Trash className="mr-2 h-4 w-4" aria-hidden="true" />
          {t("common:delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
