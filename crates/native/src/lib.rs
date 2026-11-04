use cap_core::{model, state};
use napi_derive::napi;
use serde::{Serialize, de::DeserializeOwned};
use std::panic::{AssertUnwindSafe, catch_unwind};

const MAX_MODEL_BYTES: usize = 64 * 1024;

fn parse<T: DeserializeOwned>(text: &str) -> model::Result<T> {
    if text.len() > MAX_MODEL_BYTES { return Err(model::Error::InvalidConfig); }
    serde_json::from_str(text).map_err(|_| model::Error::InvalidConfig)
}

fn encode<T: Serialize>(value: &T) -> model::Result<String> {
    serde_json::to_string(value).map_err(|_| model::Error::InvalidConfig)
}

fn guarded<T>(action: impl FnOnce() -> model::Result<T>) -> napi::Result<T> {
    match catch_unwind(AssertUnwindSafe(action)) {
        Ok(result) => result.map_err(|error| napi::Error::from_reason(error.code())),
        Err(_) => Err(napi::Error::from_reason("storage_unavailable")),
    }
}

#[napi]
pub fn api_version() -> napi::Result<u32> {
    guarded(|| Ok(cap_core::API_VERSION))
}

#[napi]
pub fn normalize_budget(json: String) -> napi::Result<String> {
    guarded(|| encode(&model::normalize_budget(parse(&json)?)?))
}

#[napi]
pub fn validate_budget(json: String) -> napi::Result<String> {
    guarded(|| encode(&model::validate_budget(parse(&json)?)?))
}

#[napi]
pub fn normalize_budget_key(json: String) -> napi::Result<String> {
    guarded(|| encode(&model::normalize_budget_key(parse(&json)?)?))
}

#[napi]
pub fn normalize_operation_key(json: String) -> napi::Result<String> {
    guarded(|| encode(&model::normalize_operation_key(parse(&json)?)?))
}

#[napi]
pub fn normalize_context(json: String) -> napi::Result<String> {
    guarded(|| encode(&model::normalize_context(parse(&json)?)?))
}

#[napi]
pub fn validate_policy(network: String, json: String) -> napi::Result<String> {
    guarded(|| encode(&model::validate_policy(network.parse()?, parse(&json)?)?))
}

#[napi]
pub fn validate_origin(network: String, origin: String) -> napi::Result<String> {
    guarded(|| model::validate_origin(network.parse()?, &origin))
}

#[napi]
pub fn new_operation(budget_json: String, start_json: String) -> napi::Result<String> {
    guarded(|| encode(&state::new_operation(&parse(&budget_json)?, parse(&start_json)?)?))
}

#[napi]
pub fn validate_operation(budget_json: String, operation_json: String) -> napi::Result<String> {
    guarded(|| encode(&state::validate_operation(&parse(&budget_json)?, parse(&operation_json)?)?))
}

#[napi]
pub fn check_start(existing_json: String, candidate_json: String) -> napi::Result<()> {
    guarded(|| state::check_start(&parse(&existing_json)?, &parse(&candidate_json)?))
}

#[napi]
pub fn authorization_key(network: String, json: String) -> napi::Result<String> {
    guarded(|| encode(&state::authorization_key(network.parse()?, &parse(&json)?)?))
}

#[napi]
pub fn apply_action(budget_json: String, operation_json: String, action_json: String) -> napi::Result<String> {
    guarded(|| encode(&state::transition(parse(&budget_json)?, parse(&operation_json)?, parse(&action_json)?)?))
}

#[napi]
pub struct PreparedAuthorization {
    inner: cap_core::protocol::PreparedAuthorization,
}

#[napi]
impl PreparedAuthorization {
    #[napi]
    pub fn terms(&self) -> napi::Result<String> { guarded(|| encode(self.inner.terms())) }

    #[napi]
    pub fn authorization(&self) -> napi::Result<String> { guarded(|| encode(self.inner.authorization())) }

    #[napi]
    pub fn typed_data(&self) -> napi::Result<String> { guarded(|| self.inner.typed_data()) }

    #[napi]
    pub fn signing_hash(&self) -> napi::Result<String> { guarded(|| Ok(self.inner.signing_hash())) }

    #[napi]
    pub fn allowance_request(&self) -> napi::Result<Option<String>> { guarded(|| self.inner.allowance_request()) }

    #[napi]
    pub fn check_allowance(&self, result_json: String) -> napi::Result<()> {
        guarded(|| self.inner.check_allowance(&result_json))
    }

    #[napi]
    pub fn encode(&self, signature: String) -> napi::Result<String> { guarded(|| self.inner.encode(&signature)) }
}

#[napi]
pub fn prepare_payment(header: String, operation_json: String, policy_json: String) -> napi::Result<PreparedAuthorization> {
    guarded(|| Ok(PreparedAuthorization {
        inner: cap_core::protocol::prepare_payment(&header, parse(&operation_json)?, parse(&policy_json)?)?,
    }))
}

#[napi]
pub fn begin_signing(budget_json: String, operation_json: String, prepared: &PreparedAuthorization) -> napi::Result<String> {
    guarded(|| encode(&prepared.inner.begin_signing(parse(&budget_json)?, parse(&operation_json)?)?))
}

#[napi]
pub fn read_receipt(header: Option<String>) -> napi::Result<String> {
    guarded(|| encode(&cap_core::protocol::read_receipt(header.as_deref())))
}

#[napi]
pub struct VerifiedResolution {
    inner: cap_core::proof::VerifiedResolution,
}

#[napi]
pub fn reconciliation_plan(operation_json: String) -> napi::Result<String> {
    guarded(|| encode(&cap_core::proof::reconciliation_plan(parse(&operation_json)?)?))
}

#[napi]
pub fn verify_evidence(operation_json: String, evidence_json: String) -> napi::Result<VerifiedResolution> {
    guarded(|| Ok(VerifiedResolution {
        inner: cap_core::proof::verify_evidence(parse(&operation_json)?, &evidence_json)?,
    }))
}

#[napi]
pub fn apply_resolution(budget_json: String, operation_json: String, resolution: &VerifiedResolution) -> napi::Result<String> {
    guarded(|| encode(&resolution.inner.apply(parse(&budget_json)?, parse(&operation_json)?)?))
}
