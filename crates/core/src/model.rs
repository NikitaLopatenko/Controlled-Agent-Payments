use alloy_primitives::{Address, U256};
use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};
use x402_chain_eip155::chain::permit2::{
    EXACT_PERMIT2_PROXY_ADDRESS, PERMIT2_ADDRESS, UPTO_PERMIT2_PROXY_ADDRESS,
};

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Error {
    InvalidConfig,
    InvalidAmount,
    UnsupportedPayment,
    PolicyRejected,
    AllowanceRequired,
    RequestNotReplayable,
    PaymentAlreadySupplied,
    RequestAborted,
    AuthorizationFailed,
    PaymentUnresolved,
    BudgetExceeded,
    OperationConflict,
    OperationInProgress,
    OperationAlreadyProcessed,
    StorageUnavailable,
}

impl Error {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidConfig => "invalid_config",
            Self::InvalidAmount => "invalid_amount",
            Self::UnsupportedPayment => "unsupported_payment",
            Self::PolicyRejected => "policy_rejected",
            Self::AllowanceRequired => "allowance_required",
            Self::RequestNotReplayable => "request_not_replayable",
            Self::PaymentAlreadySupplied => "payment_already_supplied",
            Self::RequestAborted => "request_aborted",
            Self::AuthorizationFailed => "authorization_failed",
            Self::PaymentUnresolved => "payment_unresolved",
            Self::BudgetExceeded => "budget_exceeded",
            Self::OperationConflict => "operation_conflict",
            Self::OperationInProgress => "operation_in_progress",
            Self::OperationAlreadyProcessed => "operation_already_processed",
            Self::StorageUnavailable => "storage_unavailable",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for Error {}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum BaseNetwork {
    #[serde(rename = "eip155:8453")]
    Base,
    #[serde(rename = "eip155:84532")]
    Sepolia,
}

impl BaseNetwork {
    pub const fn as_str(self) -> &'static str {
        match self { Self::Base => "eip155:8453", Self::Sepolia => "eip155:84532" }
    }
}
impl fmt::Display for BaseNetwork {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
impl FromStr for BaseNetwork {
    type Err = Error;
    fn from_str(value: &str) -> Result<Self> {
        match value {
            "eip155:8453" => Ok(Self::Base),
            "eip155:84532" => Ok(Self::Sepolia),
            _ => Err(Error::InvalidConfig),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NetworkConfig {
    pub chain_id: u64,
    pub asset: &'static str,
    pub name: &'static str,
    pub version: &'static str,
    pub decimals: u8,
}

pub const fn network_config(network: BaseNetwork) -> NetworkConfig {
    match network {
        BaseNetwork::Base => NetworkConfig {
            chain_id: 8453,
            asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            name: "USD Coin",
            version: "2",
            decimals: 6,
        },
        BaseNetwork::Sepolia => NetworkConfig {
            chain_id: 84532,
            asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
            name: "USDC",
            version: "2",
            decimals: 6,
        },
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationState {
    Requesting,
    Signing,
    Submitted,
    Reported,
    Unknown,
    Settled,
    Unpaid,
}
impl OperationState {
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Settled | Self::Unpaid)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetKey {
    pub owner_id: String,
    pub budget_id: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationKey {
    pub owner_id: String,
    pub budget_id: String,
    pub operation_id: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentContext {
    pub owner_id: String,
    pub budget_id: String,
    pub agent_id: String,
    pub operation_id: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetInput {
    pub owner_id: String,
    pub budget_id: String,
    pub network: BaseNetwork,
    pub payer: String,
    pub limit_atomic: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetSnapshot {
    pub owner_id: String,
    pub budget_id: String,
    pub network: BaseNetwork,
    pub payer: String,
    pub limit_atomic: String,
    pub held_atomic: String,
    pub spent_atomic: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartInput {
    pub owner_id: String,
    pub budget_id: String,
    pub agent_id: String,
    pub operation_id: String,
    pub request_fingerprint: String,
    pub target_origin: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scheme { Exact, Upto }
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetTransferMethod { Eip3009, Permit2 }
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PaymentFlow { Authorization }

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Merchant {
    pub origin: String,
    pub pay_to: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaymentPolicy {
    pub max_per_payment_atomic: String,
    pub allowed_schemes: Vec<Scheme>,
    pub merchants: Vec<Merchant>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequirementsExtra {
    pub asset_transfer_method: AssetTransferMethod,
    pub payment_flow: PaymentFlow,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facilitator_address: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Requirements {
    pub scheme: Scheme,
    pub network: BaseNetwork,
    pub asset: String,
    pub amount: String,
    pub pay_to: String,
    pub max_timeout_seconds: u64,
    pub extra: RequirementsExtra,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Terms {
    pub maximum_atomic: String,
    pub request_fingerprint: String,
    pub payer: String,
    pub network: BaseNetwork,
    pub asset: String,
    pub pay_to: String,
    pub requirements: Requirements,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenPermission {
    pub token: String,
    pub amount: String,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermitWitness {
    pub to: String,
    pub valid_after: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facilitator: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum UnsignedAuthorization {
    Eip3009 {
        from: String,
        to: String,
        value: String,
        valid_after: String,
        valid_before: String,
        nonce: String,
        token: String,
        chain_id: String,
    },
    Permit2 {
        scheme: Scheme,
        from: String,
        permitted: TokenPermission,
        spender: String,
        nonce: String,
        deadline: String,
        witness: PermitWitness,
        token: String,
        chain_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SafeReceipt {
    pub success: bool,
    pub network: String,
    pub transaction: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_reason: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum ReceiptRead {
    Missing {},
    Invalid {},
    Reported { receipt: SafeReceipt },
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnpaidReason { NoAuthorizationCreated, ExpiredNonceUnspent }
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum FinalProof {
    Settled {
        transaction_hash: String,
        amount_atomic: String,
        finalized_block_number: String,
        finalized_block_hash: String,
    },
    Unpaid {
        reason: UnpaidReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        finalized_block_number: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        finalized_block_hash: Option<String>,
    },
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaymentOperation {
    pub owner_id: String,
    pub budget_id: String,
    pub agent_id: String,
    pub operation_id: String,
    pub request_fingerprint: String,
    pub target_origin: String,
    pub network: BaseNetwork,
    pub payer: String,
    pub state: OperationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terms: Option<Terms>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization: Option<UnsignedAuthorization>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<ReceiptRead>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_amount_atomic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_proof: Option<FinalProof>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_code: Option<Error>,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportOutcome { Received, TransportFailed }
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    Submitted {},
    Report { report: ReceiptRead, outcome: ReportOutcome },
    Failure { code: Error },
    CloseUnsigned {},
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transition {
    pub budget: BudgetSnapshot,
    pub operation: PaymentOperation,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorizationKey {
    pub contract: String,
    pub payer: String,
    pub nonce: String,
}

pub fn validate_id(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.trim() != value || value.bytes().any(|b| b.is_ascii_control()) {
        return Err(Error::InvalidConfig);
    }
    Ok(())
}

pub fn parse_uint(value: &str) -> Result<U256> {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 78 || (bytes.len() > 1 && bytes[0] == b'0') || !bytes.iter().all(u8::is_ascii_digit) {
        return Err(Error::InvalidAmount);
    }
    U256::from_str_radix(value, 10).map_err(|_| Error::InvalidAmount)
}
pub fn parse_positive_uint(value: &str) -> Result<U256> {
    let amount = parse_uint(value)?;
    if amount.is_zero() { return Err(Error::InvalidAmount); }
    Ok(amount)
}
pub fn parse_timestamp(value: &str) -> Result<u64> {
    let parsed = parse_uint(value)?;
    u64::try_from(parsed).map_err(|_| Error::InvalidConfig)
}

fn check_hex(value: &str, bytes: usize, nonzero: bool) -> Result<()> {
    let Some(hex) = value.strip_prefix("0x") else { return Err(Error::InvalidConfig); };
    if hex.len() != bytes * 2 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) || (nonzero && hex.bytes().all(|b| b == b'0')) {
        return Err(Error::InvalidConfig);
    }
    Ok(())
}
fn normalized_hex(value: &str, bytes: usize, nonzero: bool) -> Result<String> {
    check_hex(value, bytes, nonzero)?;
    Ok(value.to_ascii_lowercase())
}
pub(crate) fn normalize_owned_address(value: &mut String) -> Result<()> {
    check_hex(value, 20, true)?;
    value.make_ascii_lowercase();
    Ok(())
}
pub fn normalize_address(value: &str) -> Result<String> { normalized_hex(value, 20, true) }
pub fn normalize_hash(value: &str) -> Result<String> { normalized_hex(value, 32, false) }
pub fn validate_fingerprint(value: &str) -> Result<()> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(Error::InvalidConfig);
    }
    Ok(())
}
pub fn normalize_fingerprint(value: &str) -> Result<String> {
    validate_fingerprint(value)?;
    Ok(value.to_owned())
}
pub(crate) fn check_origin(network: BaseNetwork, origin: &str) -> Result<()> {
    let url = url::Url::parse(origin).map_err(|_| Error::InvalidConfig)?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.origin().ascii_serialization() != origin || !url.username().is_empty() || url.password().is_some()
        || !(url.scheme() == "https" || (network == BaseNetwork::Sepolia && url.scheme() == "http" && loopback)) {
        return Err(Error::InvalidConfig);
    }
    Ok(())
}
pub fn validate_origin(network: BaseNetwork, origin: &str) -> Result<String> {
    check_origin(network, origin)?;
    Ok(origin.to_owned())
}
pub fn normalize_budget_key(key: BudgetKey) -> Result<BudgetKey> {
    validate_id(&key.owner_id)?;
    validate_id(&key.budget_id)?;
    Ok(key)
}
pub fn normalize_operation_key(key: OperationKey) -> Result<OperationKey> {
    validate_id(&key.owner_id)?;
    validate_id(&key.budget_id)?;
    validate_id(&key.operation_id)?;
    Ok(key)
}
pub fn normalize_context(context: AgentContext) -> Result<AgentContext> {
    validate_id(&context.owner_id)?;
    validate_id(&context.budget_id)?;
    validate_id(&context.agent_id)?;
    validate_id(&context.operation_id)?;
    Ok(context)
}
pub fn normalize_budget(mut input: BudgetInput) -> Result<BudgetSnapshot> {
    validate_id(&input.owner_id)?;
    validate_id(&input.budget_id)?;
    parse_uint(&input.limit_atomic)?;
    check_hex(&input.payer, 20, true)?;
    input.payer.make_ascii_lowercase();
    Ok(BudgetSnapshot {
        owner_id: input.owner_id, budget_id: input.budget_id, network: input.network,
        payer: input.payer, limit_atomic: input.limit_atomic,
        held_atomic: "0".into(), spent_atomic: "0".into(),
    })
}
pub(crate) fn check_budget(budget: &BudgetSnapshot) -> Result<()> {
    validate_id(&budget.owner_id)?;
    validate_id(&budget.budget_id)?;
    check_hex(&budget.payer, 20, true)?;
    let limit = parse_uint(&budget.limit_atomic)?;
    let total = parse_uint(&budget.held_atomic)?.checked_add(parse_uint(&budget.spent_atomic)?)
        .ok_or(Error::InvalidConfig)?;
    if total > limit { return Err(Error::InvalidConfig); }
    Ok(())
}
pub fn validate_budget(mut budget: BudgetSnapshot) -> Result<BudgetSnapshot> {
    check_budget(&budget)?;
    budget.payer.make_ascii_lowercase();
    Ok(budget)
}
pub fn validate_policy(network: BaseNetwork, mut policy: PaymentPolicy) -> Result<PaymentPolicy> {
    parse_positive_uint(&policy.max_per_payment_atomic)?;
    if policy.allowed_schemes.is_empty() || policy.merchants.is_empty() { return Err(Error::InvalidConfig); }
    for merchant in &mut policy.merchants {
        check_origin(network, &merchant.origin)?;
        normalize_owned_address(&mut merchant.pay_to)?;
    }
    Ok(policy)
}

pub fn normalize_terms(operation: &PaymentOperation, mut terms: Terms) -> Result<Terms> {
    let config = network_config(operation.network);
    parse_positive_uint(&terms.maximum_atomic)?;
    validate_fingerprint(&terms.request_fingerprint)?;
    normalize_owned_address(&mut terms.payer)?;
    normalize_owned_address(&mut terms.asset)?;
    normalize_owned_address(&mut terms.pay_to)?;
    let requirements = &mut terms.requirements;
    normalize_owned_address(&mut requirements.asset)?;
    normalize_owned_address(&mut requirements.pay_to)?;
    parse_positive_uint(&requirements.amount)?;
    if terms.network != operation.network || terms.payer != operation.payer
        || terms.request_fingerprint != operation.request_fingerprint || terms.asset != config.asset
        || requirements.network != terms.network || requirements.asset != terms.asset
        || requirements.pay_to != terms.pay_to || requirements.amount != terms.maximum_atomic {
        return Err(Error::OperationConflict);
    }
    if !(1..=300).contains(&requirements.max_timeout_seconds)
        || (requirements.scheme == Scheme::Upto && requirements.extra.asset_transfer_method != AssetTransferMethod::Permit2) {
        return Err(Error::UnsupportedPayment);
    }
    let extra = &mut requirements.extra;
    if extra.name.as_deref().is_some_and(|v| v != config.name)
        || extra.version.as_deref().is_some_and(|v| v != config.version)
        || (extra.asset_transfer_method == AssetTransferMethod::Eip3009 && (extra.name.is_none() || extra.version.is_none())) {
        return Err(Error::UnsupportedPayment);
    }
    if let Some(facilitator) = &mut extra.facilitator_address { normalize_owned_address(facilitator)?; }
    if requirements.scheme == Scheme::Upto && extra.facilitator_address.is_none() { return Err(Error::UnsupportedPayment); }
    Ok(terms)
}

pub fn validate_authorization(network: BaseNetwork, input: &UnsignedAuthorization, terms: Option<&Terms>) -> Result<()> {
    let config = network_config(network);
    match input {
        UnsignedAuthorization::Eip3009 { from, to, value, valid_after, valid_before, nonce, token, chain_id } => {
            check_hex(from, 20, true)?;
            check_hex(to, 20, true)?;
            check_hex(token, 20, true)?;
            check_hex(nonce, 32, false)?;
            parse_positive_uint(value)?;
            if parse_timestamp(valid_after)? != 0 || parse_timestamp(valid_before)? == 0
                || !token.eq_ignore_ascii_case(config.asset) || parse_uint(chain_id)? != U256::from(config.chain_id) {
                return Err(Error::OperationConflict);
            }
            if let Some(terms) = terms {
                if terms.network != network || !from.eq_ignore_ascii_case(&terms.payer) || !token.eq_ignore_ascii_case(&terms.asset)
                    || !to.eq_ignore_ascii_case(&terms.pay_to) || value != &terms.maximum_atomic
                    || terms.requirements.scheme != Scheme::Exact || terms.requirements.extra.asset_transfer_method != AssetTransferMethod::Eip3009 {
                    return Err(Error::OperationConflict);
                }
            }
        },
        UnsignedAuthorization::Permit2 { scheme, from, permitted, spender, nonce, deadline, witness, token, chain_id } => {
            check_hex(from, 20, true)?;
            check_hex(token, 20, true)?;
            check_hex(&permitted.token, 20, true)?;
            check_hex(spender, 20, true)?;
            check_hex(&witness.to, 20, true)?;
            if let Some(facilitator) = &witness.facilitator { check_hex(facilitator, 20, true)?; }
            parse_positive_uint(&permitted.amount)?;
            parse_uint(nonce)?;
            let expected_spender = match scheme { Scheme::Exact => EXACT_PERMIT2_PROXY_ADDRESS, Scheme::Upto => UPTO_PERMIT2_PROXY_ADDRESS };
            if !token.eq_ignore_ascii_case(config.asset) || !permitted.token.eq_ignore_ascii_case(token)
                || parse_uint(chain_id)? != U256::from(config.chain_id)
                || Address::from_str(spender).map_err(|_| Error::InvalidConfig)? != expected_spender
                || parse_timestamp(&witness.valid_after)? != 0 || parse_timestamp(deadline)? == 0
                || (*scheme == Scheme::Exact && witness.facilitator.is_some()) || (*scheme == Scheme::Upto && witness.facilitator.is_none()) {
                return Err(Error::OperationConflict);
            }
            if let Some(terms) = terms {
                let facilitator_matches = match (&witness.facilitator, &terms.requirements.extra.facilitator_address) {
                    (Some(actual), Some(expected)) => actual.eq_ignore_ascii_case(expected),
                    (None, None) => true,
                    _ => false,
                };
                if terms.network != network || !from.eq_ignore_ascii_case(&terms.payer) || !token.eq_ignore_ascii_case(&terms.asset)
                    || permitted.amount != terms.maximum_atomic || !witness.to.eq_ignore_ascii_case(&terms.pay_to)
                    || terms.requirements.scheme != *scheme || terms.requirements.extra.asset_transfer_method != AssetTransferMethod::Permit2
                    || (*scheme == Scheme::Upto && !facilitator_matches) {
                    return Err(Error::OperationConflict);
                }
            }
        },
    }
    Ok(())
}

pub fn normalize_authorization(network: BaseNetwork, mut input: UnsignedAuthorization, terms: Option<&Terms>) -> Result<UnsignedAuthorization> {
    validate_authorization(network, &input, terms)?;
    match &mut input {
        UnsignedAuthorization::Eip3009 { from, to, nonce, token, .. } => {
            from.make_ascii_lowercase();
            to.make_ascii_lowercase();
            nonce.make_ascii_lowercase();
            token.make_ascii_lowercase();
        },
        UnsignedAuthorization::Permit2 { from, permitted, spender, witness, token, .. } => {
            from.make_ascii_lowercase();
            permitted.token.make_ascii_lowercase();
            spender.make_ascii_lowercase();
            witness.to.make_ascii_lowercase();
            if let Some(facilitator) = &mut witness.facilitator { facilitator.make_ascii_lowercase(); }
            token.make_ascii_lowercase();
        },
    }
    Ok(input)
}

pub fn authorization_key(network: BaseNetwork, authorization: &UnsignedAuthorization) -> Result<AuthorizationKey> {
    validate_authorization(network, authorization, None)?;
    match authorization {
        UnsignedAuthorization::Eip3009 { from, token, nonce, .. } => Ok(AuthorizationKey {
            contract: token.to_ascii_lowercase(), payer: from.to_ascii_lowercase(), nonce: nonce.to_ascii_lowercase(),
        }),
        UnsignedAuthorization::Permit2 { from, nonce, .. } => Ok(AuthorizationKey {
            contract: format!("{PERMIT2_ADDRESS:#x}"), payer: from.to_ascii_lowercase(), nonce: nonce.clone(),
        }),
    }
}

fn valid_receipt_network(value: &str) -> bool {
    let Some((namespace, reference)) = value.split_once(':') else { return false; };
    (1..=32).contains(&namespace.len()) && namespace.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && (1..=64).contains(&reference.len()) && reference.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn report_reason_allowed(reason: &str) -> bool {
    matches!(reason, "provider_failure" | "settlement_pending" | "settlement_failed" | "settlement_rejected"
        | "settlement_timeout" | "transaction_failed" | "transaction_reverted" | "transaction_not_found"
        | "insufficient_funds" | "insufficient_allowance" | "invalid_signature" | "invalid_nonce"
        | "invalid_authorization" | "authorization_expired" | "payment_expired" | "payment_required"
        | "unsupported_network" | "unsupported_scheme")
}
pub(crate) fn validate_stored_report(report: &ReceiptRead) -> Result<()> {
    let ReceiptRead::Reported { receipt } = report else { return Ok(()); };
    if !valid_receipt_network(&receipt.network) { return Err(Error::InvalidConfig); }
    if !receipt.transaction.is_empty() { check_hex(&receipt.transaction, 32, false)?; }
    if let Some(payer) = &receipt.payer { check_hex(payer, 20, true)?; }
    if let Some(amount) = &receipt.amount { parse_uint(amount)?; }
    if receipt.error_reason.as_deref().is_some_and(|reason| !report_reason_allowed(reason))
        || (!receipt.success && receipt.error_reason.is_none()) { return Err(Error::InvalidConfig); }
    Ok(())
}
pub fn normalize_report(report: ReceiptRead) -> ReceiptRead {
    let ReceiptRead::Reported { mut receipt } = report else { return report; };
    if !valid_receipt_network(&receipt.network) { return ReceiptRead::Invalid {}; }
    if !receipt.transaction.is_empty() {
        if check_hex(&receipt.transaction, 32, false).is_err() { return ReceiptRead::Invalid {}; }
        receipt.transaction.make_ascii_lowercase();
    }
    if let Some(payer) = &mut receipt.payer {
        if normalize_owned_address(payer).is_err() { return ReceiptRead::Invalid {}; }
    }
    if receipt.amount.as_deref().is_some_and(|v| parse_uint(v).is_err()) { return ReceiptRead::Invalid {}; }
    if receipt.error_reason.as_deref() == Some("") { receipt.error_reason = None; }
    if let Some(reason) = receipt.error_reason.as_deref() {
        if !report_reason_allowed(reason) { receipt.error_reason = Some("provider_failure".into()); }
    } else if !receipt.success {
        receipt.error_reason = Some("provider_failure".into());
    }
    ReceiptRead::Reported { receipt }
}

pub fn coherent_report(report: &ReceiptRead, operation: &PaymentOperation) -> bool {
    let (ReceiptRead::Reported { receipt }, Some(terms)) = (report, operation.terms.as_ref()) else { return false; };
    if !receipt.success || receipt.error_reason.is_some() || receipt.network != operation.network.as_str()
        || receipt.payer.as_deref().is_some_and(|payer| payer != operation.payer) { return false; }
    if let Some(amount) = &receipt.amount {
        let (Ok(amount_value), Ok(maximum)) = (parse_uint(amount), parse_uint(&terms.maximum_atomic)) else { return false; };
        if amount_value > maximum || (terms.requirements.scheme == Scheme::Exact && amount != &terms.maximum_atomic) { return false; }
    }
    check_hex(&receipt.transaction, 32, false).is_ok()
        || (terms.requirements.scheme == Scheme::Upto && receipt.amount.as_deref() == Some("0") && receipt.transaction.is_empty())
}

pub fn normalize_final_proof(proof: FinalProof) -> Result<FinalProof> {
    match proof {
        FinalProof::Settled { transaction_hash, amount_atomic, finalized_block_number, finalized_block_hash } => {
            parse_uint(&amount_atomic)?;
            parse_uint(&finalized_block_number)?;
            Ok(FinalProof::Settled { transaction_hash: normalize_hash(&transaction_hash)?, amount_atomic,
                finalized_block_number, finalized_block_hash: normalize_hash(&finalized_block_hash)? })
        }
        FinalProof::Unpaid { reason, finalized_block_number, finalized_block_hash } => {
            match reason {
                UnpaidReason::NoAuthorizationCreated if finalized_block_number.is_none() && finalized_block_hash.is_none() => {},
                UnpaidReason::ExpiredNonceUnspent if finalized_block_number.is_some() && finalized_block_hash.is_some() => {
                    parse_uint(finalized_block_number.as_deref().ok_or(Error::InvalidConfig)?)?;
                },
                _ => return Err(Error::InvalidConfig),
            }
            let finalized_block_hash = finalized_block_hash.as_deref().map(normalize_hash).transpose()?;
            Ok(FinalProof::Unpaid { reason, finalized_block_number, finalized_block_hash })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const MAX: &str = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    const PAYER: &str = "0x1111111111111111111111111111111111111111";

    #[test]
    fn canonical_decimal_and_timestamp_boundaries() {
        assert_eq!(parse_uint("0"), Ok(U256::ZERO));
        assert_eq!(parse_uint(MAX), Ok(U256::MAX));
        for value in ["", "00", "01", "-1", "+1", " 1", "1 ", "1.0", "1e3", "0x1", "١", "１",
            "115792089237316195423570985008687907853269984665640564039457584007913129639936"] {
            assert_eq!(parse_uint(value), Err(Error::InvalidAmount));
        }
        assert!(parse_uint(&"9".repeat(79)).is_err());
        assert!(parse_positive_uint("0").is_err());
        assert_eq!(parse_timestamp("18446744073709551615"), Ok(u64::MAX));
        assert!(parse_timestamp("18446744073709551616").is_err());
    }

    #[test]
    fn identifiers_are_byte_bounded_and_not_unicode_normalized() {
        assert!(validate_id(&"é".repeat(128)).is_ok());
        assert!(validate_id(&"é".repeat(129)).is_err());
        assert!(validate_id(&"a".repeat(256)).is_ok());
        assert!(validate_id(&"a".repeat(257)).is_err());
        for value in ["", " a", "a ", "\u{00a0}a", "a\nb", "a\u{7f}b"] { assert!(validate_id(value).is_err()); }
        let composed = "é";
        let decomposed = "e\u{301}";
        assert!(validate_id(composed).is_ok());
        assert!(validate_id(decomposed).is_ok());
        assert_ne!(composed, decomposed);
    }

    #[test]
    fn addresses_hashes_and_canonical_origins() {
        assert_eq!(normalize_address("0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD").unwrap(),
            "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
        assert!(normalize_address("0x0000000000000000000000000000000000000000").is_err());
        assert!(normalize_address("0X1111111111111111111111111111111111111111").is_err());
        assert!(normalize_hash(&format!("0x{}", "0".repeat(64))).is_ok());
        assert!(normalize_fingerprint(&"A".repeat(64)).is_err());
        for origin in ["https://example.com", "https://example.com:444"] {
            assert_eq!(validate_origin(BaseNetwork::Base, origin).unwrap(), origin);
        }
        for origin in ["https://EXAMPLE.com", "https://example.com/", "https://example.com:443",
            "https://user:pass@example.com", "https://example.com?x", "https://example.com#", "http://example.com", "null"] {
            assert!(validate_origin(BaseNetwork::Sepolia, origin).is_err(), "{origin}");
        }
        for origin in ["http://localhost", "http://127.0.0.1:8080", "http://[::1]:8080"] {
            assert!(validate_origin(BaseNetwork::Sepolia, origin).is_ok(), "{origin}");
            assert!(validate_origin(BaseNetwork::Base, origin).is_err());
        }
        assert!(validate_origin(BaseNetwork::Sepolia, "http://localhost.example").is_err());
    }

    #[test]
    fn budget_and_policy_boundaries() {
        let input = BudgetInput { owner_id: "owner".into(), budget_id: "budget".into(), network: BaseNetwork::Base,
            payer: PAYER.into(), limit_atomic: MAX.into() };
        let mut budget = normalize_budget(input).unwrap();
        budget.held_atomic = MAX.into();
        assert!(validate_budget(budget.clone()).is_ok());
        budget.spent_atomic = "1".into();
        assert!(validate_budget(budget).is_err());
        let mut policy = PaymentPolicy { max_per_payment_atomic: "1".into(), allowed_schemes: vec![Scheme::Exact],
            merchants: vec![Merchant { origin: "http://localhost:8080".into(), pay_to: PAYER.into() }] };
        assert!(validate_policy(BaseNetwork::Sepolia, policy.clone()).is_ok());
        assert!(validate_policy(BaseNetwork::Base, policy.clone()).is_err());
        policy.allowed_schemes.clear();
        assert!(validate_policy(BaseNetwork::Sepolia, policy).is_err());
    }

    #[test]
    fn stored_dtos_reject_unrecognized_fields_and_wire_numbers() {
        let valid = serde_json::json!({"ownerId":"o","budgetId":"b","network":"eip155:8453","payer":PAYER,"limitAtomic":"1"});
        assert!(serde_json::from_value::<BudgetInput>(valid.clone()).is_ok());
        let mut extra = valid.clone();
        extra["signature"] = "secret".into();
        assert!(serde_json::from_value::<BudgetInput>(extra).is_err());
        let mut numeric = valid;
        numeric["limitAtomic"] = 1.into();
        assert!(serde_json::from_value::<BudgetInput>(numeric).is_err());
        assert!(serde_json::from_str::<Action>(r#"{"kind":"resolve","resolution":{"kind":"unpaid"}}"#).is_err());
        assert!(serde_json::from_str::<Action>(r#"{"kind":"beginSigning"}"#).is_err());
        assert!(serde_json::from_str::<OperationState>(r#""reserved""#).is_err());
        assert!(serde_json::from_str::<BaseNetwork>(r#""eip155:1""#).is_err());
        assert!(serde_json::from_str::<ReceiptRead>(r#"{"kind":"missing","credential":"secret"}"#).is_err());
    }

    #[test]
    fn receipt_reasons_are_safe_and_invalid_values_are_not_retained() {
        let receipt = SafeReceipt { success: false, network: "eip155:8453".into(), transaction: "".into(),
            payer: None, amount: None, error_reason: Some("secret provider message".into()) };
        let normalized = normalize_report(ReceiptRead::Reported { receipt: receipt.clone() });
        let ReceiptRead::Reported { receipt: safe } = normalized else { panic!("safe receipt"); };
        assert_eq!(safe.error_reason.as_deref(), Some("provider_failure"));
        assert!(!serde_json::to_string(&safe).unwrap().contains("secret"));
        let mut invalid = receipt;
        invalid.amount = Some("01".into());
        assert_eq!(normalize_report(ReceiptRead::Reported { receipt: invalid }), ReceiptRead::Invalid {});
        for reason in [None, Some(""), Some("provider_failure"), Some("settlement_pending")] {
            let receipt = SafeReceipt { success: false, network: "eip155:8453".into(), transaction: "".into(),
                payer: None, amount: None, error_reason: reason.map(str::to_owned) };
            let ReceiptRead::Reported { receipt } = normalize_report(ReceiptRead::Reported { receipt }) else { panic!("safe receipt"); };
            assert_eq!(receipt.error_reason.as_deref(), Some(reason.filter(|v| !v.is_empty()).unwrap_or("provider_failure")));
        }
    }

    #[test]
    fn final_proof_is_exactly_three_shapes() {
        let unsigned = FinalProof::Unpaid { reason: UnpaidReason::NoAuthorizationCreated,
            finalized_block_number: None, finalized_block_hash: None };
        assert_eq!(serde_json::to_string(&unsigned).unwrap(), r#"{"kind":"unpaid","reason":"no_authorization_created"}"#);
        assert!(normalize_final_proof(unsigned).is_ok());
        assert!(normalize_final_proof(FinalProof::Unpaid { reason: UnpaidReason::ExpiredNonceUnspent,
            finalized_block_number: Some("1".into()), finalized_block_hash: None }).is_err());
        assert!(normalize_final_proof(FinalProof::Unpaid { reason: UnpaidReason::NoAuthorizationCreated,
            finalized_block_number: Some("1".into()), finalized_block_hash: Some(format!("0x{}", "1".repeat(64))) }).is_err());
    }

    proptest! {
        #[test]
        fn every_uint256_roundtrips_in_decimal(limbs in any::<[u64; 4]>()) {
            let value = U256::from_limbs(limbs);
            let decimal = value.to_string();
            prop_assert_eq!(parse_uint(&decimal), Ok(value));
            prop_assert!(decimal.len() <= 78);
            prop_assert!(parse_uint(&format!("0{decimal}")).is_err(), "leading zero must be rejected");
        }

        #[test]
        fn decimal_parser_agrees_with_canonical_range(value in "[0-9]{1,80}") {
            let canonical = value == "0" || !value.starts_with('0');
            let in_range = value.len() < MAX.len() || (value.len() == MAX.len() && value.as_str() <= MAX);
            prop_assert_eq!(parse_uint(&value).is_ok(), canonical && in_range);
        }
    }
}
