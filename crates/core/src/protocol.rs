use crate::{model::*, state};
use alloy_primitives::{Address, B256, Bytes, U256, hex};
use alloy_sol_types::{Eip712Domain, SolCall, SolStruct, eip712_domain};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{cell::Cell, str::FromStr, time::SystemTime};
use x402_chain_eip155::{
    chain::{permit2::{
        EXACT_PERMIT2_PROXY_ADDRESS, PERMIT2_ADDRESS, UPTO_PERMIT2_PROXY_ADDRESS,
        ExactPermit2Witness, Permit2Authorization, Permit2AuthorizationPermitted,
        Permit2Payload, UptoPermit2Witness,
    }},
    v1_eip155_exact::types::{ExactEvmPayload, ExactEvmPayloadAuthorization},
};
use x402_types::{
    proto::{OriginalJson, v2::{self, ResourceInfo}},
    timestamp::UnixTimestamp,
    util::{Base64Bytes, DecimalU256},
};

pub const MAX_HEADER_BYTES: usize = 16 * 1024;
pub const MAX_SIGNATURE_BYTES: usize = 4096;
pub const MAX_RPC_JSON_BYTES: usize = 1024 * 1024;

// ABI files and EIP-712 declarations: x402-rs 2.0.2, commit
// 0b14f39afb604a7df25b3496ba34122bdca45a7f (Apache-2.0; see NOTICE).
pub mod eip3009 {
    use alloy_sol_types::sol;
    sol!(IEIP3009, "abi/IEIP3009.json");
    sol! {
        struct TransferWithAuthorization {
            address from;
            address to;
            uint256 value;
            uint256 validAfter;
            uint256 validBefore;
            bytes32 nonce;
        }
    }
}
pub mod erc20 {
    alloy_sol_types::sol!(IERC20, "abi/IERC20.json");
}
pub mod exact_permit2 {
    use alloy_sol_types::sol;
    sol!(X402ExactPermit2Proxy, "abi/X402ExactPermit2Proxy.json");
    sol! {
        struct PermitWitnessTransferFrom {
            ISignatureTransfer.TokenPermissions permitted;
            address spender;
            uint256 nonce;
            uint256 deadline;
            x402ExactPermit2Proxy.Witness witness;
        }
    }
}
pub mod upto_permit2 {
    use alloy_sol_types::sol;
    sol!(X402UptoPermit2Proxy, "abi/X402UptoPermit2Proxy.json");
    sol! {
        struct PermitWitnessTransferFrom {
            ISignatureTransfer.TokenPermissions permitted;
            address spender;
            uint256 nonce;
            uint256 deadline;
            x402UptoPermit2Proxy.Witness witness;
        }
    }
}
pub mod permit2 {
    // SPDX-License-Identifier: MIT. Declaration copied from Coinbase x402:
    // https://github.com/coinbase/x402/blob/e208bd39030be35a0f807eb3bf4f043354273866/contracts/evm/src/interfaces/ISignatureTransfer.sol
    alloy_sol_types::sol! {
        interface IPermit2NonceBitmap {
            function nonceBitmap(address, uint256) external view returns (uint256);
        }
    }
}

type WireRequirements = v2::PaymentRequirements<String, DecimalU256, String, Option<Value>>;

pub struct PreparedAuthorization {
    operation: PaymentOperation,
    terms: Terms,
    authorization: UnsignedAuthorization,
    accepted: OriginalJson,
    resource: ResourceInfo,
    typed_data: Value,
    signing_hash: B256,
    allowance_checked: Cell<bool>,
}

impl PreparedAuthorization {
    pub fn terms(&self) -> &Terms { &self.terms }
    pub fn authorization(&self) -> &UnsignedAuthorization { &self.authorization }
    pub fn typed_data(&self) -> Result<String> {
        serde_json::to_string(&self.typed_data).map_err(|_| Error::AuthorizationFailed)
    }
    pub fn signing_hash(&self) -> String { self.signing_hash.to_string() }

    pub fn begin_signing(&self, budget: BudgetSnapshot, operation: PaymentOperation) -> Result<Transition> {
        let captured = &self.operation;
        if operation.owner_id != captured.owner_id || operation.budget_id != captured.budget_id
            || operation.agent_id != captured.agent_id || operation.operation_id != captured.operation_id
            || operation.request_fingerprint != captured.request_fingerprint
            || operation.target_origin != captured.target_origin || operation.network != captured.network
            || operation.payer != captured.payer {
            return Err(Error::OperationConflict);
        }
        if !self.allowance_checked.get() { return Err(Error::AllowanceRequired); }
        state::begin_signing(budget, operation, self.terms.clone(), self.authorization.clone())
    }

