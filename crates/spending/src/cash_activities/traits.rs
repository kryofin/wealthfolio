use anyhow::Result;
use async_trait::async_trait;

use super::model::{CashActivity, CashActivitySearchRequest, CashActivitySearchResponse};
use super::service::CashActivityService;

/// Read-only surface of `CashActivityService` consumed by agent tools.
/// Mirrors the inherent method signatures exactly; extend (don't change)
/// when write tools need more of the service.
#[async_trait]
pub trait CashActivityServiceTrait: Send + Sync {
    async fn search(&self, req: CashActivitySearchRequest) -> Result<CashActivitySearchResponse>;
    async fn get_by_activity_ids(&self, activity_ids: &[String]) -> Result<Vec<CashActivity>>;
}

#[async_trait]
impl CashActivityServiceTrait for CashActivityService {
    async fn search(&self, req: CashActivitySearchRequest) -> Result<CashActivitySearchResponse> {
        // Agent tools read native per-row amounts; no base currency, so the
        // service skips FX conversion and the filtered balance.
        CashActivityService::search(self, req, "").await
    }

    async fn get_by_activity_ids(&self, activity_ids: &[String]) -> Result<Vec<CashActivity>> {
        CashActivityService::get_by_activity_ids(self, activity_ids).await
    }
}
