import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { TransactionsFilterBar } from "./transactions-filter-bar";
import type { FilteredBalance } from "../types/cash-activity";

vi.mock("@wealthfolio/ui", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  FacetedFilter: () => null,
  FacetedSearchInput: () => null,
  Icons: {
    ListFilter: () => null,
    Spinner: () => null,
  },
  Input: () => <input />,
  PrivacyAmount: ({ value, currency }: { value: number; currency: string }) => (
    <span>{`${currency} ${value}`}</span>
  ),
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./amount-range-filter", () => ({
  AmountRangeFilter: () => null,
}));

vi.mock("./date-range-filter", () => ({
  DateRangeFilter: () => null,
}));

function renderFilterBar({
  selectedBalance,
  filteredBalance,
  filtersActive = false,
}: {
  selectedBalance?: FilteredBalance | null;
  filteredBalance?: FilteredBalance | null;
  filtersActive?: boolean;
}) {
  return render(
    <TransactionsFilterBar
      searchInput=""
      onSearchInputChange={vi.fn()}
      statusFilter="all"
      onStatusFilterChange={vi.fn()}
      dateRange={undefined}
      onDateRangeChange={vi.fn()}
      selectedAccounts={new Set()}
      onAccountsChange={vi.fn()}
      selectedTypes={new Set()}
      onTypesChange={vi.fn()}
      selectedCategories={new Set()}
      onCategoriesChange={vi.fn()}
      selectedSubcategories={new Set()}
      onSubcategoriesChange={vi.fn()}
      selectedEvents={new Set()}
      onEventsChange={vi.fn()}
      amountRange={{ min: null, max: null }}
      onAmountRangeChange={vi.fn()}
      accountOptions={[]}
      typeOptions={[]}
      categoryOptions={[]}
      subcategoryOptions={[]}
      eventOptions={[]}
      hasEvents={false}
      filtersActive={filtersActive}
      onClearAll={vi.fn()}
      visibleCount={1}
      totalCount={3}
      selectedBalance={selectedBalance}
      filteredBalance={filteredBalance}
      isRefreshing={false}
    />,
  );
}

const selected: FilteredBalance = { amount: -120, currency: "USD", converted: false };
const filtered: FilteredBalance = { amount: 400, currency: "USD", converted: false };

describe("TransactionsFilterBar balance pills", () => {
  it("shows the selected balance whenever rows are selected", () => {
    renderFilterBar({ selectedBalance: selected });

    expect(screen.getByTestId("selected-balance")).toHaveTextContent("Selected balance:USD -120");
    expect(screen.queryByTestId("filtered-balance")).not.toBeInTheDocument();
  });

  // The default view: the server sends a filtered balance on every page-0
  // request, filtered or not, so only `filtersActive` keeps that pill hidden.
  it("shows only the selected balance when rows are selected without a filter", () => {
    renderFilterBar({
      selectedBalance: selected,
      filteredBalance: filtered,
      filtersActive: false,
    });

    expect(screen.getByTestId("selected-balance")).toBeInTheDocument();
    expect(screen.queryByTestId("filtered-balance")).not.toBeInTheDocument();
  });

  // While a filter change is in flight the balance is briefly absent.
  it("shows only the selected balance when the filtered balance has not loaded", () => {
    renderFilterBar({ selectedBalance: selected, filteredBalance: null, filtersActive: true });

    expect(screen.getByTestId("selected-balance")).toBeInTheDocument();
    expect(screen.queryByTestId("filtered-balance")).not.toBeInTheDocument();
  });

  it("renders no pills while a filter is active but its balance is still loading", () => {
    renderFilterBar({ filteredBalance: null, filtersActive: true });

    expect(screen.queryByTestId("selected-balance")).not.toBeInTheDocument();
    expect(screen.queryByTestId("filtered-balance")).not.toBeInTheDocument();
  });

  // The rows on screen can all share a currency while an unloaded one does not,
  // so a converted total says so rather than looking arbitrary.
  it("marks a converted balance so the UI can disclose it", () => {
    renderFilterBar({
      filteredBalance: { amount: 400, currency: "EUR", converted: true },
      filtersActive: true,
    });

    expect(screen.getByTestId("filtered-balance-converted")).toBeInTheDocument();
  });

  it("does not disclose anything when the balance was not converted", () => {
    renderFilterBar({ filteredBalance: filtered, filtersActive: true });

    expect(screen.queryByTestId("filtered-balance-converted")).not.toBeInTheDocument();
  });

  // Selection is a subset of the filter, so this is the only way the two pills
  // can disagree: a single-currency selection inside a mixed filter.
  it("lets the two pills show different currencies", () => {
    renderFilterBar({
      selectedBalance: { amount: -50, currency: "USD", converted: false },
      filteredBalance: { amount: 400, currency: "EUR", converted: true },
      filtersActive: true,
    });

    expect(screen.getByTestId("selected-balance")).toHaveTextContent("USD -50");
    expect(screen.getByTestId("filtered-balance")).toHaveTextContent("EUR 400");
    expect(screen.queryByTestId("selected-balance-converted")).not.toBeInTheDocument();
    expect(screen.getByTestId("filtered-balance-converted")).toBeInTheDocument();
  });

  it("shows the filtered balance only while a filter is active", () => {
    renderFilterBar({ filteredBalance: filtered, filtersActive: true });

    expect(screen.getByTestId("filtered-balance")).toHaveTextContent("Filtered balance:USD 400");
    expect(screen.queryByTestId("selected-balance")).not.toBeInTheDocument();
  });

  it("hides the filtered balance when no filter is active", () => {
    renderFilterBar({ filteredBalance: filtered, filtersActive: false });

    expect(screen.queryByTestId("filtered-balance")).not.toBeInTheDocument();
  });

  it("shows both balances together", () => {
    renderFilterBar({
      selectedBalance: selected,
      filteredBalance: filtered,
      filtersActive: true,
    });

    expect(screen.getByTestId("selected-balance")).toBeInTheDocument();
    expect(screen.getByTestId("filtered-balance")).toBeInTheDocument();
  });

  it("renders no pills when neither balance is available", () => {
    renderFilterBar({});

    expect(screen.queryByTestId("selected-balance")).not.toBeInTheDocument();
    expect(screen.queryByTestId("filtered-balance")).not.toBeInTheDocument();
  });
});
