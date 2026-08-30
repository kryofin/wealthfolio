import { render, screen } from "@testing-library/react";
import { DataGrid, TooltipProvider, useDataGrid } from "@wealthfolio/ui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ActivityStatus, ActivityType } from "@/lib/constants";
import type { Account } from "@/lib/types";

import { toSpendingGridRow, type SpendingGridRow } from "../lib/spending-grid-row";
import type { CashActivity } from "../types/cash-activity";
import { useSpendingColumns } from "./use-spending-columns";

// Render each popover as just its trigger. What this file verifies is that the
// grid takes the *custom cell* path at all; the popovers' own behaviour inside a
// cell depends on capture-phase key/mouse handlers that jsdom cannot exercise,
// so that is covered by the e2e spec and manual checks instead.
vi.mock("./quick-categorize-popover", () => ({
  QuickCategorizePopover: ({ trigger }: { trigger: React.ReactNode }) => <>{trigger}</>,
}));
vi.mock("./quick-event-popover", () => ({
  QuickEventPopover: ({ trigger }: { trigger: React.ReactNode }) => <>{trigger}</>,
}));

const TIMEOUT = 20_000;

// The grid virtualises off offsetHeight, which jsdom always reports as 0 —
// without a viewport no body rows mount at all.
const OFFSETS = ["offsetHeight", "offsetWidth"] as const;
const original = OFFSETS.map((p) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, p));

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 1200,
  });
});

afterAll(() => {
  OFFSETS.forEach((prop, i) => {
    const d = original[i];
    if (d) Object.defineProperty(HTMLElement.prototype, prop, d);
  });
});

const activity: CashActivity = {
  id: "act-1",
  accountId: "acc-1",
  activityType: ActivityType.WITHDRAWAL,
  status: ActivityStatus.POSTED,
  activityDate: "2026-08-28T07:12:50Z",
  currency: "USD",
  amount: "35.75",
  notes: "Gas station",
  isUserModified: false,
  needsReview: true,
  createdAt: "2026-08-28T07:12:50Z",
  updatedAt: "2026-08-28T07:12:50Z",
  cashFlowBucket: "spending",
  assignments: [],
  splits: [],
};

const account = { id: "acc-1", name: "Chequing USD", accountType: "CASH" } as Account;

function buildRow(): SpendingGridRow {
  return toSpendingGridRow(activity, {
    accountById: new Map([["acc-1", account]]),
    allCategories: new Map(),
    eventsById: new Map(),
    eventTypeById: new Map(),
  });
}

function handlers() {
  return {
    accounts: [account],
    onAssignCategory: vi.fn(),
    onClearCategory: vi.fn(),
    onSetEvent: vi.fn(),
    onEditSplits: vi.fn(),
    onMarkReimbursement: vi.fn(),
    onEdit: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onLinkTransfer: vi.fn(),
    onUnlinkTransfer: vi.fn(),
  };
}

function Harness({ rows }: { rows: SpendingGridRow[] }) {
  const columns = useSpendingColumns(handlers());
  const grid = useDataGrid<SpendingGridRow>({
    data: rows,
    columns,
    getRowId: (row) => row.id,
  });

  return (
    <TooltipProvider>
      <DataGrid
        {...grid}
        rowClassName={(row) => (row.original.needsReview ? "bg-amber-500/5" : undefined)}
      />
    </TooltipProvider>
  );
}

describe("useSpendingColumns", () => {
  it(
    "gives category, event and actions function headers so their custom cells survive",
    () => {
      // Regression guard. DataGridRow only honours columnDef.cell when
      // columnDef.header is a function; with a string header the renderer is
      // silently dropped and the column degrades to an editable text cell.
      const { result } = renderColumns();

      for (const id of ["category", "event", "actions"]) {
        const column = result.find((c) => c.id === id);
        expect(column, `missing column ${id}`).toBeDefined();
        expect(typeof column?.header, `${id} header must be a function`).toBe("function");
        expect(column?.cell).toBeDefined();
      }
    },
    TIMEOUT,
  );

  it(
    "renders the category and event cells as interactive controls, not text cells",
    () => {
      render(<Harness rows={[buildRow()]} />);

      // Proof the custom-cell path was taken: these are buttons the popovers
      // hang off, which a fallback ShortTextCell would never produce.
      expect(screen.getByRole("button", { name: "Assign category" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tag event" })).toBeInTheDocument();
    },
    TIMEOUT,
  );

  it(
    "renders the shared row-actions menu in the actions column",
    () => {
      // The grid must offer the same per-row actions as the view-mode table;
      // this is the column that carries them.
      render(<Harness rows={[buildRow()]} />);

      expect(screen.getByRole("button", { name: "Row actions" })).toBeInTheDocument();
    },
    TIMEOUT,
  );

  it(
    "applies the needs-review tint through rowClassName",
    () => {
      const { container } = render(<Harness rows={[buildRow()]} />);

      const row = container.querySelector('[data-slot="grid-row"]');
      expect(row?.className).toContain("bg-amber-500/5");
    },
    TIMEOUT,
  );
});

/** Renders the hook alone to inspect the column defs. */
function renderColumns() {
  let captured: ReturnType<typeof useSpendingColumns> = [];
  function Probe() {
    captured = useSpendingColumns(handlers());
    return null;
  }
  render(<Probe />);
  return { result: captured };
}
