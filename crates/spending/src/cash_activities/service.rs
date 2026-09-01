use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Utc};
use rust_decimal::{prelude::ToPrimitive, Decimal};
use wealthfolio_core::accounts::{
    account_supports_purpose, account_types, AccountPurpose, AccountRepositoryTrait,
};
use wealthfolio_core::activities::{
    Activity, ActivityRepositoryTrait, TransferPairResolution, ACTIVITY_TYPE_TRANSFER_IN,
    ACTIVITY_TYPE_TRANSFER_OUT,
};
use wealthfolio_core::portfolio::economic_events::ActivityEconomicsResolver;

use super::{
    model::{
        CashActivity, CashActivityFilter, CashActivitySearchRequest, CashActivitySearchResponse,
        CashActivitySortField, CashActivityStatusFilter, CashFlowBucket, FilteredBalance,
        SortDirection, TransferLinkStatus,
    },
    CASH_ACTIVITY_TYPES,
};
use crate::activity_allocations::{
    group_assignments as group_assignments_owned, group_splits as group_splits_owned,
};
use crate::activity_assignments::{
    ActivityTaxonomyAssignment, ActivityTaxonomyAssignmentService, BulkCategoryAssignment,
};
use crate::activity_classification::{
    activity_abs_amount, classify_activity, classify_activity_for_aggregation, decimal_to_f64,
    fx_to_target, within_spending_transfer_groups, SpendingClassification,
};
use crate::activity_splits::{ActivitySplit, ActivitySplitRepositoryTrait, NewActivitySplit};
use crate::error::SpendingError;
use crate::events::EventsService;
use crate::settings::SpendingSettingsService;

const SPENDING_TAXONOMY: &str = "spending_categories";
const INCOME_TAXONOMY: &str = "income_sources";
const SAVINGS_TAXONOMY: &str = "savings_categories";
const MAX_CASH_ACTIVITY_SEARCH_LIMIT: usize = 1_000;

/// Service for listing/searching activities scoped to the user's spending accounts.
/// Mutation (create/update/delete) goes through the existing core ActivityService;
/// categorization goes through ActivityTaxonomyAssignmentService.
pub struct CashActivityService {
    activity_repo: Arc<dyn ActivityRepositoryTrait>,
    account_repo: Arc<dyn AccountRepositoryTrait>,
    settings: Arc<SpendingSettingsService>,
    assignments: Arc<ActivityTaxonomyAssignmentService>,
    splits: Arc<dyn ActivitySplitRepositoryTrait>,
    activity_events: Arc<dyn crate::activity_events::ActivityEventsRepositoryTrait>,
    events: Arc<EventsService>,
    fx: Arc<dyn wealthfolio_core::fx::FxServiceTrait>,
}