    pub fn allowance_request(&self) -> Result<Option<String>> {
        if self.terms.requirements.extra.asset_transfer_method != AssetTransferMethod::Permit2 {
            return Ok(None);
        }
        let call = erc20::IERC20::allowanceCall {
            owner: address(&self.terms.payer)?, spender: PERMIT2_ADDRESS,
        };
        serde_json::to_string(&json!({
            "method": "eth_call",
            "params": [{"to": self.terms.asset, "data": hex::encode_prefixed(call.abi_encode())}, "latest"]
        })).map(Some).map_err(|_| Error::AllowanceRequired)
    }

    pub fn check_allowance(&self, result_json: &str) -> Result<()> {
        if self.terms.requirements.extra.asset_transfer_method != AssetTransferMethod::Permit2 {
            return Ok(());
        }
        self.allowance_checked.set(false);
        let result = bounded_json(result_json.as_bytes(), MAX_RPC_JSON_BYTES, Error::AllowanceRequired)?;
        let data = result.as_str().ok_or(Error::AllowanceRequired)?;
        if data.len() != 66 || !data.starts_with("0x") { return Err(Error::AllowanceRequired); }
        let data = hex::decode(&data[2..]).map_err(|_| Error::AllowanceRequired)?;
        let amount = erc20::IERC20::allowanceCall::abi_decode_returns_validate(&data)
            .map_err(|_| Error::AllowanceRequired)?;
        if amount < parse_uint(&self.terms.maximum_atomic).map_err(|_| Error::AllowanceRequired)? {
            return Err(Error::AllowanceRequired);
        }
        self.allowance_checked.set(true);
        Ok(())
    }

    pub fn encode(&self, signature: &str) -> Result<String> {
        let signature = signature_bytes(signature)?;
        match &self.authorization {
            UnsignedAuthorization::Eip3009 { from, to, value, valid_after, valid_before, nonce, .. } => {
                let payload = ExactEvmPayload {
                    signature,
                    authorization: ExactEvmPayloadAuthorization {
                        from: address(from)?, to: address(to)?, value: parse_uint(value)?,
                        valid_after: timestamp(valid_after)?, valid_before: timestamp(valid_before)?,
                        nonce: B256::from_str(nonce).map_err(|_| Error::AuthorizationFailed)?,
                    },
                };
                self.encode_payload(payload)
            }
            UnsignedAuthorization::Permit2 { scheme, from, permitted, spender, nonce, deadline, witness, .. } => {
                let permitted = Permit2AuthorizationPermitted {
                    token: address(&permitted.token)?.into(), amount: parse_uint(&permitted.amount)?,
                };
                match scheme {
                    Scheme::Exact => self.encode_payload(Permit2Payload {
                        signature,
                        permit_2_authorization: Permit2Authorization {
                            from: address(from)?.into(), permitted, spender: address(spender)?.into(),
                            nonce: parse_uint(nonce)?, deadline: timestamp(deadline)?,
                            witness: ExactPermit2Witness {
                                to: address(&witness.to)?.into(), valid_after: timestamp(&witness.valid_after)?,
                            },
                        },
                    }),
                    Scheme::Upto => self.encode_payload(Permit2Payload {
                        signature,
                        permit_2_authorization: Permit2Authorization {
                            from: address(from)?.into(), permitted, spender: address(spender)?.into(),
                            nonce: parse_uint(nonce)?, deadline: timestamp(deadline)?,
                            witness: UptoPermit2Witness {
                                to: address(&witness.to)?.into(), valid_after: timestamp(&witness.valid_after)?,
                                facilitator: address(witness.facilitator.as_deref().ok_or(Error::AuthorizationFailed)?)?.into(),
                            },
                        },
                    }),
                }
            }
        }
    }

    fn encode_payload(&self, payload: impl Serialize) -> Result<String> {
        let payment = v2::PaymentPayload {
            accepted: &self.accepted, payload, resource: Some(self.resource.clone()),
            x402_version: v2::X402Version2, extensions: v2::ExtensionsJson::default(),
        };
        let bytes = serde_json::to_vec(&payment).map_err(|_| Error::AuthorizationFailed)?;
        if bytes.len().div_ceil(3) * 4 > MAX_HEADER_BYTES { return Err(Error::AuthorizationFailed); }
        Ok(Base64Bytes::encode(bytes).to_string())
    }
}

