use serde::{Deserialize, Serialize};

use crate::activity_assignments::ActivityTaxonomyAssignment;
use crate::activity_splits::ActivitySplit;
use wealthfolio_core::activities::Activity;

/// Filter for listing cash activities. All fields optional.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashActivityFilter {
    /// Restrict to specific accounts (intersected with the spending account list).
    /// If None, all spending accounts are queried.
    pub account_ids: Option<Vec<String>>,
    /// Restrict to a date window (RFC3339 strings on either side; both inclusive).
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// Restrict to specific activity_types. If None, defaults to CASH_ACTIVITY_TYPES.
    pub activity_types: Option<Vec<String>>,
}

/// Status filter for cash-activity search.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum CashActivityStatusFilter {
    #[default]
    All,
    NeedsReview,
    Uncategorized,
    Categorized,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum CashActivitySortField {
    #[default]
    Date,
    Amount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum SortDirection {
    Asc,
    #[default]
    Desc,
}

/// Search request for cash activities. Powers the spending Transactions page.
/// All filters optional. Server-side: filters → sort → paginate → join assignments.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashActivitySearchRequest {
    /// Free-text search over notes (payee). Case-insensitive contains-match.
    pub search: Option<String>,
    /// Restrict to these accounts (intersected with the spending account list).
    pub account_ids: Option<Vec<String>>,
    /// Restrict to specific activity_types. If None, defaults to CASH_ACTIVITY_TYPES.
    pub activity_types: Option<Vec<String>>,
    /// Filter to activities assigned to any of these top-level categories
    /// (caller is responsible for expanding subcategories).
    pub category_ids: Option<Vec<String>>,
    /// Filter to activities assigned to specific (sub)category ids.
    pub subcategory_ids: Option<Vec<String>>,
    /// Filter to activities tagged with these events (uses Activity.event_id).
    pub event_ids: Option<Vec<String>>,
    /// Status: All / NeedsReview / Uncategorized / Categorized.
    #[serde(default)]
    pub status: CashActivityStatusFilter,
    /// Date window — RFC3339 strings, inclusive.
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// Absolute amount range (operates on |amount|).
    pub min_amount: Option<f64>,
    pub max_amount: Option<f64>,
    /// Sort.
    #[serde(default)]
    pub sort_by: CashActivitySortField,
    #[serde(default)]
    pub sort_dir: SortDirection,
    /// Pagination.
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    50
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CashFlowBucket {
    Spending,
    Income,
    Saving,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferLinkStatus {
    Linked,
    Unlinked,
    Invalid,
}

/// Canonical cash-activity row, returned by every spending read path
/// (`list()` and `search()`). Flattens the portfolio-wide `Activity` and
/// adds the spending-domain enrichments — single-select category assignment
/// and the optional event tag — so callers always get the full shape in one
/// round-trip.
///
/// Why this exists vs `Activity`: the core `Activity` struct is shared with
/// the portfolio/investments path and stays free of spending-domain
/// coupling. The enrichment fields live on the join tables
/// (`activity_taxonomy_assignments`, `activity_events`) and only the
/// spending feature's API surface joins them in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashActivity {
    #[serde(flatten)]
    pub activity: Activity,
    /// Accounting bucket for this activity. Categories label the bucket; they do
    /// not move the activity between Spending, Income, Saving, and Neutral.
    pub cash_flow_bucket: CashFlowBucket,
    /// Activity-scope assignments for this row. Typically 0 or 1 (single-select).
    pub assignments: Vec<ActivityTaxonomyAssignment>,
    /// Exact category allocations. When present, these replace the single
    /// assignment for budget/report actuals.
    #[serde(default)]
    pub splits: Vec<ActivitySplit>,
    /// Spending event tag from the `activity_events` join. `None` when untagged.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    /// Transfer link state for TRANSFER_IN / TRANSFER_OUT rows. Distinguishes
    /// valid pairs from orphaned or malformed source groups.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_link_status: Option<TransferLinkStatus>,
    /// Signed cash movement for this row, converted to the caller's base
    /// currency at the activity's own date: positive when money entered the
    /// account, negative when it left. Computed by the same resolver that
    /// builds account balances, so clients sum these directly instead of
    /// re-deriving a sign. `None` when the caller did not ask for conversion.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cash_movement: Option<f64>,
    /// The same signed movement in the row's OWN currency, unconverted. Lets a
    /// client total a single-currency selection exactly, with no FX rounding.
    /// `None` when the caller did not ask for conversion.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cash_movement_native: Option<f64>,
}

/// Net cash movement over the FULL filtered set (not just the returned page).
///
/// When every matching row shares one currency the total is that currency's
/// own, untouched by FX. Only a set spanning several currencies is converted to
/// the base currency, and `converted` says which of the two happened so the UI
/// can disclose it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilteredBalance {
    pub amount: f64,
    /// Currency the balance is denominated in: the currency shared by every
    /// matching row, or the base currency when they differ.
    pub currency: String,
    /// True when the set spanned more than one currency and the total had to be
    /// FX-converted. The UI discloses this, because the rows the reader can see
    /// may all share a currency while an unloaded row does not.
    pub converted: bool,
}

/// Paginated response for cash-activity search.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashActivitySearchResponse {
    pub items: Vec<CashActivity>,
    /// Total rows matching the filters (for pagination UI).
    pub total_count: usize,
    /// Net balance over the full filtered set. Only computed for the first page
    /// (`offset == 0`); `None` on subsequent pages.
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filtered_balance: Option<FilteredBalance>,
}