impl CashActivityService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        activity_repo: Arc<dyn ActivityRepositoryTrait>,
        account_repo: Arc<dyn AccountRepositoryTrait>,
        settings: Arc<SpendingSettingsService>,
        assignments: Arc<ActivityTaxonomyAssignmentService>,
        splits: Arc<dyn ActivitySplitRepositoryTrait>,
        activity_events: Arc<dyn crate::activity_events::ActivityEventsRepositoryTrait>,
        events: Arc<EventsService>,
        fx: Arc<dyn wealthfolio_core::fx::FxServiceTrait>,
    ) -> Self {
        Self {
            activity_repo,
            account_repo,
            settings,
            assignments,
            splits,
            activity_events,
            events,
            fx,
        }
    }

    /// List cash activities matching the (legacy) filter, scoped to opted-in
    /// spending accounts. Returns empty vec if spending tracking is disabled
    /// or no accounts opted in.
    ///
    /// Returns `CashActivity` (same shape as `search()` items)
    /// so consumers get the activity row, its category assignments, and its
    /// event tag in a single round-trip. Before the activity_events
    /// refactor, `Activity` carried `event_id` directly; we now JOIN it in
    /// here so the frontend doesn't need a second query (and so a single
    /// regression on either path can't diverge from the other — `list()`
    /// previously missed the event-tag enrichment `search()` got).
    pub async fn list(&self, filter: CashActivityFilter) -> Result<Vec<CashActivity>> {
        let s = self.settings.get().await?;
        if !s.enabled || s.account_ids.is_empty() {
            return Ok(Vec::new());
        }

        let (all_spending_accounts, account_types) =
            self.resolve_target_accounts(None, &s.account_ids)?;
        if all_spending_accounts.is_empty() {
            return Ok(Vec::new());
        }
        let all_spending_account_ids: HashSet<&str> =
            all_spending_accounts.iter().map(String::as_str).collect();
        let requested_accounts = filter
            .account_ids
            .unwrap_or_else(|| all_spending_accounts.clone());
        let target_accounts: HashSet<String> = requested_accounts
            .into_iter()
            .filter(|id| all_spending_account_ids.contains(id.as_str()))
            .collect();
        if target_accounts.is_empty() {
            return Ok(Vec::new());
        }

        let mut activities = self
            .activity_repo
            .get_activities_by_account_ids(&all_spending_accounts)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let transfer_link_resolution = self.transfer_link_resolution()?;
        let transfer_context_acts: Vec<&Activity> = activities.iter().collect();
        let transfer_groups = within_spending_transfer_groups(&transfer_context_acts);
        activities.retain(|a| target_accounts.contains(&a.account_id));

        let allowed_types: Vec<String> = filter
            .activity_types
            .unwrap_or_else(|| CASH_ACTIVITY_TYPES.iter().map(|s| s.to_string()).collect());
        activities.retain(|a| allowed_types.iter().any(|t| t == a.effective_type()));
        retain_classified_cash_activities(&mut activities, &account_types);

        retain_by_date_range(
            &mut activities,
            filter.start_date.as_deref(),
            filter.end_date.as_deref(),
        )?;

        activities.sort_by_key(|a| std::cmp::Reverse(a.activity_date));

        // Batch-enrich with assignments + event tags. Mirrors the tail of
        // `search()`. The ids list is the *retained* rows, so we never fetch
        // joins for activities we've already filtered out.
        let ids: Vec<String> = activities.iter().map(|a| a.id.clone()).collect();
        let asgs = self.assignments.list_for_activities(&ids).await?;
        let mut by_activity = group_assignments_owned(asgs);
        let splits = self.splits.list_for_activities(&ids).await?;
        let mut splits_by_activity = group_splits_owned(splits);
        let mut tag_map = self.activity_events.list_for_activities(&ids).await?;
        let items: Vec<CashActivity> = activities
            .into_iter()
            .map(|a| {
                let assignments = by_activity.remove(&a.id).unwrap_or_default();
                let splits = splits_by_activity.remove(&a.id).unwrap_or_default();
                let event_id = tag_map.remove(&a.id);
                let cash_flow_bucket = cash_flow_bucket_for(&a, &account_types, &transfer_groups);
                let transfer_link_status = transfer_link_status_for(&a, &transfer_link_resolution);
                CashActivity {
                    activity: a,
                    cash_flow_bucket,
                    assignments,
                    splits,
                    event_id,
                    transfer_link_status,
                    cash_movement: None,
                    cash_movement_native: None,
                }
            })
            .collect();
        Ok(items)
    }

    /// Search/filter/paginate cash activities. Powers the spending Transactions page.
    /// Server-side pipeline: filters → sort → filtered balance → paginate → join
    /// assignments for the page slice.
    ///
    /// `base_currency` is the currency the filtered balance and the per-row
    /// converted amounts are denominated in. It is injected by the app-level
    /// callers (never sent by the client); pass an empty string to skip both.
    pub async fn search(
        &self,
        req: CashActivitySearchRequest,
        base_currency: &str,
    ) -> Result<CashActivitySearchResponse> {
        let s = self.settings.get().await?;
        if !s.enabled || s.account_ids.is_empty() {
            return Ok(CashActivitySearchResponse {
                items: Vec::new(),
                total_count: 0,
                filtered_balance: None,
            });
        }

        let (all_spending_accounts, account_types) =
            self.resolve_target_accounts(None, &s.account_ids)?;
        if all_spending_accounts.is_empty() {
            return Ok(CashActivitySearchResponse {
                items: Vec::new(),
                total_count: 0,
                filtered_balance: None,
            });
        }
        let all_spending_account_ids: HashSet<&str> =
            all_spending_accounts.iter().map(String::as_str).collect();
        let requested_accounts = req
            .account_ids
            .unwrap_or_else(|| all_spending_accounts.clone());
        let target_accounts: HashSet<String> = requested_accounts
            .into_iter()
            .filter(|id| all_spending_account_ids.contains(id.as_str()))
            .collect();
        if target_accounts.is_empty() {
            return Ok(CashActivitySearchResponse {
                items: Vec::new(),
                total_count: 0,
                filtered_balance: None,
            });
        }

        let mut activities = self
            .activity_repo
            .get_activities_by_account_ids(&all_spending_accounts)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let transfer_link_resolution = self.transfer_link_resolution()?;
        let transfer_context_acts: Vec<&Activity> = activities.iter().collect();
        let transfer_groups = within_spending_transfer_groups(&transfer_context_acts);
        activities.retain(|a| target_accounts.contains(&a.account_id));

        let allowed_types: Vec<String> = req
            .activity_types
            .unwrap_or_else(|| CASH_ACTIVITY_TYPES.iter().map(|s| s.to_string()).collect());
        activities.retain(|a| allowed_types.iter().any(|t| t == a.effective_type()));
        retain_classified_cash_activities(&mut activities, &account_types);

        retain_by_date_range(
            &mut activities,
            req.start_date.as_deref(),
            req.end_date.as_deref(),
        )?;

        if let Some(events) = req.event_ids.as_deref() {
            if !events.is_empty() {
                // Load per-activity tags from the join table once, then
                // filter in-memory. Mirrors the analytics services' pattern.
                let activity_ids: Vec<String> = activities.iter().map(|a| a.id.clone()).collect();
                let tag_map = self
                    .activity_events
                    .list_for_activities(&activity_ids)
                    .await?;
                activities.retain(|a| {
                    tag_map
                        .get(&a.id)
                        .map(|tag| events.iter().any(|e| e == tag))
                        .unwrap_or(false)
                });
            }
        }

        if let Some(min) = req.min_amount {
            activities.retain(|a| {
                a.amount
                    .map(|d| d.abs().to_f64().unwrap_or(0.0) >= min)
                    .unwrap_or(false)
            });
        }
        if let Some(max) = req.max_amount {
            activities.retain(|a| {
                a.amount
                    .map(|d| d.abs().to_f64().unwrap_or(0.0) <= max)
                    .unwrap_or(false)
            });
        }

        if let Some(needle) = req.search.as_deref() {
            let needle = needle.trim().to_lowercase();
            if !needle.is_empty() {
                activities.retain(|a| {
                    let notes = a.notes.as_deref().unwrap_or("").to_lowercase();
                    notes.contains(&needle)
                });
            }
        }

        // Status / category filters need assignments; fetch in batch first.
        let needs_assignments_for_filter = req.status != CashActivityStatusFilter::All
            || req
                .category_ids
                .as_ref()
                .map(|v| !v.is_empty())
                .unwrap_or(false)
            || req
                .subcategory_ids
                .as_ref()
                .map(|v| !v.is_empty())
                .unwrap_or(false);

        if needs_assignments_for_filter {
            let ids: Vec<String> = activities.iter().map(|a| a.id.clone()).collect();
            let assignments = self.assignments.list_for_activities(&ids).await?;
            let by_activity = group_assignments(&assignments);
            let splits = self.splits.list_for_activities(&ids).await?;
            let splits_by_activity = group_splits(&splits);

            activities.retain(|a| {
                let asgs = by_activity.get(a.id.as_str());
                let activity_splits = splits_by_activity.get(a.id.as_str());
                let bucket = cash_flow_bucket_for(a, &account_types, &transfer_groups);
                let expected_taxonomy = taxonomy_for_bucket(bucket);
                let has_category =
                    expected_taxonomy.map_or(bucket == CashFlowBucket::Neutral, |taxonomy_id| {
                        asgs.map(|v| v.iter().any(|asg| asg.taxonomy_id == taxonomy_id))
                            .unwrap_or(false)
                            || activity_splits
                                .map(|v| v.iter().any(|split| split.taxonomy_id == taxonomy_id))
                                .unwrap_or(false)
                    });

                match req.status {
                    CashActivityStatusFilter::All => {}
                    CashActivityStatusFilter::NeedsReview => {
                        if !a.needs_review {
                            return false;
                        }
                    }
                    CashActivityStatusFilter::Uncategorized => {
                        if has_category {
                            return false;
                        }
                    }
                    CashActivityStatusFilter::Categorized => {
                        if !has_category {
                            return false;
                        }
                    }
                }

                if let Some(cats) = req.category_ids.as_deref() {
                    if !cats.is_empty() {
                        let any = asgs
                            .map(|v| {
                                v.iter().any(|asg| {
                                    expected_taxonomy == Some(asg.taxonomy_id.as_str())
                                        && cats.iter().any(|c| c == &asg.category_id)
                                })
                            })
                            .unwrap_or(false)
                            || activity_splits
                                .map(|v| {
                                    v.iter().any(|split| {
                                        expected_taxonomy == Some(split.taxonomy_id.as_str())
                                            && cats.iter().any(|c| c == &split.category_id)
                                    })
                                })
                                .unwrap_or(false);
                        if !any {
                            return false;
                        }
                    }
                }
                if let Some(subs) = req.subcategory_ids.as_deref() {
                    if !subs.is_empty() {
                        let any = asgs
                            .map(|v| {
                                v.iter().any(|asg| {
                                    expected_taxonomy == Some(asg.taxonomy_id.as_str())
                                        && subs.iter().any(|c| c == &asg.category_id)
                                })
                            })
                            .unwrap_or(false)
                            || activity_splits
                                .map(|v| {
                                    v.iter().any(|split| {
                                        expected_taxonomy == Some(split.taxonomy_id.as_str())
                                            && subs.iter().any(|c| c == &split.category_id)
                                    })
                                })
                                .unwrap_or(false);
                        if !any {
                            return false;
                        }
                    }
                }

                true
            });
        }

        // Sort
        match req.sort_by {
            CashActivitySortField::Date => match req.sort_dir {
                SortDirection::Desc => {
                    activities.sort_by_key(|a| std::cmp::Reverse(a.activity_date))
                }
                SortDirection::Asc => activities.sort_by_key(|a| a.activity_date),
            },
            CashActivitySortField::Amount => {
                activities.sort_by(|a, b| {
                    let av = a.amount.map(|d| d.abs()).unwrap_or_default();
                    let bv = b.amount.map(|d| d.abs()).unwrap_or_default();
                    match req.sort_dir {
                        SortDirection::Desc => bv.cmp(&av),
                        SortDirection::Asc => av.cmp(&bv),
                    }
                });
            }
        }

        let total_count = activities.len();

        // Net balance over the FULL filtered set — computed before pagination so
        // it covers every matching row, not just the returned page. Only the
        // first page carries it: page 1 is refetched on every filter change, so
        // later pages can skip the recomputation.
        // When every matching row shares a currency, total in that currency and
        // skip FX entirely — a single-currency account then reads exactly, with
        // none of the per-activity-rate drift that converting would introduce.
        // Only a genuinely mixed set falls back to the base currency.
        let filtered_balance = (req.offset == 0 && !base_currency.is_empty()).then(|| {
            match self.sole_currency(&activities, &account_types) {
                Some(currency) => FilteredBalance {
                    amount: decimal_to_f64(
                        activities
                            .iter()
                            .map(|a| self.native_cash_movement(a, &account_types))
                            .sum(),
                    ),
                    currency: currency.to_string(),
                    converted: false,
                },
                None => FilteredBalance {
                    amount: decimal_to_f64(
                        activities
                            .iter()
                            .map(|a| self.converted_cash_movement(a, &account_types, base_currency))
                            .sum(),
                    ),
                    currency: base_currency.to_string(),
                    converted: true,
                },
            }
        });

        // Paginate
        let offset = req.offset.min(total_count);
        let limit = req.limit.min(MAX_CASH_ACTIVITY_SEARCH_LIMIT);
        let end = offset.saturating_add(limit).min(total_count);
        let page: Vec<Activity> = activities.drain(offset..end).collect();
        // Drop the rest — we no longer need them.
        drop(activities);

        // Batch-fetch assignments + event tags for the paginated slice.
        // (Always — clients use both for display.)
        let page_ids: Vec<String> = page.iter().map(|a| a.id.clone()).collect();
        let asgs = self.assignments.list_for_activities(&page_ids).await?;
        let mut by_activity = group_assignments_owned(asgs);
        let splits = self.splits.list_for_activities(&page_ids).await?;
        let mut splits_by_activity = group_splits_owned(splits);
        let mut tag_map = self.activity_events.list_for_activities(&page_ids).await?;

        let items: Vec<CashActivity> = page
            .into_iter()
            .map(|a| {
                let assignments = by_activity.remove(&a.id).unwrap_or_default();
                let splits = splits_by_activity.remove(&a.id).unwrap_or_default();
                let event_id = tag_map.remove(&a.id);
                let cash_flow_bucket = cash_flow_bucket_for(&a, &account_types, &transfer_groups);
                let transfer_link_status = transfer_link_status_for(&a, &transfer_link_resolution);
                let cash_movement = (!base_currency.is_empty()).then(|| {
                    decimal_to_f64(self.converted_cash_movement(&a, &account_types, base_currency))
                });
                let cash_movement_native = (!base_currency.is_empty())
                    .then(|| decimal_to_f64(self.native_cash_movement(&a, &account_types)));
                CashActivity {
                    activity: a,
                    cash_flow_bucket,
                    assignments,
                    splits,
                    event_id,
                    transfer_link_status,
                    cash_movement,
                    cash_movement_native,
                }
            })
            .collect();

        Ok(CashActivitySearchResponse {
            items,
            total_count,
            filtered_balance,
        })
    }

    /// Signed cash movement of one activity in its OWN currency: positive when
    /// money entered the account, negative when it left.
    ///
    /// The sign and magnitude come from `ActivityEconomicsResolver`, the same
    /// resolver the holdings engine uses to build account cash balances, so this
    /// total reconciles with the account page by construction rather than by a
    /// parallel sign table. That also handles the cases a hand-rolled mapping
    /// gets wrong: credit-card interest is a charge, and a security-transfer leg
    /// moves only its fee.
    ///
    /// Non-POSTED rows contribute nothing — they are visible in this list but
    /// excluded from balances, so counting them here would disagree with the
    /// account page.
    ///
    /// Unlike the spending buckets, transfers count by direction instead of
    /// washing out: a Transfer-In filter totals inflow.
    fn native_cash_movement(
        &self,
        activity: &Activity,
        account_types: &HashMap<String, String>,
    ) -> Decimal {
        if !activity.is_posted() {
            return Decimal::ZERO;
        }
        let is_credit_card = account_types
            .get(&activity.account_id)
            .is_some_and(|account_type| account_type == account_types::CREDIT_CARD);
        ActivityEconomicsResolver::resolve_cash_with_account_context(
            activity,
            Decimal::ONE,
            is_credit_card,
        )
        .signed_cash_effect
        .unwrap_or(Decimal::ZERO)
    }

    /// `native_cash_movement` converted into `target`. The conversion is applied
    /// to the *signed* effect, not to `|amount|`, because those two differ for
    /// security transfers. Falls back to the native amount when no rate is
    /// available, so a missing rate understates rather than drops a row.
    fn converted_cash_movement(
        &self,
        activity: &Activity,
        account_types: &HashMap<String, String>,
        target: &str,
    ) -> Decimal {
        let native = self.native_cash_movement(activity, account_types);
        fx_to_target(
            self.fx.as_ref(),
            native,
            &activity.currency,
            target,
            activity.activity_date.date_naive(),
        )
        .unwrap_or(native)
    }

    /// The one currency shared by every row that actually moves cash, if there
    /// is one.
    ///
    /// Rows contributing nothing (not posted, or no cash effect) are ignored:
    /// they cannot change the total, so letting them force an FX conversion
    /// would lose precision for no reason. `None` means the set spans several
    /// currencies and has to be converted to the base currency.
    fn sole_currency<'a>(
        &self,
        activities: &'a [Activity],
        account_types: &HashMap<String, String>,
    ) -> Option<&'a str> {
        let mut sole: Option<&str> = None;
        for activity in activities {
            if self.native_cash_movement(activity, account_types) == Decimal::ZERO {
                continue;
            }
            match sole {
                None => sole = Some(&activity.currency),
                Some(seen) if seen == activity.currency => {}
                Some(_) => return None,
            }
        }
        sole
    }

    /// Fetch explicit activity ids without applying the normal status/date/limit
    /// search filters. Still respects the user's spending account opt-in.
    pub async fn get_by_activity_ids(&self, activity_ids: &[String]) -> Result<Vec<CashActivity>> {
        if activity_ids.is_empty() {
            return Ok(Vec::new());
        }
        let s = self.settings.get().await?;
        if !s.enabled || s.account_ids.is_empty() {
            return Ok(Vec::new());
        }

        let (target_accounts, account_types) =
            self.resolve_target_accounts(None, &s.account_ids)?;
        if target_accounts.is_empty() {
            return Ok(Vec::new());
        }

        let allowed_accounts: HashSet<&str> = target_accounts.iter().map(String::as_str).collect();
        let context_activities = self
            .activity_repo
            .get_activities_by_account_ids(&target_accounts)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let transfer_link_resolution = self.transfer_link_resolution()?;
        let transfer_context_acts: Vec<&Activity> = context_activities.iter().collect();
        let transfer_groups = within_spending_transfer_groups(&transfer_context_acts);
        let requested_ids: HashSet<&str> = activity_ids.iter().map(String::as_str).collect();
        let mut activities = context_activities
            .into_iter()
            .filter(|activity| requested_ids.contains(activity.id.as_str()))
            .filter(|activity| allowed_accounts.contains(activity.account_id.as_str()))
            .collect::<Vec<_>>();
        retain_classified_cash_activities(&mut activities, &account_types);

        let ids: Vec<String> = activities.iter().map(|a| a.id.clone()).collect();
        let asgs = self.assignments.list_for_activities(&ids).await?;
        let mut by_activity = group_assignments_owned(asgs);
        let splits = self.splits.list_for_activities(&ids).await?;
        let mut splits_by_activity = group_splits_owned(splits);
        let mut tag_map = self.activity_events.list_for_activities(&ids).await?;
        Ok(activities
            .into_iter()
            .map(|activity| {
                let assignments = by_activity.remove(&activity.id).unwrap_or_default();
                let splits = splits_by_activity.remove(&activity.id).unwrap_or_default();
                let event_id = tag_map.remove(&activity.id);
                let cash_flow_bucket =
                    cash_flow_bucket_for(&activity, &account_types, &transfer_groups);
                let transfer_link_status =
                    transfer_link_status_for(&activity, &transfer_link_resolution);
                CashActivity {
                    activity,
                    cash_flow_bucket,
                    assignments,
                    splits,
                    event_id,
                    transfer_link_status,
                    cash_movement: None,
                    cash_movement_native: None,
                }
            })
            .collect())
    }

    pub async fn list_assignments(
        &self,
        activity_id: &str,
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        self.ensure_activity_in_spending_scope(activity_id).await?;
        self.assignments.list_for_activity(activity_id).await
    }

    pub async fn assign_category(
        &self,
        activity_id: &str,
        taxonomy_id: &str,
        category_id: &str,
    ) -> Result<ActivityTaxonomyAssignment> {
        self.ensure_activity_assignment_allowed(activity_id, taxonomy_id, true)
            .await?;
        self.assignments
            .assign_single_clearing_splits(activity_id, taxonomy_id, category_id)
            .await
    }

    pub async fn unassign_category(&self, activity_id: &str, taxonomy_id: &str) -> Result<()> {
        self.ensure_activity_assignment_allowed(activity_id, taxonomy_id, false)
            .await?;
        self.assignments.unassign(activity_id, taxonomy_id).await
    }

    pub async fn bulk_assign_categories(
        &self,
        items: &[BulkCategoryAssignment],
    ) -> Result<Vec<ActivityTaxonomyAssignment>> {
        for item in items {
            self.ensure_activity_assignment_allowed(&item.activity_id, &item.taxonomy_id, true)
                .await?;
        }
        self.assignments
            .assign_many_single_select_clearing_splits(items)
            .await
    }

    pub async fn list_splits(&self, activity_id: &str) -> Result<Vec<ActivitySplit>> {
        self.ensure_activity_in_spending_scope(activity_id).await?;
        self.splits.list_for_activity(activity_id).await
    }

    pub async fn replace_splits(
        &self,
        activity_id: &str,
        splits: Vec<NewActivitySplit>,
    ) -> Result<Vec<ActivitySplit>> {
        let (activity, expected_taxonomy) = self.ensure_activity_split_allowed(activity_id).await?;
        if splits.is_empty() {
            return Err(SpendingError::InvalidInput {
                message: "Split transactions require at least one line".to_string(),
            }
            .into());
        }

        let mut sum = Decimal::ZERO;
        let mut category_ids = Vec::with_capacity(splits.len());
        for split in &splits {
            if split.taxonomy_id != expected_taxonomy {
                return Err(SpendingError::InvalidInput {
                    message: "Split line taxonomy must match the activity cash-flow bucket"
                        .to_string(),
                }
                .into());
            }
            if split.amount <= Decimal::ZERO {
                return Err(SpendingError::InvalidInput {
                    message: "Split line amounts must be positive".to_string(),
                }
                .into());
            }
            category_ids.push(split.category_id.clone());
            sum += split.amount;
        }

        if !self
            .splits
            .categories_belong_to_taxonomy(expected_taxonomy, &category_ids)
            .await?
        {
            return Err(SpendingError::InvalidInput {
                message: "Split line categories must belong to the activity cash-flow taxonomy"
                    .to_string(),
            }
            .into());
        }

        let expected_total = activity_abs_amount(&activity);
        if sum != expected_total {
            return Err(SpendingError::InvalidInput {
                message: format!(
                    "Split line total must equal the transaction amount ({})",
                    expected_total
                ),
            }
            .into());
        }

        self.splits
            .replace_for_activity_clearing_assignment(activity_id, expected_taxonomy, splits)
            .await
    }

    pub async fn clear_splits(&self, activity_id: &str) -> Result<()> {
        self.ensure_activity_in_spending_scope(activity_id).await?;
        self.splits.clear_for_activity(activity_id).await
    }

    /// Set or clear the spending-event tag on an activity. Pass `None` to clear.
    /// Event date ranges describe reporting periods; they do not restrict
    /// manual tagging. This allows pre-event spending like flights or deposits
    /// to stay attached to the event they belong to.
    ///
    /// **Return contract**: returns the underlying `Activity` row, which does
    /// **not** carry the new tag — `event_id` lives on the `activity_events`
    /// join table, not on the activity row itself. Callers that need to read
    /// the post-write tag back must round-trip through `search()` / `list()`
    /// (which JOIN the tag in via `CashActivity`). The existing frontend
    /// caller (`useCashActivities`) discards this return value and refetches
    /// via the spending caches, which is the intended pattern.
    pub async fn set_event(&self, activity_id: &str, event_id: Option<String>) -> Result<Activity> {
        let activity = self.ensure_activity_in_spending_scope(activity_id).await?;
        if let Some(ref event_id) = event_id {
            self.events
                .get_event(event_id)
                .await?
                .ok_or_else(|| SpendingError::NotFound {
                    entity: "Spending event",
                    id: event_id.clone(),
                })?;
        }
        self.activity_events
            .set_activity_event_tag(activity_id, event_id)
            .await?;
        Ok(activity)
    }

    fn resolve_target_accounts(
        &self,
        requested: Option<Vec<String>>,
        opted_in: &[String],
    ) -> Result<(Vec<String>, HashMap<String, String>)> {
        let target_accounts: Vec<String> = match requested {
            Some(ids) => ids.into_iter().filter(|id| opted_in.contains(id)).collect(),
            None => opted_in.to_vec(),
        };
        if target_accounts.is_empty() {
            return Ok((target_accounts, HashMap::new()));
        }

        let accounts = self
            .account_repo
            .list(None, Some(false), Some(&target_accounts))
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let account_types: HashMap<String, String> = accounts
            .into_iter()
            .filter(|account| {
                account_supports_purpose(&account.account_type, AccountPurpose::Spending)
            })
            .map(|account| (account.id, account.account_type))
            .collect();

        let target_accounts = target_accounts
            .into_iter()
            .filter(|id| account_types.contains_key(id))
            .collect();

        Ok((target_accounts, account_types))
    }

    fn transfer_link_resolution(&self) -> Result<TransferPairResolution> {
        let activities = self
            .activity_repo
            .get_activities()
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        Ok(TransferPairResolution::from_activities(&activities))
    }

    async fn ensure_activity_assignment_allowed(
        &self,
        activity_id: &str,
        taxonomy_id: &str,
        enforce_bucket: bool,
    ) -> Result<Activity> {
        if taxonomy_id != SPENDING_TAXONOMY
            && taxonomy_id != INCOME_TAXONOMY
            && taxonomy_id != SAVINGS_TAXONOMY
        {
            return Err(SpendingError::InvalidInput {
                message: "Taxonomy is not assignable to spending activities".to_string(),
            }
            .into());
        }
        let activity = self.ensure_activity_in_spending_scope(activity_id).await?;
        if !enforce_bucket {
            return Ok(activity);
        }

        let s = self.settings.get().await?;
        let (target_accounts, account_types) =
            self.resolve_target_accounts(None, &s.account_ids)?;
        let Some(account_type) = account_types.get(&activity.account_id) else {
            return Err(SpendingError::InvalidInput {
                message: "Activity account does not support spending tracking".to_string(),
            }
            .into());
        };
        let context_activities = self
            .activity_repo
            .get_activities_by_account_ids(&target_accounts)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let transfer_context_acts: Vec<&Activity> = context_activities.iter().collect();
        let transfer_groups = within_spending_transfer_groups(&transfer_context_acts);
        let bucket = cash_flow_bucket_from_classification(classify_activity_for_aggregation(
            &activity,
            account_type,
            &transfer_groups,
        ));
        let Some(expected_taxonomy) = taxonomy_for_bucket(bucket) else {
            return Err(SpendingError::InvalidInput {
                message: "Neutral transfers cannot be categorized. Change or unlink the transfer if it should count as spending.".to_string(),
            }
            .into());
        };
        if expected_taxonomy != taxonomy_id {
            return Err(SpendingError::InvalidInput {
                message: format!(
                    "{} activities can only use {} categories. Categories label the cash-flow bucket; they do not change it.",
                    bucket.label(),
                    bucket.taxonomy_label(),
                ),
            }
            .into());
        }

        Ok(activity)
    }

    async fn ensure_activity_split_allowed(
        &self,
        activity_id: &str,
    ) -> Result<(Activity, &'static str)> {
        let activity = self.ensure_activity_in_spending_scope(activity_id).await?;
        let s = self.settings.get().await?;
        let (target_accounts, account_types) =
            self.resolve_target_accounts(None, &s.account_ids)?;
        let Some(account_type) = account_types.get(&activity.account_id) else {
            return Err(SpendingError::InvalidInput {
                message: "Activity account does not support spending tracking".to_string(),
            }
            .into());
        };
        let context_activities = self
            .activity_repo
            .get_activities_by_account_ids(&target_accounts)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let transfer_context_acts: Vec<&Activity> = context_activities.iter().collect();
        let transfer_groups = within_spending_transfer_groups(&transfer_context_acts);
        let bucket = cash_flow_bucket_from_classification(classify_activity_for_aggregation(
            &activity,
            account_type,
            &transfer_groups,
        ));
        let Some(expected_taxonomy) = taxonomy_for_bucket(bucket) else {
            return Err(SpendingError::InvalidInput {
                message: "Neutral transfers cannot be split. Change or unlink the transfer if it should count as spending.".to_string(),
            }
            .into());
        };
        if activity_abs_amount(&activity) <= Decimal::ZERO {
            return Err(SpendingError::InvalidInput {
                message: "Split transactions require a non-zero activity amount".to_string(),
            }
            .into());
        }
        Ok((activity, expected_taxonomy))
    }

    async fn ensure_activity_in_spending_scope(&self, activity_id: &str) -> Result<Activity> {
        let s = self.settings.get().await?;
        if !s.enabled {
            return Err(SpendingError::InvalidInput {
                message: "Spending tracking is disabled".to_string(),
            }
            .into());
        }

        let activity = self
            .activity_repo
            .get_activity(activity_id)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        if !s.account_ids.iter().any(|id| id == &activity.account_id) {
            return Err(SpendingError::InvalidInput {
                message: "Activity account is not opted into spending tracking".to_string(),
            }
            .into());
        }

        let account = self
            .account_repo
            .get_by_id(&activity.account_id)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        if account.is_archived
            || !account_supports_purpose(&account.account_type, AccountPurpose::Spending)
        {
            return Err(SpendingError::InvalidInput {
                message: "Activity account does not support spending tracking".to_string(),
            }
            .into());
        }

        Ok(activity)
    }
}