fn address(value: &str) -> Result<Address> {
    Address::from_str(value).map_err(|_| Error::AuthorizationFailed)
}
fn timestamp(value: &str) -> Result<UnixTimestamp> {
    parse_timestamp(value).map(UnixTimestamp::from_secs).map_err(|_| Error::AuthorizationFailed)
}
fn signature_bytes(value: &str) -> Result<Bytes> {
    if value.len() <= 2 || value.len() > 2 + MAX_SIGNATURE_BYTES * 2
        || !value.starts_with("0x") || value.len() % 2 != 0
        || !value.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit) {
        return Err(Error::AuthorizationFailed);
    }
    hex::decode(&value[2..]).map(Bytes::from).map_err(|_| Error::AuthorizationFailed)
}

fn bounded_json(bytes: &[u8], max: usize, error: Error) -> Result<Value> {
    if bytes.len() > max { return Err(error); }
    serde_json::from_slice(bytes).map_err(|_| error)
}
fn decode_header(header: &str) -> Result<Vec<u8>> {
    if header.len() > MAX_HEADER_BYTES { return Err(Error::UnsupportedPayment); }
    let bytes = Base64Bytes::from(header.as_bytes()).decode().map_err(|_| Error::UnsupportedPayment)?;
    bounded_json(&bytes, MAX_HEADER_BYTES, Error::UnsupportedPayment)?;
    Ok(bytes)
}

pub fn prepare_payment(header: &str, operation: PaymentOperation, policy: PaymentPolicy) -> Result<PreparedAuthorization> {
    let (terms, accepted, resource) = select(header, &operation, policy)?;
    let mut nonce = [0_u8; 32];
    getrandom::fill(&mut nonce).map_err(|_| Error::AuthorizationFailed)?;
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|_| Error::AuthorizationFailed)?.as_secs();
    capture(operation, terms, accepted, resource, now, nonce)
}

fn select(header: &str, operation: &PaymentOperation, policy: PaymentPolicy) -> Result<(Terms, OriginalJson, ResourceInfo)> {
    let policy = validate_policy(operation.network, policy)?;
    validate_context_identity(operation)?;
    let bytes = decode_header(header)?;
    let challenge: v2::PaymentRequired<OriginalJson> = serde_json::from_slice(&bytes)
        .map_err(|_| Error::UnsupportedPayment)?;
    let resource = challenge.resource.ok_or(Error::UnsupportedPayment)?;
    let url = url::Url::parse(&resource.url).map_err(|_| Error::UnsupportedPayment)?;
    if url.origin().ascii_serialization() != operation.target_origin
        || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(Error::UnsupportedPayment);
    }
    let maximum = parse_uint(&policy.max_per_payment_atomic)?;
    let mut policy_blocked = false;
    for accepted in challenge.accepts {
        let Ok(terms) = offer(&accepted, operation) else { continue; };
        if parse_uint(&terms.maximum_atomic)? > maximum
            || !policy.allowed_schemes.contains(&terms.requirements.scheme)
            || !policy.merchants.iter().any(|m| m.origin == operation.target_origin && m.pay_to == terms.pay_to) {
            policy_blocked = true;
            continue;
        }
        return Ok((terms, accepted, resource));
    }
    Err(if policy_blocked { Error::PolicyRejected } else { Error::UnsupportedPayment })
}

fn validate_context_identity(operation: &PaymentOperation) -> Result<()> {
    validate_id(&operation.owner_id)?;
    validate_id(&operation.budget_id)?;
    validate_id(&operation.agent_id)?;
    validate_id(&operation.operation_id)?;
    validate_fingerprint(&operation.request_fingerprint)?;
    check_origin(operation.network, &operation.target_origin)?;
    if normalize_address(&operation.payer)? != operation.payer { return Err(Error::InvalidConfig); }
    if operation.state != OperationState::Requesting || operation.terms.is_some() || operation.authorization.is_some() {
        return Err(Error::OperationConflict);
    }
    Ok(())
}

fn offer(accepted: &OriginalJson, operation: &PaymentOperation) -> Result<Terms> {
    #[derive(Deserialize)]
    struct Amount { amount: String }
    let amount: Amount = serde_json::from_str(accepted.0.get()).map_err(|_| Error::UnsupportedPayment)?;
    parse_positive_uint(&amount.amount).map_err(|_| Error::UnsupportedPayment)?;
    let wire = WireRequirements::try_from(accepted).map_err(|_| Error::UnsupportedPayment)?;
    let scheme = match wire.scheme.as_str() {
        "exact" => Scheme::Exact, "upto" => Scheme::Upto, _ => return Err(Error::UnsupportedPayment),
    };
    let config = network_config(operation.network);
    if wire.network.to_string() != operation.network.as_str() || wire.amount.to_string() != amount.amount {
        return Err(Error::UnsupportedPayment);
    }
    let asset = normalize_address(&wire.asset).map_err(|_| Error::UnsupportedPayment)?;
    let pay_to = normalize_address(&wire.pay_to).map_err(|_| Error::UnsupportedPayment)?;
    if asset != config.asset || !(1..=300).contains(&wire.max_timeout_seconds) {
        return Err(Error::UnsupportedPayment);
    }
    let extra = match wire.extra {
        None | Some(Value::Null) => serde_json::Map::new(),
        Some(Value::Object(extra)) => extra,
        _ => return Err(Error::UnsupportedPayment),
    };
    let transfer = match extra.get("assetTransferMethod") {
        None if scheme == Scheme::Exact => AssetTransferMethod::Eip3009,
        None => AssetTransferMethod::Permit2,
        Some(Value::String(v)) if v == "eip3009" => AssetTransferMethod::Eip3009,
        Some(Value::String(v)) if v == "permit2" => AssetTransferMethod::Permit2,
        _ => return Err(Error::UnsupportedPayment),
    };
    if scheme == Scheme::Upto && transfer != AssetTransferMethod::Permit2 { return Err(Error::UnsupportedPayment); }
    if extra.get("paymentFlow").is_some_and(|v| v.as_str() != Some("authorization")) {
        return Err(Error::UnsupportedPayment);
    }
    let name = extra_string(&extra, "name")?;
    let version = extra_string(&extra, "version")?;
    if name.as_deref().is_some_and(|v| v != config.name) || version.as_deref().is_some_and(|v| v != config.version)
        || (transfer == AssetTransferMethod::Eip3009 && (name.is_none() || version.is_none())) {
        return Err(Error::UnsupportedPayment);
    }
    let facilitator_address = if scheme == Scheme::Upto {
        Some(normalize_address(extra.get("facilitatorAddress").and_then(Value::as_str)
            .ok_or(Error::UnsupportedPayment)?).map_err(|_| Error::UnsupportedPayment)?)
    } else { None };
    let terms = Terms {
        maximum_atomic: amount.amount.clone(), request_fingerprint: operation.request_fingerprint.clone(),
        payer: operation.payer.clone(), network: operation.network, asset: asset.clone(), pay_to: pay_to.clone(),
        requirements: Requirements {
            scheme, network: operation.network, asset, amount: amount.amount, pay_to,
            max_timeout_seconds: wire.max_timeout_seconds,
            extra: RequirementsExtra { asset_transfer_method: transfer, payment_flow: PaymentFlow::Authorization,
                name, version, facilitator_address },
        },
    };
    normalize_terms(operation, terms).map_err(|_| Error::UnsupportedPayment)
}
fn extra_string(extra: &serde_json::Map<String, Value>, name: &str) -> Result<Option<String>> {
    match extra.get(name) {
        None => Ok(None), Some(Value::String(value)) => Ok(Some(value.clone())), _ => Err(Error::UnsupportedPayment),
    }
}

fn capture(operation: PaymentOperation, terms: Terms, accepted: OriginalJson, resource: ResourceInfo, now: u64, nonce: [u8; 32]) -> Result<PreparedAuthorization> {
    let deadline = now.checked_add(terms.requirements.max_timeout_seconds).ok_or(Error::AuthorizationFailed)?;
    let config = network_config(terms.network);
    let permit2 = terms.requirements.extra.asset_transfer_method == AssetTransferMethod::Permit2;
    let authorization = if !permit2 {
        UnsignedAuthorization::Eip3009 {
            from: terms.payer.clone(), to: terms.pay_to.clone(), value: terms.maximum_atomic.clone(),
            valid_after: "0".into(), valid_before: deadline.to_string(), nonce: B256::from(nonce).to_string(),
            token: terms.asset.clone(), chain_id: config.chain_id.to_string(),
        }
    } else {
        let scheme = terms.requirements.scheme;
        UnsignedAuthorization::Permit2 {
            scheme, from: terms.payer.clone(),
            permitted: TokenPermission { token: terms.asset.clone(), amount: terms.maximum_atomic.clone() },
            spender: match scheme { Scheme::Exact => EXACT_PERMIT2_PROXY_ADDRESS, Scheme::Upto => UPTO_PERMIT2_PROXY_ADDRESS }.to_string().to_ascii_lowercase(),
            nonce: U256::from_be_bytes(nonce).to_string(), deadline: deadline.to_string(),
            witness: PermitWitness { to: terms.pay_to.clone(), valid_after: "0".into(),
                facilitator: terms.requirements.extra.facilitator_address.clone() },
            token: terms.asset.clone(), chain_id: config.chain_id.to_string(),
        }
    };
    validate_authorization(terms.network, &authorization, Some(&terms))?;
    let (typed_data, signing_hash) = signing_data(&terms, &authorization)?;
    Ok(PreparedAuthorization { operation, terms, authorization, accepted, resource, typed_data, signing_hash,
        allowance_checked: Cell::new(!permit2) })
}