fn retain_classified_cash_activities(
    activities: &mut Vec<Activity>,
    account_types: &HashMap<String, String>,
) {
    activities.retain(|activity| {
        account_types
            .get(&activity.account_id)
            .is_some_and(|account_type| is_visible_cash_activity(activity, account_type))
    });
}

fn cash_flow_bucket_for(
    activity: &Activity,
    account_types: &HashMap<String, String>,
    transfer_groups: &HashSet<String>,
) -> CashFlowBucket {
    account_types
        .get(&activity.account_id)
        .map(|account_type| {
            cash_flow_bucket_from_classification(classify_activity_for_aggregation(
                activity,
                account_type,
                transfer_groups,
            ))
        })
        .unwrap_or(CashFlowBucket::Neutral)
}

fn cash_flow_bucket_from_classification(classification: SpendingClassification) -> CashFlowBucket {
    match classification {
        SpendingClassification::Income => CashFlowBucket::Income,
        SpendingClassification::Expense | SpendingClassification::ExpenseRefund => {
            CashFlowBucket::Spending
        }
        SpendingClassification::Saving => CashFlowBucket::Saving,
        SpendingClassification::InternalTransfer | SpendingClassification::Ignored => {
            CashFlowBucket::Neutral
        }
    }
}

fn taxonomy_for_bucket(bucket: CashFlowBucket) -> Option<&'static str> {
    match bucket {
        CashFlowBucket::Spending => Some(SPENDING_TAXONOMY),
        CashFlowBucket::Income => Some(INCOME_TAXONOMY),
        CashFlowBucket::Saving => Some(SAVINGS_TAXONOMY),
        CashFlowBucket::Neutral => None,
    }
}

fn transfer_link_status_for(
    activity: &Activity,
    resolution: &TransferPairResolution,
) -> Option<TransferLinkStatus> {
    if !matches!(
        activity.effective_type(),
        ACTIVITY_TYPE_TRANSFER_IN | ACTIVITY_TYPE_TRANSFER_OUT
    ) {
        return None;
    }
    if resolution.pair_for_activity(&activity.id).is_some() {
        return Some(TransferLinkStatus::Linked);
    }
    if activity
        .source_group_id
        .as_deref()
        .map(str::trim)
        .is_some_and(|group_id| !group_id.is_empty())
    {
        return Some(TransferLinkStatus::Invalid);
    }
    Some(TransferLinkStatus::Unlinked)
}

impl CashFlowBucket {
    fn label(self) -> &'static str {
        match self {
            CashFlowBucket::Spending => "Spending",
            CashFlowBucket::Income => "Income",
            CashFlowBucket::Saving => "Saving",
            CashFlowBucket::Neutral => "Neutral",
        }
    }

    fn taxonomy_label(self) -> &'static str {
        match self {
            CashFlowBucket::Spending => "spending",
            CashFlowBucket::Income => "income",
            CashFlowBucket::Saving => "savings",
            CashFlowBucket::Neutral => "no",
        }
    }
}

fn is_visible_cash_activity(activity: &Activity, account_type: &str) -> bool {
    matches!(
        classify_activity(activity, account_type),
        SpendingClassification::Income
            | SpendingClassification::Expense
            | SpendingClassification::ExpenseRefund
    ) || is_neutral_visible_cash_activity(activity, account_type)
}

fn is_neutral_visible_cash_activity(activity: &Activity, account_type: &str) -> bool {
    let activity_type = activity.effective_type();
    // Credit-card payment received (incoming transfer to the card).
    if account_type == account_types::CREDIT_CARD && activity_type == "TRANSFER_IN" {
        return true;
    }
    // Linked transfers touching a cash account — savings moves to investing
    // accounts and internal moves between cash accounts. Always shown in the
    // ledger (we never hide an account's transactions); the totals layer
    // decides saving vs neutral via classify_activity_for_aggregation.
    account_type == account_types::CASH
        && matches!(activity_type, "TRANSFER_IN" | "TRANSFER_OUT")
        && activity.source_group_id.is_some()
}

fn group_assignments(
    assignments: &[ActivityTaxonomyAssignment],
) -> HashMap<&str, Vec<&ActivityTaxonomyAssignment>> {
    let mut map: HashMap<&str, Vec<&ActivityTaxonomyAssignment>> = HashMap::new();
    for a in assignments {
        map.entry(a.activity_id.as_str()).or_default().push(a);
    }
    map
}

fn group_splits(splits: &[ActivitySplit]) -> HashMap<&str, Vec<&ActivitySplit>> {
    let mut map: HashMap<&str, Vec<&ActivitySplit>> = HashMap::new();
    for split in splits {
        map.entry(split.activity_id.as_str())
            .or_default()
            .push(split);
    }
    map
}