fn field(name: &str, ty: &str) -> Value { json!({"name": name, "type": ty}) }
fn signing_data(terms: &Terms, authorization: &UnsignedAuthorization) -> Result<(Value, B256)> {
    let config = network_config(terms.network);
    let (domain_json, domain): (Value, Eip712Domain) = match authorization {
        UnsignedAuthorization::Eip3009 { .. } => (
            json!({"name":config.name,"version":config.version,"chainId":config.chain_id,"verifyingContract":terms.asset}),
            eip712_domain! { name: config.name, version: config.version, chain_id: config.chain_id, verifying_contract: address(&terms.asset)?, },
        ),
        UnsignedAuthorization::Permit2 { .. } => (
            json!({"name":"Permit2","chainId":config.chain_id,"verifyingContract":PERMIT2_ADDRESS}),
            eip712_domain! { name: "Permit2", chain_id: config.chain_id, verifying_contract: PERMIT2_ADDRESS, },
        ),
    };
    let (primary_type, types, message, hash) = match authorization {
        UnsignedAuthorization::Eip3009 { from, to, value, valid_after, valid_before, nonce, .. } => {
            let data = eip3009::TransferWithAuthorization {
                from: address(from)?, to: address(to)?, value: parse_uint(value)?,
                validAfter: parse_uint(valid_after)?, validBefore: parse_uint(valid_before)?,
                nonce: B256::from_str(nonce).map_err(|_| Error::AuthorizationFailed)?,
            };
            ("TransferWithAuthorization", json!({"TransferWithAuthorization":[
                field("from","address"),field("to","address"),field("value","uint256"),
                field("validAfter","uint256"),field("validBefore","uint256"),field("nonce","bytes32")
            ]}), json!({"from":from,"to":to,"value":value,"validAfter":valid_after,"validBefore":valid_before,"nonce":nonce}),
                data.eip712_signing_hash(&domain))
        }
        UnsignedAuthorization::Permit2 { scheme, permitted, spender, nonce, deadline, witness, .. } => {
            let token = address(&permitted.token)?;
            let amount = parse_uint(&permitted.amount)?;
            let spender_address = address(spender)?;
            let nonce_uint = parse_uint(nonce)?;
            let deadline_uint = parse_uint(deadline)?;
            let to = address(&witness.to)?;
            let valid_after = parse_uint(&witness.valid_after)?;
            let hash = match scheme {
                Scheme::Exact => exact_permit2::PermitWitnessTransferFrom {
                    permitted: exact_permit2::ISignatureTransfer::TokenPermissions { token, amount },
                    spender: spender_address, nonce: nonce_uint, deadline: deadline_uint,
                    witness: exact_permit2::x402ExactPermit2Proxy::Witness { to, validAfter: valid_after },
                }.eip712_signing_hash(&domain),
                Scheme::Upto => upto_permit2::PermitWitnessTransferFrom {
                    permitted: upto_permit2::ISignatureTransfer::TokenPermissions { token, amount },
                    spender: spender_address, nonce: nonce_uint, deadline: deadline_uint,
                    witness: upto_permit2::x402UptoPermit2Proxy::Witness {
                        to, validAfter: valid_after,
                        facilitator: address(witness.facilitator.as_deref().ok_or(Error::AuthorizationFailed)?)?,
                    },
                }.eip712_signing_hash(&domain),
            };
            let mut witness_fields = vec![field("to","address")];
            let mut witness_message = json!({"to":witness.to,"validAfter":witness.valid_after});
            if let Some(facilitator) = &witness.facilitator {
                witness_fields.push(field("facilitator","address"));
                witness_message["facilitator"] = json!(facilitator);
            }
            witness_fields.push(field("validAfter","uint256"));
            ("PermitWitnessTransferFrom", json!({
                "PermitWitnessTransferFrom":[field("permitted","TokenPermissions"),field("spender","address"),
                    field("nonce","uint256"),field("deadline","uint256"),field("witness","Witness")],
                "TokenPermissions":[field("token","address"),field("amount","uint256")],
                "Witness":witness_fields,
            }), json!({"permitted":{"token":permitted.token,"amount":permitted.amount},"spender":spender,
                "nonce":nonce,"deadline":deadline,"witness":witness_message}), hash)
        }
    };
    Ok((json!({"domain":domain_json,"types":types,"primaryType":primary_type,"message":message}), hash))
}

pub fn read_receipt(header: Option<&str>) -> ReceiptRead {
    let Some(header) = header else { return ReceiptRead::Missing {}; };
    let Ok(bytes) = decode_header(header) else { return ReceiptRead::Invalid {}; };
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ProviderReceipt {
        success: bool,
        network: String,
        transaction: String,
        payer: Option<String>,
        amount: Option<String>,
        error_reason: Option<String>,
    }
    let Ok(receipt) = serde_json::from_slice::<ProviderReceipt>(&bytes) else { return ReceiptRead::Invalid {}; };
    normalize_report(ReceiptRead::Reported { receipt: SafeReceipt {
        success: receipt.success, network: receipt.network, transaction: receipt.transaction,
        payer: receipt.payer, amount: receipt.amount, error_reason: receipt.error_reason,
    } })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAYER: &str = "0x1111111111111111111111111111111111111111";
    const PAYEE: &str = "0x2222222222222222222222222222222222222222";
    const FACILITATOR: &str = "0x3333333333333333333333333333333333333333";

    fn budget() -> BudgetSnapshot {
        normalize_budget(BudgetInput {
            owner_id: "owner".into(), budget_id: "budget".into(), network: BaseNetwork::Base,
            payer: PAYER.into(), limit_atomic: "10000".into(),
        }).unwrap()
    }
    fn operation() -> PaymentOperation {
        state::new_operation(&budget(), StartInput {
            owner_id: "owner".into(), budget_id: "budget".into(), agent_id: "agent".into(),
            operation_id: "purchase".into(), request_fingerprint: "ab".repeat(32),
            target_origin: "https://merchant.example".into(),
        }).unwrap()
    }
    fn policy() -> PaymentPolicy {
        PaymentPolicy {
            max_per_payment_atomic: "10000".into(), allowed_schemes: vec![Scheme::Exact, Scheme::Upto],
            merchants: vec![Merchant { origin: operation().target_origin, pay_to: PAYEE.into() }],
        }
    }
    fn requirement(scheme: &str, transfer: &str) -> Value {
        let mut extra = json!({"assetTransferMethod":transfer,"name":"USD Coin","version":"2"});
        if scheme == "upto" { extra["facilitatorAddress"] = json!(FACILITATOR); }
        json!({
            "scheme":scheme,"network":"eip155:8453","asset":network_config(BaseNetwork::Base).asset,
            "amount":"1000","payTo":PAYEE,"maxTimeoutSeconds":300,"extra":extra,
        })
    }
    fn challenge(accepts: Vec<Value>) -> Value {
        json!({"x402Version":2,"resource":{"url":"https://merchant.example/data","description":"public"},
            "accepts":accepts,"extensions":{"ignored":{"unsupported":true}}})
    }
    fn header(value: &Value) -> String {
        Base64Bytes::encode(serde_json::to_vec(value).unwrap()).to_string()
    }
    fn prepared(value: &Value) -> PreparedAuthorization {
        let operation = operation();
        let (terms, accepted, resource) = select(&header(value), &operation, policy()).unwrap();
        capture(operation, terms, accepted, resource, 1_700_000_000, [7; 32]).unwrap()
    }
    fn decoded(header: &str) -> Value {
        serde_json::from_slice(&Base64Bytes::from(header.as_bytes()).decode().unwrap()).unwrap()
    }
    fn allowance(amount: U256) -> String {
        serde_json::to_string(&hex::encode_prefixed(erc20::IERC20::allowanceCall::abi_encode_returns(&amount))).unwrap()
    }

    #[test]
    fn rejects_noncanonical_amounts_before_upstream_decimal_codec() {
        for amount in [json!(1000), json!("01000"), json!("+1000"), json!("0x3e8"), json!("0"),
            json!(""), json!("1".repeat(79)), json!((U256::MAX.to_string() + "0"))] {
            let mut offer = requirement("exact", "eip3009");
            offer["amount"] = amount;
            assert!(matches!(select(&header(&challenge(vec![offer])), &operation(), policy()),
                Err(Error::UnsupportedPayment)));
        }
    }

    #[test]
    fn rejects_malformed_and_deep_ignored_wire_fields() {
        for raw in ["".into(), "!".into(), "a".repeat(MAX_HEADER_BYTES + 1),
            header(&json!({"x402Version":1,"accepts":[]}))] {
            assert!(matches!(select(&raw, &operation(), policy()), Err(Error::UnsupportedPayment)));
        }
        let base = serde_json::to_string(&challenge(vec![requirement("exact", "eip3009")])).unwrap();
        let nested = format!("{}0{}", "[".repeat(140), "]".repeat(140));
        let deep = format!("{},\"ignored\":{nested}}}", &base[..base.len() - 1]);
        assert!(matches!(select(&Base64Bytes::encode(deep).to_string(), &operation(), policy()),
            Err(Error::UnsupportedPayment)));
    }

    #[test]
    fn rejects_unsupported_financial_terms_and_origin() {
        for (field, value) in [
            ("scheme", json!("subscription")), ("network", json!("eip155:1")),
            ("asset", json!(PAYEE)), ("maxTimeoutSeconds", json!(0)),
            ("maxTimeoutSeconds", json!(301)), ("maxTimeoutSeconds", json!(1.5)),
        ] {
            let mut offer = requirement("exact", "eip3009");
            offer[field] = value;
            assert!(matches!(select(&header(&challenge(vec![offer])), &operation(), policy()),
                Err(Error::UnsupportedPayment)));
        }
        for (field, value) in [
            ("name", json!("Fake USDC")), ("version", json!("1")),
            ("paymentFlow", json!("sponsored")), ("assetTransferMethod", json!("eip2612")),
        ] {
            let mut offer = requirement("exact", "eip3009");
            offer["extra"][field] = value;
            assert!(matches!(select(&header(&challenge(vec![offer])), &operation(), policy()),
                Err(Error::UnsupportedPayment)));
        }
        let mut upto = requirement("upto", "permit2");
        upto["extra"].as_object_mut().unwrap().remove("facilitatorAddress");
        assert!(matches!(select(&header(&challenge(vec![upto])), &operation(), policy()),
            Err(Error::UnsupportedPayment)));
        let mut wrong_origin = challenge(vec![requirement("exact", "eip3009")]);
        wrong_origin["resource"]["url"] = json!("https://attacker.example/data");
        assert!(matches!(select(&header(&wrong_origin), &operation(), policy()), Err(Error::UnsupportedPayment)));
    }

    #[test]
    fn chooses_first_policy_compatible_offer_not_cheapest() {
        let mut first = requirement("exact", "eip3009");
        first["amount"] = json!("9000");
        let second = requirement("exact", "permit2");
        let selected = prepared(&challenge(vec![first.clone(), second.clone()]));
        assert_eq!(selected.terms().maximum_atomic, "9000");
        let mut restricted = policy();
        restricted.max_per_payment_atomic = "2000".into();
        let (terms, _, _) = select(&header(&challenge(vec![first, second])), &operation(), restricted).unwrap();
        assert_eq!(terms.maximum_atomic, "1000");
        let mut excluded = policy();
        excluded.allowed_schemes = vec![Scheme::Upto];
        assert!(matches!(select(&header(&challenge(vec![requirement("exact", "eip3009")])),
            &operation(), excluded), Err(Error::PolicyRejected)));
        let mut payee = requirement("exact", "eip3009");
        payee["payTo"] = json!(FACILITATOR);
        assert!(matches!(select(&header(&challenge(vec![payee])), &operation(), policy()),
            Err(Error::PolicyRejected)));
    }

    #[test]
    fn defaults_transfer_methods_without_signing_extensions() {
        for scheme in ["exact", "upto"] {
            let mut offer = requirement(scheme, if scheme == "exact" { "eip3009" } else { "permit2" });
            offer["extra"].as_object_mut().unwrap().remove("assetTransferMethod");
            let prepared = prepared(&challenge(vec![offer]));
            assert_eq!(prepared.terms().requirements.extra.asset_transfer_method,
                if scheme == "exact" { AssetTransferMethod::Eip3009 } else { AssetTransferMethod::Permit2 });
        }
    }

    #[test]
    fn allowance_is_generated_decoded_and_required_before_signing() {
        let prepared = prepared(&challenge(vec![requirement("upto", "permit2")]));
        let request: Value = serde_json::from_str(&prepared.allowance_request().unwrap().unwrap()).unwrap();
        assert_eq!(request["method"], "eth_call");
        assert_eq!(request["params"][1], "latest");
        let bytes = hex::decode(request["params"][0]["data"].as_str().unwrap()).unwrap();
        let call = erc20::IERC20::allowanceCall::abi_decode_validate(&bytes).unwrap();
        assert_eq!(call.owner, address(PAYER).unwrap());
        assert_eq!(call.spender, PERMIT2_ADDRESS);
        assert_eq!(prepared.begin_signing(budget(), operation()), Err(Error::AllowanceRequired));
        for invalid in ["null".into(), "{}".into(), "\"0x\"".into(), allowance(U256::from(999)),
            format!("\"{}\"", "a".repeat(MAX_RPC_JSON_BYTES))] {
            assert_eq!(prepared.check_allowance(&invalid), Err(Error::AllowanceRequired));
        }
        prepared.check_allowance(&allowance(U256::MAX)).unwrap();
        let mut changed = operation();
        changed.operation_id = "different".into();
        assert_eq!(prepared.begin_signing(budget(), changed), Err(Error::OperationConflict));
        let transition = prepared.begin_signing(budget(), operation()).unwrap();
        assert_eq!(transition.budget.held_atomic, "1000");
        assert_eq!(transition.operation.state, OperationState::Signing);
        assert_eq!(transition.operation.authorization.as_ref(), Some(prepared.authorization()));
    }

    #[test]
    fn signature_contract_is_bytes_not_eoa_and_final_header_is_bounded() {
        let prepared = prepared(&challenge(vec![requirement("exact", "eip3009")]));
        for invalid in ["0x".into(), "1234".into(), "0x1".into(), "0xgg".into(),
            format!("0x{}", "ab".repeat(MAX_SIGNATURE_BYTES + 1))] {
            assert_eq!(prepared.encode(&invalid), Err(Error::AuthorizationFailed));
        }
        let signature = format!("0x{}", "ab".repeat(MAX_SIGNATURE_BYTES));
        let wire = decoded(&prepared.encode(&signature).unwrap());
        assert_eq!(wire["payload"]["signature"], signature);
        let mut large = requirement("exact", "eip3009");
        large["extra"]["ignored"] = json!("x".repeat(7000));
        let large = self::prepared(&challenge(vec![large]));
        assert_eq!(large.encode(&signature), Err(Error::AuthorizationFailed));
    }

    #[test]
    fn checked_expiry_rejects_overflow() {
        let operation = operation();
        let (terms, accepted, resource) = select(&header(&challenge(vec![requirement("exact","eip3009")])),
            &operation, policy()).unwrap();
        assert!(matches!(capture(operation, terms, accepted, resource, u64::MAX, [0;32]),
            Err(Error::AuthorizationFailed)));
    }

    #[test]
    fn receipts_discard_messages_extensions_and_normalize_failures() {
        assert_eq!(read_receipt(None), ReceiptRead::Missing {});
        assert_eq!(read_receipt(Some("!")), ReceiptRead::Invalid {});
        let mut receipt = json!({"success":false,"network":"eip155:8453","transaction":"",
            "payer":PAYER,"amount":"0","errorReason":"sensitive provider message",
            "message":"credential","extensions":{"private":"secret"}});
        let read = read_receipt(Some(&header(&receipt)));
        let safe = serde_json::to_value(&read).unwrap();
        assert_eq!(safe["receipt"]["errorReason"], "provider_failure");
        assert!(safe["receipt"].get("message").is_none());
        assert!(safe["receipt"].get("extensions").is_none());
        receipt.as_object_mut().unwrap().remove("errorReason");
        assert_eq!(serde_json::to_value(read_receipt(Some(&header(&receipt)))).unwrap()["receipt"]["errorReason"],
            "provider_failure");
        receipt["amount"] = json!("00");
        assert_eq!(read_receipt(Some(&header(&receipt))), ReceiptRead::Invalid {});
        receipt["amount"] = json!(0);
        assert_eq!(read_receipt(Some(&header(&receipt))), ReceiptRead::Invalid {});
    }
}