fn retain_by_date_range(
    activities: &mut Vec<Activity>,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> Result<()> {
    let start = parse_filter_datetime(start_date)?;
    let end = parse_filter_datetime(end_date)?;

    if start.is_some() || end.is_some() {
        activities
            .retain(|a| activity_date_in_range(&a.activity_date, start.as_ref(), end.as_ref()));
    }

    Ok(())
}

fn parse_filter_datetime(value: Option<&str>) -> Result<Option<DateTime<Utc>>> {
    value
        .map(|value| DateTime::parse_from_rfc3339(value).map(|date| date.with_timezone(&Utc)))
        .transpose()
        .map_err(Into::into)
}

fn activity_date_in_range(
    activity_date: &DateTime<Utc>,
    start: Option<&DateTime<Utc>>,
    end: Option<&DateTime<Utc>>,
) -> bool {
    start.is_none_or(|start| activity_date >= start) && end.is_none_or(|end| activity_date <= end)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use chrono::NaiveDateTime;
    use rust_decimal::Decimal;
    use wealthfolio_core::accounts::{
        Account, AccountRepositoryTrait, AccountUpdate, NewAccount, TrackingMode,
    };
    use wealthfolio_core::activities::{
        ActivityBulkMutationResult, ActivitySearchResponse, ActivityStatus, ActivityUpdate,
        ActivityUpsert, BulkUpsertResult, ImportMapping, ImportTemplate, IncomeData, NewActivity,
        Sort,
    };
    use wealthfolio_core::limits::ContributionActivity;

    use super::*;
    use crate::activity_assignments::NewActivityTaxonomyAssignment;
    use crate::events::{Event, EventType, NewEvent, NewEventType, UpdateEvent};
    use crate::settings::{
        SpendingSettingsRepositoryTrait, SETTING_KEY_ACCOUNT_IDS, SETTING_KEY_ENABLED,
    };

    fn now_naive() -> NaiveDateTime {
        Utc::now().naive_utc()
    }

    fn activity(activity_type: &str) -> Activity {
        Activity {
            id: "activity-1".to_string(),
            account_id: "account-1".to_string(),
            asset_id: None,
            activity_type: activity_type.to_string(),
            activity_type_override: None,
            source_type: None,
            subtype: None,
            status: ActivityStatus::Posted,
            activity_date: Utc::now(),
            settlement_date: None,
            quantity: None,
            unit_price: None,
            amount: Some(Decimal::new(100, 0)),
            fee: None,
            tax: None,
            currency: "USD".to_string(),
            fx_rate: None,
            notes: None,
            metadata: None,
            source_system: None,
            source_record_id: None,
            source_group_id: None,
            idempotency_key: None,
            import_run_id: None,
            is_user_modified: false,
            needs_review: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    /// FX stub that multiplies cross-currency conversions by a fixed rate.
    /// `passthrough_fx()` (rate 1) returns amounts unchanged. Local to this
    /// module (the analytics tests' PassthroughFx is `pub(super)` there).
    struct MockFx {
        rate: Decimal,
    }

    fn passthrough_fx() -> Arc<MockFx> {
        Arc::new(MockFx { rate: Decimal::ONE })
    }

    fn fixed_rate_fx(rate: Decimal) -> Arc<MockFx> {
        Arc::new(MockFx { rate })
    }

    #[async_trait]
    impl wealthfolio_core::fx::FxServiceTrait for MockFx {
        fn initialize(&self) -> wealthfolio_core::Result<()> {
            Ok(())
        }
        fn get_historical_rates(
            &self,
            _: &str,
            _: &str,
            _: i64,
        ) -> wealthfolio_core::Result<Vec<wealthfolio_core::fx::ExchangeRate>> {
            Ok(vec![])
        }
        fn get_latest_exchange_rate(&self, _: &str, _: &str) -> wealthfolio_core::Result<Decimal> {
            Ok(Decimal::ONE)
        }
        fn get_exchange_rate_for_date(
            &self,
            _: &str,
            _: &str,
            _: chrono::NaiveDate,
        ) -> wealthfolio_core::Result<Decimal> {
            Ok(self.rate)
        }
        fn convert_currency(
            &self,
            amount: Decimal,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Decimal> {
            Ok(amount * self.rate)
        }
        fn convert_currency_for_date(
            &self,
            amount: Decimal,
            _: &str,
            _: &str,
            _: chrono::NaiveDate,
        ) -> wealthfolio_core::Result<Decimal> {
            Ok(amount * self.rate)
        }
        fn get_latest_exchange_rates(
            &self,
        ) -> wealthfolio_core::Result<Vec<wealthfolio_core::fx::ExchangeRate>> {
            Ok(vec![])
        }
        async fn add_exchange_rate(
            &self,
            _: wealthfolio_core::fx::NewExchangeRate,
        ) -> wealthfolio_core::Result<wealthfolio_core::fx::ExchangeRate> {
            unimplemented!("MockFx is read-only")
        }
        async fn update_exchange_rate(
            &self,
            _: &str,
            _: &str,
            _: Decimal,
        ) -> wealthfolio_core::Result<wealthfolio_core::fx::ExchangeRate> {
            unimplemented!("MockFx is read-only")
        }
        async fn delete_exchange_rate(&self, _: &str) -> wealthfolio_core::Result<()> {
            Ok(())
        }
        async fn register_currency_pair(&self, _: &str, _: &str) -> wealthfolio_core::Result<()> {
            Ok(())
        }
        async fn register_currency_pair_manual(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<()> {
            Ok(())
        }
        async fn ensure_fx_pairs(&self, _: Vec<(String, String)>) -> wealthfolio_core::Result<()> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct MockSettingsRepo;

    #[async_trait]
    impl SpendingSettingsRepositoryTrait for MockSettingsRepo {
        async fn get_setting(&self, key: &str) -> Result<Option<String>> {
            match key {
                SETTING_KEY_ENABLED => Ok(Some("true".to_string())),
                SETTING_KEY_ACCOUNT_IDS => Ok(Some(r#"["account-1"]"#.to_string())),
                _ => Ok(None),
            }
        }

        async fn set_setting(&self, _: &str, _: &str) -> Result<()> {
            unimplemented!()
        }

        async fn set_settings(&self, _: Vec<(String, String)>) -> Result<()> {
            unimplemented!()
        }
    }

    struct MockAccountRepo {
        account: Account,
    }

    #[async_trait]
    impl AccountRepositoryTrait for MockAccountRepo {
        async fn create(&self, _: NewAccount) -> wealthfolio_core::Result<Account> {
            unimplemented!()
        }

        async fn update(&self, _: AccountUpdate) -> wealthfolio_core::Result<Account> {
            unimplemented!()
        }

        async fn delete(&self, _: &str) -> wealthfolio_core::Result<usize> {
            unimplemented!()
        }

        fn get_by_id(&self, account_id: &str) -> wealthfolio_core::Result<Account> {
            if self.account.id == account_id {
                Ok(self.account.clone())
            } else {
                Err(wealthfolio_core::errors::Error::Validation(
                    wealthfolio_core::errors::ValidationError::InvalidInput("not found".into()),
                ))
            }
        }

        fn list(
            &self,
            is_active_filter: Option<bool>,
            is_archived_filter: Option<bool>,
            account_ids: Option<&[String]>,
        ) -> wealthfolio_core::Result<Vec<Account>> {
            let include = account_ids
                .map(|ids| ids.iter().any(|id| id == &self.account.id))
                .unwrap_or(true)
                && is_active_filter
                    .map(|active| active == self.account.is_active)
                    .unwrap_or(true)
                && is_archived_filter
                    .map(|archived| archived == self.account.is_archived)
                    .unwrap_or(true);
            Ok(if include {
                vec![self.account.clone()]
            } else {
                Vec::new()
            })
        }
    }

    struct MockActivityRepo {
        activities: Vec<Activity>,
    }

    #[async_trait]
    impl ActivityRepositoryTrait for MockActivityRepo {
        fn get_activity(&self, activity_id: &str) -> wealthfolio_core::Result<Activity> {
            self.activities
                .iter()
                .find(|activity| activity.id == activity_id)
                .cloned()
                .ok_or_else(|| {
                    wealthfolio_core::errors::Error::Validation(
                        wealthfolio_core::errors::ValidationError::InvalidInput(
                            "not found".to_string(),
                        ),
                    )
                })
        }

        fn find_transfer_counterpart(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Option<Activity>> {
            Ok(None)
        }

        fn get_activities(&self) -> wealthfolio_core::Result<Vec<Activity>> {
            Ok(self.activities.clone())
        }

        fn get_activities_by_account_id(
            &self,
            account_id: &str,
        ) -> wealthfolio_core::Result<Vec<Activity>> {
            Ok(self
                .activities
                .iter()
                .filter(|activity| activity.account_id == account_id)
                .cloned()
                .collect())
        }

        fn get_activities_by_account_ids(
            &self,
            account_ids: &[String],
        ) -> wealthfolio_core::Result<Vec<Activity>> {
            Ok(self
                .activities
                .iter()
                .filter(|activity| account_ids.iter().any(|id| id == &activity.account_id))
                .cloned()
                .collect())
        }

        fn get_trading_activities(&self) -> wealthfolio_core::Result<Vec<Activity>> {
            unimplemented!()
        }

        fn get_income_activities(&self) -> wealthfolio_core::Result<Vec<Activity>> {
            unimplemented!()
        }

        fn get_contribution_activities(
            &self,
            _: &[String],
            _: DateTime<Utc>,
            _: DateTime<Utc>,
        ) -> wealthfolio_core::Result<Vec<ContributionActivity>> {
            unimplemented!()
        }

        fn search_activities(
            &self,
            _: i64,
            _: i64,
            _: Option<Vec<String>>,
            _: Option<Vec<String>>,
            _: Option<String>,
            _: Option<Sort>,
            _: Option<bool>,
            _: Option<chrono::NaiveDate>,
            _: Option<chrono::NaiveDate>,
            _: Option<Vec<String>>,
            _: Option<Vec<String>>,
        ) -> wealthfolio_core::Result<ActivitySearchResponse> {
            unimplemented!()
        }

        async fn create_activity(&self, _: NewActivity) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }

        async fn update_activity(&self, _: ActivityUpdate) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }

        async fn delete_activity(&self, _: String) -> wealthfolio_core::Result<Activity> {
            unimplemented!()
        }

        async fn link_transfer_activities(
            &self,
            _: String,
            _: String,
        ) -> wealthfolio_core::Result<(Activity, Activity)> {
            unimplemented!()
        }

        async fn unlink_transfer_activities(
            &self,
            _: String,
            _: String,
        ) -> wealthfolio_core::Result<(Activity, Activity)> {
            unimplemented!()
        }

        async fn bulk_mutate_activities(
            &self,
            _: Vec<NewActivity>,
            _: Vec<ActivityUpdate>,
            _: Vec<String>,
        ) -> wealthfolio_core::Result<ActivityBulkMutationResult> {
            unimplemented!()
        }

        async fn create_activities(&self, _: Vec<NewActivity>) -> wealthfolio_core::Result<usize> {
            unimplemented!()
        }

        fn get_first_activity_date(
            &self,
            _: Option<&[String]>,
        ) -> wealthfolio_core::Result<Option<DateTime<Utc>>> {
            unimplemented!()
        }

        fn get_import_mapping(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Option<ImportMapping>> {
            unimplemented!()
        }

        async fn save_import_mapping(&self, _: &ImportMapping) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }

        async fn link_account_template(
            &self,
            _: &str,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }

        fn list_import_templates(&self) -> wealthfolio_core::Result<Vec<ImportTemplate>> {
            unimplemented!()
        }

        fn get_import_template(&self, _: &str) -> wealthfolio_core::Result<Option<ImportTemplate>> {
            unimplemented!()
        }

        async fn save_import_template(&self, _: &ImportTemplate) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }

        async fn delete_import_template(&self, _: &str) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }

        fn get_broker_sync_profile(
            &self,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<Option<ImportTemplate>> {
            unimplemented!()
        }

        async fn save_broker_sync_profile(
            &self,
            _: &ImportTemplate,
        ) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }

        async fn link_broker_sync_profile(
            &self,
            _: &str,
            _: &str,
            _: &str,
        ) -> wealthfolio_core::Result<()> {
            unimplemented!()
        }

        fn calculate_average_cost(&self, _: &str, _: &str) -> wealthfolio_core::Result<Decimal> {
            unimplemented!()
        }

        fn get_income_activities_data(
            &self,
            _: Option<&[String]>,
        ) -> wealthfolio_core::Result<Vec<IncomeData>> {
            unimplemented!()
        }

        fn get_first_activity_date_overall(&self) -> wealthfolio_core::Result<DateTime<Utc>> {
            unimplemented!()
        }

        fn get_activity_bounds_for_assets(
            &self,
            _: &[String],
        ) -> wealthfolio_core::Result<
            std::collections::HashMap<
                String,
                (Option<chrono::NaiveDate>, Option<chrono::NaiveDate>),
            >,
        > {
            unimplemented!()
        }

        fn get_holdings_snapshot_bounds_for_assets(
            &self,
            _: &[String],
        ) -> wealthfolio_core::Result<
            std::collections::HashMap<
                String,
                (Option<chrono::NaiveDate>, Option<chrono::NaiveDate>),
            >,
        > {
            unimplemented!()
        }

        fn check_existing_duplicates(
            &self,
            _: &[String],
        ) -> wealthfolio_core::Result<std::collections::HashMap<String, String>> {
            unimplemented!()
        }

        async fn bulk_upsert(
            &self,
            _: Vec<ActivityUpsert>,
        ) -> wealthfolio_core::Result<BulkUpsertResult> {
            unimplemented!()
        }

        async fn reassign_asset(&self, _: &str, _: &str) -> wealthfolio_core::Result<u32> {
            unimplemented!()
        }

        async fn get_activity_accounts_and_currencies_by_asset_id(
            &self,
            _: &str,
        ) -> wealthfolio_core::Result<(Vec<String>, Vec<String>)> {
            unimplemented!()
        }
    }

    #[derive(Default)]
    struct MockAssignmentRepo {
        cleared: Mutex<Vec<(String, String)>>,
    }

    #[async_trait]
    impl crate::activity_assignments::ActivityTaxonomyAssignmentRepositoryTrait for MockAssignmentRepo {
        async fn list_for_activity(&self, _: &str) -> Result<Vec<ActivityTaxonomyAssignment>> {
            Ok(Vec::new())
        }

        async fn list_for_activities(
            &self,
            _: &[String],
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            Ok(Vec::new())
        }

        async fn upsert(
            &self,
            _: NewActivityTaxonomyAssignment,
        ) -> Result<ActivityTaxonomyAssignment> {
            unimplemented!()
        }

        async fn assign_many_single_select(
            &self,
            _: Vec<NewActivityTaxonomyAssignment>,
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            unimplemented!()
        }

        async fn assign_many_single_select_clearing_splits(
            &self,
            _: Vec<NewActivityTaxonomyAssignment>,
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            unimplemented!()
        }

        async fn assign_rule_many_single_select(
            &self,
            _: Vec<NewActivityTaxonomyAssignment>,
            _: bool,
        ) -> Result<Vec<ActivityTaxonomyAssignment>> {
            unimplemented!()
        }

        async fn delete(&self, _: &str) -> Result<()> {
            unimplemented!()
        }

        async fn clear_for_taxonomy(&self, activity_id: &str, taxonomy_id: &str) -> Result<()> {
            self.cleared
                .lock()
                .unwrap()
                .push((activity_id.to_string(), taxonomy_id.to_string()));
            Ok(())
        }
    }

    #[derive(Default)]
    struct MockSplitRepo {
        replaced: Mutex<Vec<(String, Vec<NewActivitySplit>)>>,
        assignment_clears: Mutex<Vec<(String, String)>>,
        cleared: Mutex<Vec<String>>,
        categories_valid: Mutex<bool>,
    }

    #[async_trait]
    impl ActivitySplitRepositoryTrait for MockSplitRepo {
        async fn list_for_activity(&self, _: &str) -> Result<Vec<ActivitySplit>> {
            Ok(Vec::new())
        }

        async fn list_for_activities(&self, _: &[String]) -> Result<Vec<ActivitySplit>> {
            Ok(Vec::new())
        }

        async fn categories_belong_to_taxonomy(&self, _: &str, _: &[String]) -> Result<bool> {
            Ok(*self.categories_valid.lock().unwrap())
        }

        async fn replace_for_activity(
            &self,
            activity_id: &str,
            splits: Vec<NewActivitySplit>,
        ) -> Result<Vec<ActivitySplit>> {
            self.replaced
                .lock()
                .unwrap()
                .push((activity_id.to_string(), splits.clone()));
            Ok(splits
                .into_iter()
                .enumerate()
                .map(|(index, split)| ActivitySplit {
                    id: format!("split-{index}"),
                    activity_id: activity_id.to_string(),
                    taxonomy_id: split.taxonomy_id,
                    category_id: split.category_id,
                    amount: split.amount,
                    note: split.note,
                    sort_order: split.sort_order.unwrap_or(index as i32),
                    created_at: now_naive(),
                    updated_at: now_naive(),
                })
                .collect())
        }

        async fn replace_for_activity_clearing_assignment(
            &self,
            activity_id: &str,
            taxonomy_id: &str,
            splits: Vec<NewActivitySplit>,
        ) -> Result<Vec<ActivitySplit>> {
            self.assignment_clears
                .lock()
                .unwrap()
                .push((activity_id.to_string(), taxonomy_id.to_string()));
            self.replace_for_activity(activity_id, splits).await
        }

        async fn clear_for_activity(&self, activity_id: &str) -> Result<()> {
            self.cleared.lock().unwrap().push(activity_id.to_string());
            Ok(())
        }
    }

    #[derive(Default)]
    struct MockActivityEventsRepo;

    #[async_trait]
    impl crate::activity_events::ActivityEventsRepositoryTrait for MockActivityEventsRepo {
        async fn list_for_activities(
            &self,
            _: &[String],
        ) -> Result<std::collections::HashMap<String, String>> {
            Ok(std::collections::HashMap::new())
        }

        async fn list_for_event(&self, _: &str) -> Result<Vec<String>> {
            Ok(Vec::new())
        }

        async fn set_activity_event_tag(&self, _: &str, _: Option<String>) -> Result<()> {
            Ok(())
        }

        async fn delete_by_event(&self, _: &str) -> Result<usize> {
            Ok(0)
        }

        async fn list_all(&self) -> Result<Vec<crate::activity_events::ActivityEvent>> {
            Ok(Vec::new())
        }
    }

    #[derive(Default)]
    struct MockEventTypesRepo;

    #[async_trait]
    impl crate::events::EventTypesRepositoryTrait for MockEventTypesRepo {
        async fn list(&self) -> Result<Vec<EventType>> {
            Ok(Vec::new())
        }

        async fn create(&self, _: NewEventType) -> Result<EventType> {
            unimplemented!()
        }

        async fn update(
            &self,
            _: &str,
            _: Option<String>,
            _: Option<Option<String>>,
        ) -> Result<EventType> {
            unimplemented!()
        }

        async fn delete(&self, _: &str) -> Result<()> {
            unimplemented!()
        }
    }

    #[derive(Default)]
    struct MockEventsRepo;

    #[async_trait]
    impl crate::events::EventsRepositoryTrait for MockEventsRepo {
        async fn list(&self) -> Result<Vec<Event>> {
            Ok(Vec::new())
        }

        async fn get(&self, _: &str) -> Result<Option<Event>> {
            Ok(None)
        }

        async fn create(&self, _: NewEvent) -> Result<Event> {
            unimplemented!()
        }

        async fn update(&self, _: &str, _: UpdateEvent) -> Result<Event> {
            unimplemented!()
        }

        async fn delete(&self, _: &str) -> Result<()> {
            unimplemented!()
        }

        async fn count_by_type(&self, _: &str) -> Result<usize> {
            Ok(0)
        }
    }

    fn account(account_type: &str) -> Account {
        Account {
            id: "account-1".to_string(),
            name: "Checking".to_string(),
            account_type: account_type.to_string(),
            group: None,
            currency: "USD".to_string(),
            is_default: false,
            is_active: true,
            created_at: now_naive(),
            updated_at: now_naive(),
            platform_id: None,
            account_number: None,
            meta: None,
            provider: None,
            provider_account_id: None,
            is_archived: false,
            tracking_mode: TrackingMode::Transactions,
        }
    }

    fn split(category_id: &str, amount: i64, taxonomy_id: &str) -> NewActivitySplit {
        NewActivitySplit {
            taxonomy_id: taxonomy_id.to_string(),
            category_id: category_id.to_string(),
            amount: Decimal::new(amount, 0),
            note: None,
            sort_order: None,
        }
    }

    fn make_service(
        activity: Activity,
    ) -> (
        CashActivityService,
        Arc<MockAssignmentRepo>,
        Arc<MockSplitRepo>,
    ) {
        let activity_repo = Arc::new(MockActivityRepo {
            activities: vec![activity],
        });
        let account_repo = Arc::new(MockAccountRepo {
            account: account(account_types::CASH),
        });
        let settings = Arc::new(SpendingSettingsService::new(Arc::new(MockSettingsRepo)));
        let assignment_repo = Arc::new(MockAssignmentRepo::default());
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(
            assignment_repo.clone()
                as Arc<dyn crate::activity_assignments::ActivityTaxonomyAssignmentRepositoryTrait>,
        ));
        let split_repo = Arc::new(MockSplitRepo::default());
        *split_repo.categories_valid.lock().unwrap() = true;
        let activity_events = Arc::new(MockActivityEventsRepo);
        let events = Arc::new(EventsService::new(
            Arc::new(MockEventTypesRepo),
            Arc::new(MockEventsRepo),
            activity_repo.clone() as Arc<dyn ActivityRepositoryTrait>,
            activity_events.clone(),
        ));
        let service = CashActivityService::new(
            activity_repo as Arc<dyn ActivityRepositoryTrait>,
            account_repo,
            settings,
            assignment_service,
            split_repo.clone(),
            activity_events,
            events,
            passthrough_fx(),
        );
        (service, assignment_repo, split_repo)
    }

    /// Service over an arbitrary activity set, for the search tests. Every
    /// activity lives on the single CASH account the mocks expose.
    fn make_search_service(
        activities: Vec<Activity>,
        fx: Arc<MockFx>,
        account_type: &str,
    ) -> CashActivityService {
        let activity_repo = Arc::new(MockActivityRepo { activities });
        let account_repo = Arc::new(MockAccountRepo {
            account: account(account_type),
        });
        let settings = Arc::new(SpendingSettingsService::new(Arc::new(MockSettingsRepo)));
        let assignment_service = Arc::new(ActivityTaxonomyAssignmentService::new(Arc::new(
            MockAssignmentRepo::default(),
        )
            as Arc<dyn crate::activity_assignments::ActivityTaxonomyAssignmentRepositoryTrait>));
        let split_repo = Arc::new(MockSplitRepo::default());
        let activity_events = Arc::new(MockActivityEventsRepo);
        let events = Arc::new(EventsService::new(
            Arc::new(MockEventTypesRepo),
            Arc::new(MockEventsRepo),
            activity_repo.clone() as Arc<dyn ActivityRepositoryTrait>,
            activity_events.clone(),
        ));
        CashActivityService::new(
            activity_repo as Arc<dyn ActivityRepositoryTrait>,
            account_repo,
            settings,
            assignment_service,
            split_repo,
            activity_events,
            events,
            fx,
        )
    }

    /// `activity()` with a distinct id, so a set of them survives the search
    /// pipeline as separate rows.
    fn search_activity(id: &str, activity_type: &str, amount: i64) -> Activity {
        let mut a = activity(activity_type);
        a.id = id.to_string();
        a.amount = Some(Decimal::new(amount, 0));
        a
    }

    fn search_request() -> CashActivitySearchRequest {
        CashActivitySearchRequest {
            limit: 50,
            ..Default::default()
        }
    }

    #[test]
    fn activity_date_filter_compares_instants_not_rfc3339_strings() {
        let activity_date = DateTime::parse_from_rfc3339("2024-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let same_start = parse_filter_datetime(Some("2024-01-01T00:00:00.000Z"))
            .unwrap()
            .unwrap();
        let same_end = parse_filter_datetime(Some("2024-01-01T00:00:00.000Z"))
            .unwrap()
            .unwrap();
        let after_end = DateTime::parse_from_rfc3339("2024-01-01T00:00:01Z")
            .unwrap()
            .with_timezone(&Utc);

        assert!(activity_date_in_range(
            &activity_date,
            Some(&same_start),
            Some(&same_end)
        ));
        assert!(!activity_date_in_range(&after_end, None, Some(&same_end)));
    }

    #[test]
    fn credit_card_payment_is_visible_as_neutral_cash_activity() {
        let mut linked_payment = activity("TRANSFER_IN");
        linked_payment.source_group_id = Some("payment-group".to_string());

        assert!(is_visible_cash_activity(
            &linked_payment,
            account_types::CREDIT_CARD
        ));
        assert!(is_visible_cash_activity(
            &activity("TRANSFER_IN"),
            account_types::CREDIT_CARD
        ));
        assert!(!is_visible_cash_activity(
            &activity("DEPOSIT"),
            account_types::CREDIT_CARD
        ));
    }

    #[tokio::test]
    async fn replace_splits_accepts_exact_total_and_clears_single_assignment() {
        let (service, assignment_repo, split_repo) = make_service(activity("WITHDRAWAL"));

        let splits = service
            .replace_splits(
                "activity-1",
                vec![
                    split("groceries", 80, SPENDING_TAXONOMY),
                    split("household", 20, SPENDING_TAXONOMY),
                ],
            )
            .await
            .unwrap();

        assert_eq!(splits.len(), 2);
        assert!(assignment_repo.cleared.lock().unwrap().is_empty());
        assert_eq!(
            split_repo.assignment_clears.lock().unwrap().as_slice(),
            &[("activity-1".to_string(), SPENDING_TAXONOMY.to_string())]
        );
        assert_eq!(split_repo.replaced.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn replace_splits_rejects_over_total_without_writing() {
        let (service, assignment_repo, split_repo) = make_service(activity("WITHDRAWAL"));

        let err = service
            .replace_splits(
                "activity-1",
                vec![
                    split("groceries", 80, SPENDING_TAXONOMY),
                    split("household", 25, SPENDING_TAXONOMY),
                ],
            )
            .await
            .unwrap_err();

        assert!(err.to_string().contains("must equal"));
        assert!(assignment_repo.cleared.lock().unwrap().is_empty());
        assert!(split_repo.replaced.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn replace_splits_rejects_wrong_taxonomy_without_writing() {
        let (service, assignment_repo, split_repo) = make_service(activity("WITHDRAWAL"));

        let err = service
            .replace_splits("activity-1", vec![split("salary", 100, INCOME_TAXONOMY)])
            .await
            .unwrap_err();

        assert!(err.to_string().contains("taxonomy must match"));
        assert!(assignment_repo.cleared.lock().unwrap().is_empty());
        assert!(split_repo.replaced.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn replace_splits_rejects_wrong_category_taxonomy_without_writing() {
        let (service, assignment_repo, split_repo) = make_service(activity("WITHDRAWAL"));
        *split_repo.categories_valid.lock().unwrap() = false;

        let err = service
            .replace_splits("activity-1", vec![split("salary", 100, SPENDING_TAXONOMY)])
            .await
            .unwrap_err();

        assert!(err.to_string().contains("categories must belong"));
        assert!(assignment_repo.cleared.lock().unwrap().is_empty());
        assert!(split_repo.replaced.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn replace_splits_rejects_neutral_transfer_without_writing() {
        let mut transfer = activity("TRANSFER_IN");
        transfer.source_group_id = Some("group-1".to_string());
        let (service, assignment_repo, split_repo) = make_service(transfer);

        let err = service
            .replace_splits(
                "activity-1",
                vec![split("groceries", 100, SPENDING_TAXONOMY)],
            )
            .await
            .unwrap_err();

        assert!(err
            .to_string()
            .contains("Neutral transfers cannot be split"));
        assert!(assignment_repo.cleared.lock().unwrap().is_empty());
        assert!(split_repo.replaced.lock().unwrap().is_empty());
    }

    /// The balance measures cash movement, not the spending net: transfers
    /// count by direction instead of washing out to zero.
    #[tokio::test]
    async fn filtered_balance_sums_signed_cash_movement() {
        // +100 deposit, -40 withdrawal, +15 refund credit, -25 transfer out,
        // and a transfer pair whose two legs cancel (-500 +500).
        let mut refund = search_activity("refund", "CREDIT", 15);
        refund.subtype = Some("REFUND".to_string());
        let mut saving = search_activity("saving", "TRANSFER_OUT", 25);
        saving.source_group_id = Some("cross-boundary".to_string());
        let mut internal_out = search_activity("internal-out", "TRANSFER_OUT", 500);
        internal_out.source_group_id = Some("within".to_string());
        let mut internal_in = search_activity("internal-in", "TRANSFER_IN", 500);
        internal_in.source_group_id = Some("within".to_string());

        let service = make_search_service(
            vec![
                search_activity("income", "DEPOSIT", 100),
                search_activity("spend", "WITHDRAWAL", 40),
                refund,
                saving,
                internal_out,
                internal_in,
            ],
            passthrough_fx(),
            account_types::CASH,
        );

        let response = service.search(search_request(), "USD").await.unwrap();
        let balance = response.filtered_balance.unwrap();

        assert_eq!(response.total_count, 6);
        assert_eq!(balance.amount, 50.0);
        assert_eq!(balance.currency, "USD");
    }

    /// Regression for the reported bug: filtering to Transfer In showed 0.00
    /// because every linked transfer classified as a neutral internal move.
    #[tokio::test]
    async fn filtering_to_transfer_in_totals_the_inflow() {
        let mut linked_a = search_activity("in-a", "TRANSFER_IN", 300);
        linked_a.source_group_id = Some("pair-a".to_string());
        let mut linked_b = search_activity("in-b", "TRANSFER_IN", 200);
        linked_b.source_group_id = Some("pair-b".to_string());
        let mut paired_out = search_activity("out-a", "TRANSFER_OUT", 300);
        paired_out.source_group_id = Some("pair-a".to_string());

        let service = make_search_service(
            vec![linked_a, linked_b, paired_out],
            passthrough_fx(),
            account_types::CASH,
        );

        let response = service
            .search(
                CashActivitySearchRequest {
                    activity_types: Some(vec!["TRANSFER_IN".to_string()]),
                    ..search_request()
                },
                "USD",
            )
            .await
            .unwrap();

        assert_eq!(response.total_count, 2);
        assert_eq!(response.filtered_balance.unwrap().amount, 500.0);
    }

    #[tokio::test]
    async fn filtering_to_transfer_out_totals_the_outflow() {
        let mut out_a = search_activity("out-a", "TRANSFER_OUT", 300);
        out_a.source_group_id = Some("pair-a".to_string());
        let mut out_b = search_activity("out-b", "TRANSFER_OUT", 200);
        out_b.source_group_id = Some("pair-b".to_string());

        let service =
            make_search_service(vec![out_a, out_b], passthrough_fx(), account_types::CASH);

        let response = service
            .search(
                CashActivitySearchRequest {
                    activity_types: Some(vec!["TRANSFER_OUT".to_string()]),
                    ..search_request()
                },
                "USD",
            )
            .await
            .unwrap();

        assert_eq!(response.filtered_balance.unwrap().amount, -500.0);
    }

    /// Both legs of an internal move still cancel when both are in the filtered
    /// set — the money never left the user's accounts.
    #[tokio::test]
    async fn a_transfer_pair_in_the_same_filter_still_nets_to_zero() {
        let mut out = search_activity("out", "TRANSFER_OUT", 750);
        out.source_group_id = Some("pair".to_string());
        let mut into = search_activity("in", "TRANSFER_IN", 750);
        into.source_group_id = Some("pair".to_string());

        let service = make_search_service(vec![out, into], passthrough_fx(), account_types::CASH);

        let response = service.search(search_request(), "USD").await.unwrap();

        assert_eq!(response.filtered_balance.unwrap().amount, 0.0);
    }

    /// A plain CREDIT with no subtype is `Ignored`, so it never appears in this
    /// list at all — and therefore cannot count toward the balance. It does move
    /// cash on the account page, so this is a known reconciliation gap, pinned
    /// here so the exclusion stays deliberate rather than accidental.
    #[tokio::test]
    async fn a_credit_without_a_subtype_is_not_listed_and_so_is_excluded() {
        let service = make_search_service(
            vec![search_activity("credit", "CREDIT", 60)],
            passthrough_fx(),
            account_types::CASH,
        );

        let response = service.search(search_request(), "USD").await.unwrap();

        assert_eq!(response.total_count, 0);
        assert_eq!(response.filtered_balance.unwrap().amount, 0.0);
    }

    /// A refund credit is visible, and moves cash in.
    #[tokio::test]
    async fn a_refund_credit_counts_as_an_inflow() {
        let mut refund = search_activity("refund", "CREDIT", 60);
        refund.subtype = Some("REFUND".to_string());

        let service = make_search_service(vec![refund], passthrough_fx(), account_types::CASH);

        let response = service.search(search_request(), "USD").await.unwrap();

        assert_eq!(response.filtered_balance.unwrap().amount, 60.0);
        assert_eq!(response.items[0].cash_movement, Some(60.0));
    }

    /// Interest is income on a cash account but a charge on a credit card.
    #[tokio::test]
    async fn credit_card_interest_is_an_outflow() {
        let service = make_search_service(
            vec![search_activity("interest", "INTEREST", 12)],
            passthrough_fx(),
            account_types::CREDIT_CARD,
        );

        let response = service.search(search_request(), "USD").await.unwrap();

        assert_eq!(response.filtered_balance.unwrap().amount, -12.0);
    }

    /// Non-POSTED rows are visible in this list but excluded from account
    /// balances, so counting them here would disagree with the account page.
    #[tokio::test]
    async fn rows_that_are_not_posted_contribute_nothing() {
        let mut draft = search_activity("draft", "DEPOSIT", 400);
        draft.status = ActivityStatus::Draft;

        let service = make_search_service(
            vec![draft, search_activity("posted", "DEPOSIT", 100)],
            passthrough_fx(),
            account_types::CASH,
        );

        let response = service.search(search_request(), "USD").await.unwrap();

        assert_eq!(response.total_count, 2);
        assert_eq!(response.filtered_balance.unwrap().amount, 100.0);
    }

    #[tokio::test]
    async fn filtered_balance_covers_rows_beyond_the_requested_page() {
        let activities: Vec<Activity> = (0..5)
            .map(|i| search_activity(&format!("spend-{i}"), "WITHDRAWAL", 10))
            .collect();
        let service = make_search_service(activities, passthrough_fx(), account_types::CASH);

        let response = service
            .search(
                CashActivitySearchRequest {
                    limit: 2,
                    ..search_request()
                },
                "USD",
            )
            .await
            .unwrap();

        assert_eq!(response.items.len(), 2);
        assert_eq!(response.total_count, 5);
        assert_eq!(response.filtered_balance.unwrap().amount, -50.0);
    }

    /// A currency helper for the multi-currency cases below.
    fn search_activity_in(id: &str, activity_type: &str, amount: i64, currency: &str) -> Activity {
        let mut a = search_activity(id, activity_type, amount);
        a.currency = currency.to_string();
        a
    }

    /// The reported case: one account in a currency that is not the base one.
    /// Converting would drift by the FX rate, so a single-currency set is
    /// totalled in its own currency and left alone.
    #[tokio::test]
    async fn a_single_currency_set_totals_in_that_currency_without_converting() {
        let service = make_search_service(
            vec![search_activity_in("spend", "WITHDRAWAL", 40, "USD")],
            fixed_rate_fx(Decimal::new(2, 0)),
            account_types::CASH,
        );

        let response = service.search(search_request(), "EUR").await.unwrap();
        let balance = response.filtered_balance.unwrap();

        assert_eq!(balance.amount, -40.0);
        assert_eq!(balance.currency, "USD");
        assert!(!balance.converted);
    }

    /// Same shape, but the shared currency IS the base currency.
    #[tokio::test]
    async fn a_set_already_in_the_base_currency_is_not_marked_converted() {
        let service = make_search_service(
            vec![search_activity_in("spend", "WITHDRAWAL", 40, "EUR")],
            fixed_rate_fx(Decimal::new(2, 0)),
            account_types::CASH,
        );

        let balance = service
            .search(search_request(), "EUR")
            .await
            .unwrap()
            .filtered_balance
            .unwrap();

        assert_eq!(balance.amount, -40.0);
        assert_eq!(balance.currency, "EUR");
        assert!(!balance.converted);
    }

    /// Several currencies leave no honest choice but the base currency.
    #[tokio::test]
    async fn a_mixed_currency_set_converts_to_the_base_currency() {
        let service = make_search_service(
            vec![
                search_activity_in("usd", "WITHDRAWAL", 40, "USD"),
                search_activity_in("gbp", "WITHDRAWAL", 10, "GBP"),
            ],
            fixed_rate_fx(Decimal::new(2, 0)),
            account_types::CASH,
        );

        let response = service.search(search_request(), "EUR").await.unwrap();
        let balance = response.filtered_balance.unwrap();

        // Both rows convert at the stubbed 2x rate: -(40*2) + -(10*2).
        assert_eq!(balance.amount, -100.0);
        assert_eq!(balance.currency, "EUR");
        assert!(balance.converted);
    }

    /// Rows are always given both amounts, so a client can total either way.
    #[tokio::test]
    async fn rows_carry_both_the_native_and_the_converted_movement() {
        let service = make_search_service(
            vec![search_activity_in("spend", "WITHDRAWAL", 40, "USD")],
            fixed_rate_fx(Decimal::new(2, 0)),
            account_types::CASH,
        );

        let response = service.search(search_request(), "EUR").await.unwrap();

        assert_eq!(response.items[0].cash_movement_native, Some(-40.0));
        assert_eq!(response.items[0].cash_movement, Some(-80.0));
    }

    /// A row that moves no cash must not drag a single-currency set into a
    /// conversion it does not need — it cannot change the total either way.
    #[tokio::test]
    async fn a_zero_movement_row_in_another_currency_does_not_force_conversion() {
        let mut draft = search_activity_in("draft", "DEPOSIT", 500, "GBP");
        draft.status = ActivityStatus::Draft;

        let service = make_search_service(
            vec![search_activity_in("spend", "WITHDRAWAL", 40, "USD"), draft],
            fixed_rate_fx(Decimal::new(2, 0)),
            account_types::CASH,
        );

        let balance = service
            .search(search_request(), "EUR")
            .await
            .unwrap()
            .filtered_balance
            .unwrap();

        assert_eq!(balance.amount, -40.0);
        assert_eq!(balance.currency, "USD");
        assert!(!balance.converted);
    }

    /// The currency is decided over the WHOLE filtered set, not the page, so a
    /// second currency beyond the page limit still forces the conversion.
    #[tokio::test]
    async fn a_currency_beyond_the_page_limit_still_forces_conversion() {
        let mut activities: Vec<Activity> = (0..3)
            .map(|i| search_activity_in(&format!("usd-{i}"), "WITHDRAWAL", 10, "USD"))
            .collect();
        activities.push(search_activity_in("gbp", "WITHDRAWAL", 10, "GBP"));

        let service =
            make_search_service(activities, fixed_rate_fx(Decimal::ONE), account_types::CASH);

        let response = service
            .search(
                CashActivitySearchRequest {
                    limit: 2,
                    ..search_request()
                },
                "EUR",
            )
            .await
            .unwrap();
        let balance = response.filtered_balance.unwrap();

        assert_eq!(response.items.len(), 2);
        assert_eq!(balance.currency, "EUR");
        assert!(balance.converted);
        assert_eq!(balance.amount, -40.0);
    }

    /// Mixed currencies that happen to cancel still report as converted — the
    /// disclosure is about how the total was reached, not whether it is zero.
    #[tokio::test]
    async fn a_mixed_set_that_nets_to_zero_is_still_marked_converted() {
        let service = make_search_service(
            vec![
                search_activity_in("in", "DEPOSIT", 50, "USD"),
                search_activity_in("out", "WITHDRAWAL", 50, "GBP"),
            ],
            fixed_rate_fx(Decimal::ONE),
            account_types::CASH,
        );

        let balance = service
            .search(search_request(), "EUR")
            .await
            .unwrap()
            .filtered_balance
            .unwrap();

        assert_eq!(balance.amount, 0.0);
        assert!(balance.converted);
    }

    #[tokio::test]
    async fn later_pages_skip_the_filtered_balance() {
        let activities: Vec<Activity> = (0..5)
            .map(|i| search_activity(&format!("spend-{i}"), "WITHDRAWAL", 10))
            .collect();
        let service = make_search_service(activities, passthrough_fx(), account_types::CASH);

        let response = service
            .search(
                CashActivitySearchRequest {
                    offset: 2,
                    limit: 2,
                    ..search_request()
                },
                "USD",
            )
            .await
            .unwrap();

        assert!(response.filtered_balance.is_none());
    }

    #[tokio::test]
    async fn an_empty_base_currency_skips_conversion_entirely() {
        let service = make_search_service(
            vec![search_activity("spend", "WITHDRAWAL", 40)],
            passthrough_fx(),
            account_types::CASH,
        );

        let response = service.search(search_request(), "").await.unwrap();

        assert!(response.filtered_balance.is_none());
        assert!(response.items[0].cash_movement.is_none());
    }
}
