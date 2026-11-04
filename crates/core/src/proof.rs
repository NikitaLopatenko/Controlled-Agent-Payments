use crate::{model::*, protocol::{self, eip3009::IEIP3009, exact_permit2, permit2::IPermit2NonceBitmap, upto_permit2}, state};
use alloy_primitives::{Address, B256, U256, hex, keccak256};
use alloy_sol_types::{SolCall, SolEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::str::FromStr;
use x402_chain_eip155::chain::permit2::PERMIT2_ADDRESS;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationPlan {
    pub chain_id: u64,
    pub expiry: String,
    pub unused_call: UnusedCall,
}

#[derive(Debug, Serialize)]
pub struct UnusedCall {
    pub to: String,
    pub data: String,
}

#[doc = r#"```compile_fail
let _: cap_core::proof::VerifiedResolution = serde_json::from_str("{}").unwrap();
```"#]
pub struct VerifiedResolution {
    binding: B256,
    proof: FinalProof,
}

impl VerifiedResolution {
    pub fn apply(&self, budget: BudgetSnapshot, operation: PaymentOperation) -> Result<Transition> {
        let operation = state::validate_operation(&budget, operation)?;
        if operation_binding(&operation)? != self.binding { return Err(Error::OperationConflict); }
        state::apply_final_resolution(budget, operation, self.proof.clone())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Evidence {
    chain_id: String,
    finalized: RpcBlock,
    canonical_finalized: RpcBlock,
    rechecked_finalized: RpcBlock,
    settlement: Option<Value>,
    unused_result: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settlement {
    candidate: String,
    transaction: RpcTransaction,
    receipt: RpcReceipt,
    canonical_block: RpcBlock,
}

#[derive(Deserialize)]
struct RpcBlock {
    number: String,
    hash: String,
    timestamp: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcTransaction {
    hash: String,
    from: String,
    to: String,
    input: String,
    block_number: String,
    block_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcReceipt {
    transaction_hash: String,
    block_number: String,
    block_hash: String,
    status: String,
    logs: Vec<RpcLog>,
}

#[derive(Deserialize)]
struct RpcLog {
    address: String,
    topics: Vec<String>,
    data: String,
    #[serde(default)]
    removed: bool,
}

#[derive(Debug, Eq, PartialEq)]
struct Block {
    number: U256,
    hash: B256,
    timestamp: u64,
}

fn require(condition: bool) -> Result<()> {
    if condition { Ok(()) } else { Err(Error::PaymentUnresolved) }
}

fn quantity(value: &str) -> Result<U256> {
    let digits = value.strip_prefix("0x").ok_or(Error::PaymentUnresolved)?;
    require(!digits.is_empty() && digits.len() <= 64
        && (digits == "0" || !digits.starts_with('0'))
        && digits.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))?;
    U256::from_str_radix(digits, 16).map_err(|_| Error::PaymentUnresolved)
}

fn hash(value: &str) -> Result<B256> {
    require(value.len() == 66 && value.starts_with("0x"))?;
    B256::from_str(value).map_err(|_| Error::PaymentUnresolved)
}

fn address(value: &str) -> Result<Address> {
    require(value.len() == 42 && value.starts_with("0x"))?;
    let address = Address::from_str(value).map_err(|_| Error::PaymentUnresolved)?;
    require(!address.is_zero())?;
    Ok(address)
}

fn bytes(value: &str) -> Result<Vec<u8>> {
    let digits = value.strip_prefix("0x").ok_or(Error::PaymentUnresolved)?;
    require(digits.len() % 2 == 0)?;
    hex::decode(digits).map_err(|_| Error::PaymentUnresolved)
}

fn block(raw: &RpcBlock) -> Result<Block> {
    Ok(Block {
        number: quantity(&raw.number)?, hash: hash(&raw.hash)?,
        timestamp: u64::try_from(quantity(&raw.timestamp)?).map_err(|_| Error::PaymentUnresolved)?,
    })
}

fn authorized(mut operation: PaymentOperation) -> Result<PaymentOperation> {
    require(matches!(operation.state, OperationState::Signing | OperationState::Submitted
        | OperationState::Reported | OperationState::Unknown))?;
    validate_id(&operation.owner_id)?;
    validate_id(&operation.budget_id)?;
    validate_id(&operation.agent_id)?;
    validate_id(&operation.operation_id)?;
    validate_fingerprint(&operation.request_fingerprint)?;
    validate_origin(operation.network, &operation.target_origin)?;
    operation.payer = normalize_address(&operation.payer)?;
    let terms = operation.terms.take().ok_or(Error::PaymentUnresolved)?;
    operation.terms = Some(normalize_terms(&operation, terms)?);
    operation.authorization = Some(normalize_authorization(operation.network,
        operation.authorization.take().ok_or(Error::PaymentUnresolved)?, operation.terms.as_ref())?);
    require(operation.final_proof.is_none() && operation.final_amount_atomic.is_none())?;
    Ok(operation)
}

fn operation_binding(operation: &PaymentOperation) -> Result<B256> {
    let terms = operation.terms.as_ref().ok_or(Error::OperationConflict)?;
    let authorization = operation.authorization.as_ref().ok_or(Error::OperationConflict)?;
    let serialized = serde_json::to_vec(&(
        &operation.owner_id, &operation.budget_id, &operation.agent_id, &operation.operation_id,
        &operation.request_fingerprint, &operation.target_origin, operation.network, &operation.payer,
        terms, authorization,
    )).map_err(|_| Error::OperationConflict)?;
    Ok(keccak256(serialized))
}

fn expiry(authorization: &UnsignedAuthorization) -> Result<u64> {
    match authorization {
        UnsignedAuthorization::Eip3009 { valid_before, .. } => parse_timestamp(valid_before),
        UnsignedAuthorization::Permit2 { deadline, .. } => parse_timestamp(deadline),
    }
}

pub fn reconciliation_plan(operation: PaymentOperation) -> Result<ReconciliationPlan> {
    let operation = authorized(operation).map_err(|_| Error::PaymentUnresolved)?;
    let authorization = operation.authorization.as_ref().ok_or(Error::PaymentUnresolved)?;
    let unused_call = match authorization {
        UnsignedAuthorization::Eip3009 { from, nonce, token, .. } => UnusedCall {
            to: token.clone(),
            data: hex::encode_prefixed(IEIP3009::authorizationStateCall {
                authorizer: address(from)?, nonce: hash(nonce)?,
            }.abi_encode()),
        },
        UnsignedAuthorization::Permit2 { from, nonce, .. } => UnusedCall {
            to: format!("{PERMIT2_ADDRESS:#x}"),
            data: hex::encode_prefixed(IPermit2NonceBitmap::nonceBitmapCall::new((
                address(from)?, parse_uint(nonce)? >> 8,
            )).abi_encode()),
        },
    };
    Ok(ReconciliationPlan {
        chain_id: network_config(operation.network).chain_id,
        expiry: expiry(authorization)?.to_string(), unused_call,
    })
}

pub fn verify_evidence(operation: PaymentOperation, evidence_json: &str) -> Result<VerifiedResolution> {
    verify(operation, evidence_json).map_err(|_| Error::PaymentUnresolved)
}

fn verify(operation: PaymentOperation, evidence_json: &str) -> Result<VerifiedResolution> {
    let operation = authorized(operation)?;
    require(evidence_json.len() <= protocol::MAX_RPC_JSON_BYTES)?;
    let value: Value = serde_json::from_str(evidence_json).map_err(|_| Error::PaymentUnresolved)?;
    let evidence: Evidence = serde_json::from_value(value).map_err(|_| Error::PaymentUnresolved)?;
    require(quantity(&evidence.chain_id)? == U256::from(network_config(operation.network).chain_id))?;
    let finalized = block(&evidence.finalized)?;
    require(block(&evidence.canonical_finalized)? == finalized
        && block(&evidence.rechecked_finalized)? == finalized)?;
    let proof = evidence.settlement
        .and_then(|value| serde_json::from_value::<Settlement>(value).ok())
        .and_then(|candidate| settled(&operation, &finalized, candidate).ok())
        .or_else(|| evidence.unused_result.as_ref()
            .and_then(|result| expired_unused(&operation, &finalized, result).ok()))
        .ok_or(Error::PaymentUnresolved)?;
    Ok(VerifiedResolution { binding: operation_binding(&operation)?, proof })
}

fn settled(operation: &PaymentOperation, finalized: &Block, settlement: Settlement) -> Result<FinalProof> {
    let candidate = hash(&settlement.candidate)?;
    let tx = settlement.transaction;
    let receipt = settlement.receipt;
    let canonical = block(&settlement.canonical_block)?;
    require(hash(&tx.hash)? == candidate && hash(&receipt.transaction_hash)? == candidate
        && quantity(&tx.block_number)? == canonical.number && quantity(&receipt.block_number)? == canonical.number
        && hash(&tx.block_hash)? == canonical.hash && hash(&receipt.block_hash)? == canonical.hash
        && receipt.status == "0x1" && canonical.number <= finalized.number
        && canonical.timestamp <= finalized.timestamp
        && (canonical.number != finalized.number || canonical == *finalized))?;
    let actual = settled_amount(operation, &tx)?;
    let terms = operation.terms.as_ref().ok_or(Error::PaymentUnresolved)?;
    require(actual <= parse_uint(&terms.maximum_atomic)?
        && (terms.requirements.scheme != Scheme::Exact || actual == parse_uint(&terms.maximum_atomic)?))?;
    let payer = address(&operation.payer)?;
    let payee = address(&terms.pay_to)?;
    let token = address(&terms.asset)?;
    let mut matching = 0;
    for log in receipt.logs {
        if address(&log.address)? != token || log.removed { continue; }
        let topics = log.topics.iter().map(|topic| hash(topic)).collect::<Result<Vec<_>>>()?;
        if topics.first() != Some(&IEIP3009::Transfer::SIGNATURE_HASH) { continue; }
        require(topics.len() == 3)?;
        let data = bytes(&log.data)?;
        require(data.len() == 32)?;
        let transfer = IEIP3009::Transfer::decode_raw_log_validate(topics, &data)
            .map_err(|_| Error::PaymentUnresolved)?;
        if transfer.from == payer && transfer.to == payee {
            require(transfer.value == actual)?;
            matching += 1;
        }
    }
    require(matching == 1)?;
    Ok(FinalProof::Settled {
        transaction_hash: candidate.to_string(), amount_atomic: actual.to_string(),
        finalized_block_number: canonical.number.to_string(), finalized_block_hash: canonical.hash.to_string(),
    })
}

fn settled_amount(operation: &PaymentOperation, tx: &RpcTransaction) -> Result<U256> {
    let destination = address(&tx.to)?;
    let sender = address(&tx.from)?;
    let data = bytes(&tx.input)?;
    match operation.authorization.as_ref().ok_or(Error::PaymentUnresolved)? {
        UnsignedAuthorization::Eip3009 { from, to, value, valid_after, valid_before, nonce, token, .. } => {
            require(destination == address(token)?)?;
            let fields = if let Ok(call) = IEIP3009::transferWithAuthorization_0Call::abi_decode_validate(&data) {
                (call.from, call.to, call.value, call.validAfter, call.validBefore, call.nonce)
            } else {
                let call = IEIP3009::transferWithAuthorization_1Call::abi_decode_validate(&data)
                    .map_err(|_| Error::PaymentUnresolved)?;
                (call.from, call.to, call.value, call.validAfter, call.validBefore, call.nonce)
            };
            require(fields == (address(from)?, address(to)?, parse_uint(value)?,
                parse_uint(valid_after)?, parse_uint(valid_before)?, hash(nonce)?))?;
            Ok(fields.2)
        },
        UnsignedAuthorization::Permit2 { scheme: Scheme::Exact, from, permitted, spender, nonce, deadline, witness, .. } => {
            require(destination == address(spender)?)?;
            let call = exact_permit2::X402ExactPermit2Proxy::settleCall::abi_decode_validate(&data)
                .map_err(|_| Error::PaymentUnresolved)?;
            require(call.owner == address(from)? && call.permit.permitted.token == address(&permitted.token)?
                && call.permit.permitted.amount == parse_uint(&permitted.amount)?
                && call.permit.nonce == parse_uint(nonce)? && call.permit.deadline == parse_uint(deadline)?
                && call.witness.to == address(&witness.to)? && call.witness.validAfter == parse_uint(&witness.valid_after)?)?;
            Ok(call.permit.permitted.amount)
        },
        UnsignedAuthorization::Permit2 { scheme: Scheme::Upto, from, permitted, spender, nonce, deadline, witness, .. } => {
            require(destination == address(spender)?)?;
            let call = upto_permit2::X402UptoPermit2Proxy::settleCall::abi_decode_validate(&data)
                .map_err(|_| Error::PaymentUnresolved)?;
            let facilitator = address(witness.facilitator.as_deref().ok_or(Error::PaymentUnresolved)?)?;
            require(sender == facilitator && call.owner == address(from)?
                && call.permit.permitted.token == address(&permitted.token)?
                && call.permit.permitted.amount == parse_uint(&permitted.amount)?
                && call.permit.nonce == parse_uint(nonce)? && call.permit.deadline == parse_uint(deadline)?
                && call.witness.to == address(&witness.to)? && call.witness.facilitator == facilitator
                && call.witness.validAfter == parse_uint(&witness.valid_after)?)?;
            Ok(call.amount)
        },
    }
}

fn expired_unused(operation: &PaymentOperation, finalized: &Block, result: &Value) -> Result<FinalProof> {
    let authorization = operation.authorization.as_ref().ok_or(Error::PaymentUnresolved)?;
    require(finalized.timestamp > expiry(authorization)?)?;
    let data = bytes(result.as_str().ok_or(Error::PaymentUnresolved)?)?;
    require(data.len() == 32)?;
    match authorization {
        UnsignedAuthorization::Eip3009 { .. } => {
            let used = IEIP3009::authorizationStateCall::abi_decode_returns_validate(&data)
                .map_err(|_| Error::PaymentUnresolved)?;
            require(!used)?;
        },
        UnsignedAuthorization::Permit2 { nonce, .. } => {
            let bitmap = IPermit2NonceBitmap::nonceBitmapCall::abi_decode_returns_validate(&data)
                .map_err(|_| Error::PaymentUnresolved)?;
            let bit = u8::try_from(parse_uint(nonce)? & U256::from(255)).map_err(|_| Error::PaymentUnresolved)?;
            require((bitmap & (U256::from(1) << usize::from(bit))).is_zero())?;
        },
    }
    Ok(FinalProof::Unpaid {
        reason: UnpaidReason::ExpiredNonceUnspent,
        finalized_block_number: Some(finalized.number.to_string()), finalized_block_hash: Some(finalized.hash.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::Bytes;
    use serde_json::json;
    use x402_chain_eip155::chain::permit2::{EXACT_PERMIT2_PROXY_ADDRESS, UPTO_PERMIT2_PROXY_ADDRESS};

    const PAYER: &str = "0x1111111111111111111111111111111111111111";
    const PAYEE: &str = "0x2222222222222222222222222222222222222222";
    const FACILITATOR: &str = "0x3333333333333333333333333333333333333333";
    const OTHER: &str = "0x4444444444444444444444444444444444444444";

    #[derive(Clone, Copy)]
    enum Form { EipBytes, EipVrs, ExactPermit2, UptoPermit2 }
    const FORMS: [Form; 4] = [Form::EipBytes, Form::EipVrs, Form::ExactPermit2, Form::UptoPermit2];

    fn fixture(form: Form) -> Transition {
        let budget = normalize_budget(BudgetInput {
            owner_id: "owner".into(), budget_id: "budget".into(), network: BaseNetwork::Base,
            payer: PAYER.into(), limit_atomic: "10000".into(),
        }).unwrap();
        let operation = state::new_operation(&budget, StartInput {
            owner_id: "owner".into(), budget_id: "budget".into(), agent_id: "agent".into(),
            operation_id: "purchase".into(), request_fingerprint: "ab".repeat(32),
            target_origin: "https://merchant.example".into(),
        }).unwrap();
        let (scheme, method) = match form {
            Form::EipBytes | Form::EipVrs => (Scheme::Exact, AssetTransferMethod::Eip3009),
            Form::ExactPermit2 => (Scheme::Exact, AssetTransferMethod::Permit2),
            Form::UptoPermit2 => (Scheme::Upto, AssetTransferMethod::Permit2),
        };
        let config = network_config(operation.network);
        let terms = Terms {
            maximum_atomic: "7000".into(), request_fingerprint: operation.request_fingerprint.clone(),
            payer: PAYER.into(), network: operation.network, asset: config.asset.into(), pay_to: PAYEE.into(),
            requirements: Requirements {
                scheme, network: operation.network, asset: config.asset.into(), amount: "7000".into(),
                pay_to: PAYEE.into(), max_timeout_seconds: 100,
                extra: RequirementsExtra {
                    asset_transfer_method: method, payment_flow: PaymentFlow::Authorization,
                    name: Some(config.name.into()), version: Some(config.version.into()),
                    facilitator_address: (scheme == Scheme::Upto).then(|| FACILITATOR.into()),
                },
            },
        };
        let authorization = if method == AssetTransferMethod::Eip3009 {
            UnsignedAuthorization::Eip3009 {
                from: PAYER.into(), to: PAYEE.into(), value: "7000".into(), valid_after: "0".into(),
                valid_before: "200".into(), nonce: format!("0x{}", "07".repeat(32)),
                token: config.asset.into(), chain_id: config.chain_id.to_string(),
            }
        } else {
            UnsignedAuthorization::Permit2 {
                scheme, from: PAYER.into(), permitted: TokenPermission { token: config.asset.into(), amount: "7000".into() },
                spender: format!("{:#x}", if scheme == Scheme::Exact { EXACT_PERMIT2_PROXY_ADDRESS } else { UPTO_PERMIT2_PROXY_ADDRESS }),
                nonce: U256::MAX.to_string(), deadline: "200".into(),
                witness: PermitWitness { to: PAYEE.into(), valid_after: "0".into(),
                    facilitator: (scheme == Scheme::Upto).then(|| FACILITATOR.into()) },
                token: config.asset.into(), chain_id: config.chain_id.to_string(),
            }
        };
        state::begin_signing(budget, operation, terms, authorization).unwrap()
    }

    fn calldata(operation: &PaymentOperation, form: Form, actual: U256) -> String {
        let data = match operation.authorization.as_ref().unwrap() {
            UnsignedAuthorization::Eip3009 { from, to, value, valid_after, valid_before, nonce, .. } => {
                let fields = (address(from).unwrap(), address(to).unwrap(), parse_uint(value).unwrap(),
                    parse_uint(valid_after).unwrap(), parse_uint(valid_before).unwrap(), hash(nonce).unwrap());
                match form {
                    Form::EipBytes => IEIP3009::transferWithAuthorization_0Call {
                        from: fields.0, to: fields.1, value: fields.2, validAfter: fields.3,
                        validBefore: fields.4, nonce: fields.5, signature: Bytes::from(vec![9; 65]),
                    }.abi_encode(),
                    _ => IEIP3009::transferWithAuthorization_1Call {
                        from: fields.0, to: fields.1, value: fields.2, validAfter: fields.3,
                        validBefore: fields.4, nonce: fields.5, v: 27, r: B256::repeat_byte(8), s: B256::repeat_byte(9),
                    }.abi_encode(),
                }
            },
            UnsignedAuthorization::Permit2 { scheme: Scheme::Exact, from, permitted, nonce, deadline, witness, .. } => {
                exact_permit2::X402ExactPermit2Proxy::settleCall {
                    permit: exact_permit2::ISignatureTransfer::PermitTransferFrom {
                        permitted: exact_permit2::ISignatureTransfer::TokenPermissions {
                            token: address(&permitted.token).unwrap(), amount: parse_uint(&permitted.amount).unwrap(),
                        },
                        nonce: parse_uint(nonce).unwrap(), deadline: parse_uint(deadline).unwrap(),
                    },
                    owner: address(from).unwrap(),
                    witness: exact_permit2::x402ExactPermit2Proxy::Witness {
                        to: address(&witness.to).unwrap(), validAfter: parse_uint(&witness.valid_after).unwrap(),
                    },
                    signature: Bytes::from(vec![9; 65]),
                }.abi_encode()
            },
            UnsignedAuthorization::Permit2 { from, permitted, nonce, deadline, witness, .. } => {
                upto_permit2::X402UptoPermit2Proxy::settleCall {
                    permit: upto_permit2::ISignatureTransfer::PermitTransferFrom {
                        permitted: upto_permit2::ISignatureTransfer::TokenPermissions {
                            token: address(&permitted.token).unwrap(), amount: parse_uint(&permitted.amount).unwrap(),
                        },
                        nonce: parse_uint(nonce).unwrap(), deadline: parse_uint(deadline).unwrap(),
                    },
                    amount: actual, owner: address(from).unwrap(),
                    witness: upto_permit2::x402UptoPermit2Proxy::Witness {
                        to: address(&witness.to).unwrap(), facilitator: address(witness.facilitator.as_deref().unwrap()).unwrap(),
                        validAfter: parse_uint(&witness.valid_after).unwrap(),
                    },
                    signature: Bytes::from(vec![9; 65]),
                }.abi_encode()
            },
        };
        hex::encode_prefixed(data)
    }

    fn transfer(operation: &PaymentOperation, amount: U256) -> Value {
        let terms = operation.terms.as_ref().unwrap();
        let event = IEIP3009::Transfer {
            from: address(&operation.payer).unwrap(), to: address(&terms.pay_to).unwrap(), value: amount,
        }.encode_log_data();
        json!({"address":terms.asset,"topics":event.topics().iter().map(ToString::to_string).collect::<Vec<_>>(),
            "data":hex::encode_prefixed(&event.data),"removed":false})
    }

    fn evidence(operation: &PaymentOperation, form: Form) -> Value {
        let terms = operation.terms.as_ref().unwrap();
        let actual = if terms.requirements.scheme == Scheme::Upto { U256::from(1200) }
            else { parse_uint(&terms.maximum_atomic).unwrap() };
        let to = match operation.authorization.as_ref().unwrap() {
            UnsignedAuthorization::Eip3009 { token, .. } => token,
            UnsignedAuthorization::Permit2 { spender, .. } => spender,
        };
        let head = json!({"number":"0x20","hash":B256::repeat_byte(32).to_string(),"timestamp":"0xc9"});
        let canonical = json!({"number":"0x1f","hash":B256::repeat_byte(31).to_string(),"timestamp":"0xc7"});
        let candidate = B256::repeat_byte(55).to_string();
        json!({
            "chainId":"0x2105","finalized":head,"canonicalFinalized":head,"recheckedFinalized":head,
            "settlement":{
                "candidate":candidate,
                "transaction":{"hash":candidate,"from":FACILITATOR,"to":to,"input":calldata(operation,form,actual),
                    "blockNumber":canonical["number"],"blockHash":canonical["hash"],"normalRpcExtension":{"ignored":true}},
                "receipt":{"transactionHash":candidate,"blockNumber":canonical["number"],"blockHash":canonical["hash"],
                    "status":"0x1","logs":[transfer(operation,actual)]},
                "canonicalBlock":canonical,
            },
        })
    }

    fn unused(operation: &PaymentOperation) -> Value {
        let mut value = evidence(operation, Form::EipBytes);
        value.as_object_mut().unwrap().remove("settlement");
        let result = match operation.authorization.as_ref().unwrap() {
            UnsignedAuthorization::Eip3009 { .. } => IEIP3009::authorizationStateCall::abi_encode_returns(&false),
            _ => IPermit2NonceBitmap::nonceBitmapCall::abi_encode_returns(&U256::ZERO),
        };
        value["unusedResult"] = json!(hex::encode_prefixed(result));
        value
    }

    fn verified(operation: &PaymentOperation, evidence: &Value) -> VerifiedResolution {
        verify_evidence(operation.clone(), &evidence.to_string()).unwrap()
    }
    fn unresolved(operation: &PaymentOperation, evidence: &Value) {
        assert!(matches!(verify_evidence(operation.clone(), &evidence.to_string()), Err(Error::PaymentUnresolved)));
    }

    #[test]
    fn all_three_forms_and_both_direct_overloads_settle_once_at_receipt_anchor() {
        for form in FORMS {
            let signed = fixture(form);
            let authority = verified(&signed.operation, &evidence(&signed.operation, form));
            let settled = authority.apply(signed.budget, signed.operation).unwrap();
            let amount = if matches!(form, Form::UptoPermit2) { "1200" } else { "7000" };
            assert_eq!(settled.operation.state, OperationState::Settled);
            assert_eq!(settled.budget.held_atomic, "0");
            assert_eq!(settled.budget.spent_atomic, amount);
            assert!(matches!(&settled.operation.final_proof,
                Some(FinalProof::Settled { finalized_block_number, finalized_block_hash, .. })
                if finalized_block_number == "31" && finalized_block_hash == &B256::repeat_byte(31).to_string()));
            assert_eq!(authority.apply(settled.budget.clone(), settled.operation.clone()).unwrap(), settled);
        }
    }

    #[test]
    fn every_captured_direct_transfer_field_is_required_for_both_overloads() {
        for form in [Form::EipBytes, Form::EipVrs] {
            let signed = fixture(form);
            for index in 0..7 {
                let mut alternate = signed.operation.clone();
                if let Some(UnsignedAuthorization::Eip3009 { from, to, value, valid_after, valid_before, nonce, token, .. }) = &mut alternate.authorization {
                    match index {
                        0 => *from = OTHER.into(), 1 => *to = OTHER.into(), 2 => *value = "6999".into(),
                        3 => *valid_after = "1".into(), 4 => *valid_before = "201".into(),
                        5 => *nonce = B256::repeat_byte(8).to_string(), _ => *token = OTHER.into(),
                    }
                }
                unresolved(&signed.operation, &evidence(&alternate, form));
            }
        }
    }

    #[test]
    fn every_captured_proxy_field_and_upto_sender_is_required() {
        for form in [Form::ExactPermit2, Form::UptoPermit2] {
            let signed = fixture(form);
            for index in 0..9 {
                if index == 8 && matches!(form, Form::ExactPermit2) { continue; }
                let mut alternate = signed.operation.clone();
                if let Some(UnsignedAuthorization::Permit2 { from, permitted, spender, nonce, deadline, witness, .. }) = &mut alternate.authorization {
                    match index {
                        0 => *from = OTHER.into(), 1 => permitted.token = OTHER.into(),
                        2 => permitted.amount = "6999".into(), 3 => *spender = OTHER.into(),
                        4 => *nonce = "1".into(), 5 => *deadline = "201".into(),
                        6 => witness.to = OTHER.into(), 7 => witness.valid_after = "1".into(),
                        _ => witness.facilitator = Some(OTHER.into()),
                    }
                }
                unresolved(&signed.operation, &evidence(&alternate, form));
            }
            if matches!(form, Form::UptoPermit2) {
                let mut raw = evidence(&signed.operation, form);
                raw["settlement"]["transaction"]["from"] = json!(OTHER);
                unresolved(&signed.operation, &raw);
            }
        }
    }

    #[test]
    fn exactly_one_nonremoved_matching_token_transfer_proves_the_actual_amount() {
        let signed = fixture(Form::UptoPermit2);
        for index in 0..9 {
            let mut raw = evidence(&signed.operation, Form::UptoPermit2);
            let log = &mut raw["settlement"]["receipt"]["logs"][0];
            match index {
                0 => log["removed"] = json!(true),
                1 => log["address"] = json!(OTHER),
                2 => log["topics"][1] = json!(B256::ZERO.to_string()),
                3 => log["topics"][2] = json!(B256::ZERO.to_string()),
                4 => *log = transfer(&signed.operation, U256::from(1199)),
                5 => log["data"] = json!("0x00"),
                6 => log["topics"][0] = json!(B256::ZERO.to_string()),
                7 => log["topics"].as_array_mut().unwrap().push(json!(B256::ZERO.to_string())),
                _ => {
                    let duplicate = log.clone();
                    raw["settlement"]["receipt"]["logs"].as_array_mut().unwrap().push(duplicate);
                },
            }
            unresolved(&signed.operation, &raw);
        }
        let mut raw = evidence(&signed.operation, Form::UptoPermit2);
        raw["settlement"]["receipt"]["logs"][0].as_object_mut().unwrap().remove("removed");
        let mut unrelated = transfer(&signed.operation, U256::from(1));
        unrelated["address"] = json!(OTHER);
        raw["settlement"]["receipt"]["logs"].as_array_mut().unwrap().push(unrelated);
        assert!(verify_evidence(signed.operation, &raw.to_string()).is_ok());
    }

    #[test]
    fn actual_upto_amount_is_calldata_and_log_bound_and_cannot_exceed_maximum() {
        let signed = fixture(Form::UptoPermit2);
        for actual in [U256::ZERO, U256::from(7000), U256::from(7001)] {
            let mut raw = evidence(&signed.operation, Form::UptoPermit2);
            raw["settlement"]["transaction"]["input"] = json!(calldata(&signed.operation, Form::UptoPermit2, actual));
            raw["settlement"]["receipt"]["logs"] = json!([transfer(&signed.operation, actual)]);
            if actual <= U256::from(7000) {
                let result = verified(&signed.operation, &raw).apply(signed.budget.clone(), signed.operation.clone()).unwrap();
                assert_eq!(result.budget.spent_atomic, actual.to_string());
            } else { unresolved(&signed.operation, &raw); }
        }
    }

    #[test]
    fn canonical_headers_candidate_transaction_and_receipt_must_cohere() {
        let signed = fixture(Form::EipBytes);
        for (pointer, value) in [
            ("/chainId", json!("0x14a34")),
            ("/canonicalFinalized/hash", json!(B256::ZERO.to_string())),
            ("/canonicalFinalized/number", json!("0x21")),
            ("/canonicalFinalized/timestamp", json!("0xca")),
            ("/recheckedFinalized/hash", json!(B256::ZERO.to_string())),
            ("/recheckedFinalized/number", json!("0x21")),
            ("/recheckedFinalized/timestamp", json!("0xca")),
            ("/finalized/timestamp", json!("0x10000000000000000")),
            ("/settlement/candidate", json!(B256::ZERO.to_string())),
            ("/settlement/transaction/hash", json!(B256::ZERO.to_string())),
            ("/settlement/transaction/blockNumber", json!("0x1e")),
            ("/settlement/transaction/blockHash", json!(B256::ZERO.to_string())),
            ("/settlement/transaction/to", json!(OTHER)),
            ("/settlement/transaction/input", json!("0xdeadbeef")),
            ("/settlement/transaction", Value::Null),
            ("/settlement/receipt", Value::Null),
            ("/settlement/receipt/transactionHash", json!(B256::ZERO.to_string())),
            ("/settlement/receipt/blockNumber", json!("0x1e")),
            ("/settlement/receipt/blockHash", json!(B256::ZERO.to_string())),
            ("/settlement/receipt/status", json!("0x0")),
            ("/settlement/canonicalBlock/hash", json!(B256::ZERO.to_string())),
            ("/settlement/canonicalBlock/number", json!("0x21")),
            ("/settlement/canonicalBlock/timestamp", json!("0xca")),
            ("/settlement/canonicalBlock", Value::Null),
        ] {
            let mut raw = evidence(&signed.operation, Form::EipBytes);
            *raw.pointer_mut(pointer).unwrap() = value;
            unresolved(&signed.operation, &raw);
        }
        let mut raw = evidence(&signed.operation, Form::EipBytes);
        let head = raw["finalized"].clone();
        raw["settlement"]["canonicalBlock"] = head.clone();
        raw["settlement"]["transaction"]["blockNumber"] = head["number"].clone();
        raw["settlement"]["transaction"]["blockHash"] = head["hash"].clone();
        raw["settlement"]["receipt"]["blockNumber"] = head["number"].clone();
        raw["settlement"]["receipt"]["blockHash"] = head["hash"].clone();
        assert!(verify_evidence(signed.operation.clone(), &raw.to_string()).is_ok());
        raw["settlement"]["canonicalBlock"]["timestamp"] = json!("0xc8");
        unresolved(&signed.operation, &raw);
    }

    #[test]
    fn canonical_quantities_are_not_decimal_or_padded_or_out_of_range() {
        for input in ["", "0x", "0x00", "0x01", "0X1", "0xA", "1", "0x-1", "0x+1", "0x 1"] {
            assert_eq!(quantity(input), Err(Error::PaymentUnresolved));
        }
        assert_eq!(quantity("0x0"), Ok(U256::ZERO));
        assert_eq!(quantity(&format!("{:#x}", U256::MAX)), Ok(U256::MAX));
        assert!(quantity(&format!("0x1{}", "0".repeat(64))).is_err());
        let signed = fixture(Form::EipBytes);
        for input in ["0x020", "32", "0x20.0"] {
            let mut raw = evidence(&signed.operation, Form::EipBytes);
            for key in ["finalized", "canonicalFinalized", "recheckedFinalized"] { raw[key]["number"] = json!(input); }
            unresolved(&signed.operation, &raw);
        }
    }

    #[test]
    fn generated_unused_call_codecs_keep_full_width_nonce_words_and_select_the_right_contract() {
        for form in FORMS {
            let signed = fixture(form);
            let plan = reconciliation_plan(signed.operation.clone()).unwrap();
            assert_eq!(plan.chain_id, 8453);
            assert_eq!(plan.expiry, "200");
            let data = bytes(&plan.unused_call.data).unwrap();
            match signed.operation.authorization.as_ref().unwrap() {
                UnsignedAuthorization::Eip3009 { from, nonce, token, .. } => {
                    assert_eq!(&plan.unused_call.to, token);
                    let decoded = IEIP3009::authorizationStateCall::abi_decode_validate(&data).unwrap();
                    assert_eq!(decoded.authorizer, address(from).unwrap());
                    assert_eq!(decoded.nonce, hash(nonce).unwrap());
                },
                _ => {
                    assert_eq!(plan.unused_call.to, format!("{PERMIT2_ADDRESS:#x}"));
                    assert_eq!(data, IPermit2NonceBitmap::nonceBitmapCall::new((address(PAYER).unwrap(), U256::MAX >> 8)).abi_encode());
                    assert!(IPermit2NonceBitmap::nonceBitmapCall::abi_decode_validate(&data).is_ok());
                },
            }
            let serialized = serde_json::to_value(plan).unwrap();
            assert_eq!(serialized["chainId"], 8453);
            assert_eq!(serialized["expiry"], "200");
            assert!(serialized["unusedCall"]["data"].is_string());
        }
    }

    #[test]
    fn expired_unused_requires_strict_finalized_time_and_canonical_false_or_clear_bit() {
        for form in FORMS {
            let signed = fixture(form);
            for timestamp in ["0xc7", "0xc8"] {
                let mut raw = unused(&signed.operation);
                for key in ["finalized", "canonicalFinalized", "recheckedFinalized"] { raw[key]["timestamp"] = json!(timestamp); }
                unresolved(&signed.operation, &raw);
            }
            let raw = unused(&signed.operation);
            let authority = verified(&signed.operation, &raw);
            let released = authority.apply(signed.budget.clone(), signed.operation.clone()).unwrap();
            assert_eq!(released.budget.held_atomic, "0");
            assert_eq!(released.budget.spent_atomic, "0");
            assert!(matches!(&released.operation.final_proof,
                Some(FinalProof::Unpaid { reason: UnpaidReason::ExpiredNonceUnspent, finalized_block_number: Some(number), .. }) if number == "32"));
            assert_eq!(authority.apply(released.budget.clone(), released.operation.clone()).unwrap(), released);
            for result in [json!("0x"), json!("0x00"), json!(false), json!({}), Value::Null] {
                let mut invalid = raw.clone();
                invalid["unusedResult"] = result;
                unresolved(&signed.operation, &invalid);
            }
            let mut used = raw.clone();
            let encoded = if matches!(form, Form::EipBytes | Form::EipVrs) {
                IEIP3009::authorizationStateCall::abi_encode_returns(&true)
            } else {
                IPermit2NonceBitmap::nonceBitmapCall::abi_encode_returns(&(U256::from(1) << 255))
            };
            used["unusedResult"] = json!(hex::encode_prefixed(encoded));
            unresolved(&signed.operation, &used);
        }
        let signed = fixture(Form::EipBytes);
        let mut malformed_bool = unused(&signed.operation);
        malformed_bool["unusedResult"] = json!(hex::encode_prefixed(IPermit2NonceBitmap::nonceBitmapCall::abi_encode_returns(&U256::from(2))));
        unresolved(&signed.operation, &malformed_bool);
        let signed = fixture(Form::UptoPermit2);
        let mut neighbor = unused(&signed.operation);
        neighbor["unusedResult"] = json!(hex::encode_prefixed(IPermit2NonceBitmap::nonceBitmapCall::abi_encode_returns(&(U256::from(1) << 254))));
        assert!(verify_evidence(signed.operation, &neighbor.to_string()).is_ok());
    }

    #[test]
    fn bitmap_low_byte_selects_each_relevant_boundary_bit() {
        for nonce in [0_u64, 1, 255, 256, 257, 511] {
            let mut signed = fixture(Form::UptoPermit2);
            if let Some(UnsignedAuthorization::Permit2 { nonce: stored, .. }) = &mut signed.operation.authorization {
                *stored = nonce.to_string();
            }
            let plan = reconciliation_plan(signed.operation.clone()).unwrap();
            assert_eq!(bytes(&plan.unused_call.data).unwrap(),
                IPermit2NonceBitmap::nonceBitmapCall::new((address(PAYER).unwrap(), U256::from(nonce >> 8))).abi_encode());
            let mut raw = unused(&signed.operation);
            raw["unusedResult"] = json!(hex::encode_prefixed(IPermit2NonceBitmap::nonceBitmapCall::abi_encode_returns(
                &(U256::from(1) << (nonce as usize & 255)))));
            unresolved(&signed.operation, &raw);
            raw["unusedResult"] = json!(hex::encode_prefixed(IPermit2NonceBitmap::nonceBitmapCall::abi_encode_returns(&U256::ZERO)));
            assert!(verify_evidence(signed.operation.clone(), &raw.to_string()).is_ok());
        }
    }

    #[test]
    fn malformed_or_unavailable_settlement_does_not_poison_independent_unused_evidence() {
        for form in FORMS {
            let signed = fixture(form);
            for candidate in [Value::Null, json!({}), json!({"transaction":null}), json!("unavailable"),
                json!({"candidate":"invalid","transaction":null,"receipt":null,"canonicalBlock":null})] {
                let mut raw = unused(&signed.operation);
                raw["settlement"] = candidate;
                assert!(matches!(verified(&signed.operation, &raw).proof,
                    FinalProof::Unpaid { reason: UnpaidReason::ExpiredNonceUnspent, .. }));
            }
            let mut raw = evidence(&signed.operation, form);
            raw["unusedResult"] = json!({"malformed":"ignored when settlement proves payment"});
            assert!(matches!(verified(&signed.operation, &raw).proof, FinalProof::Settled { .. }));
            raw["settlement"]["receipt"]["status"] = json!("0x0");
            raw["unusedResult"] = unused(&signed.operation)["unusedResult"].clone();
            assert!(matches!(verified(&signed.operation, &raw).proof, FinalProof::Unpaid { .. }));
            raw["recheckedFinalized"]["hash"] = json!(B256::ZERO.to_string());
            unresolved(&signed.operation, &raw);
        }
    }

    #[test]
    fn malformed_bounded_json_and_deep_ignored_rpc_fields_fail_closed() {
        let signed = fixture(Form::EipBytes);
        for raw in ["".to_owned(), "{".to_owned(), "null".to_owned(), "[]".to_owned(),
            " ".repeat(protocol::MAX_RPC_JSON_BYTES + 1)] {
            assert!(matches!(verify_evidence(signed.operation.clone(), &raw), Err(Error::PaymentUnresolved)));
        }
        let mut raw = unused(&signed.operation);
        raw["unexpected"] = json!(true);
        unresolved(&signed.operation, &raw);
        let raw = unused(&signed.operation).to_string();
        let nested = format!("{}0{}", "[".repeat(160), "]".repeat(160));
        let deep = raw.replacen("\"finalized\":{", &format!("\"finalized\":{{\"ignored\":{nested},"), 1);
        assert_ne!(deep, raw);
        assert!(matches!(verify_evidence(signed.operation.clone(), &deep), Err(Error::PaymentUnresolved)));
        let mut raw = unused(&signed.operation);
        raw["finalized"]["ignored"] = json!("x".repeat(protocol::MAX_RPC_JSON_BYTES));
        unresolved(&signed.operation, &raw);
    }

    #[test]
    fn operation_digest_rejects_forged_and_wrong_identity_terms_or_authorization() {
        let signed = fixture(Form::EipBytes);
        let authority = verified(&signed.operation, &evidence(&signed.operation, Form::EipBytes));
        let forged = VerifiedResolution { binding: B256::ZERO, proof: authority.proof.clone() };
        assert_eq!(forged.apply(signed.budget.clone(), signed.operation.clone()), Err(Error::OperationConflict));
        for index in 0..11 {
            let mut changed = signed.clone();
            match index {
                0 => { changed.operation.owner_id = "other".into(); changed.budget.owner_id = "other".into(); },
                1 => { changed.operation.budget_id = "other".into(); changed.budget.budget_id = "other".into(); },
                2 => changed.operation.agent_id = "other".into(),
                3 => changed.operation.operation_id = "other".into(),
                4 => {
                    changed.operation.request_fingerprint = "cd".repeat(32);
                    changed.operation.terms.as_mut().unwrap().request_fingerprint = "cd".repeat(32);
                },
                5 => changed.operation.target_origin = "https://other.example".into(),
                6 => changed.operation.terms.as_mut().unwrap().requirements.max_timeout_seconds = 99,
                7 => {
                    if let Some(UnsignedAuthorization::Eip3009 { nonce, .. }) = &mut changed.operation.authorization {
                        *nonce = B256::repeat_byte(8).to_string();
                    }
                },
                8 => {
                    changed.operation.terms.as_mut().unwrap().maximum_atomic = "6999".into();
                    changed.operation.terms.as_mut().unwrap().requirements.amount = "6999".into();
                    if let Some(UnsignedAuthorization::Eip3009 { value, .. }) = &mut changed.operation.authorization { *value = "6999".into(); }
                },
                9 => {
                    changed.budget.payer = OTHER.into();
                    changed.operation.payer = OTHER.into();
                    changed.operation.terms.as_mut().unwrap().payer = OTHER.into();
                    if let Some(UnsignedAuthorization::Eip3009 { from, .. }) = &mut changed.operation.authorization { *from = OTHER.into(); }
                },
                _ => {
                    let config = network_config(BaseNetwork::Sepolia);
                    changed.budget.network = BaseNetwork::Sepolia;
                    changed.operation.network = BaseNetwork::Sepolia;
                    let terms = changed.operation.terms.as_mut().unwrap();
                    terms.network = BaseNetwork::Sepolia;
                    terms.asset = config.asset.into();
                    terms.requirements.network = BaseNetwork::Sepolia;
                    terms.requirements.asset = config.asset.into();
                    terms.requirements.extra.name = Some(config.name.into());
                    if let Some(UnsignedAuthorization::Eip3009 { token, chain_id, .. }) = &mut changed.operation.authorization {
                        *token = config.asset.into();
                        *chain_id = config.chain_id.to_string();
                    }
                },
            }
            assert_eq!(authority.apply(changed.budget, changed.operation), Err(Error::OperationConflict));
        }
        let unknown = state::transition(signed.budget.clone(), signed.operation.clone(),
            Action::Failure { code: Error::AuthorizationFailed }).unwrap();
        assert!(authority.apply(unknown.budget, unknown.operation).is_ok());
    }

    #[test]
    fn conflicting_terminal_resolutions_reject_without_changing_the_final_ledger() {
        let signed = fixture(Form::UptoPermit2);
        let settled = verified(&signed.operation, &evidence(&signed.operation, Form::UptoPermit2));
        let unpaid = verified(&signed.operation, &unused(&signed.operation));
        let paid = settled.apply(signed.budget.clone(), signed.operation.clone()).unwrap();
        assert_eq!(unpaid.apply(paid.budget.clone(), paid.operation.clone()), Err(Error::OperationConflict));
        assert_eq!(settled.apply(paid.budget.clone(), paid.operation.clone()).unwrap(), paid);
        let released = unpaid.apply(signed.budget, signed.operation).unwrap();
        assert_eq!(settled.apply(released.budget.clone(), released.operation.clone()), Err(Error::OperationConflict));
        assert_eq!(unpaid.apply(released.budget.clone(), released.operation.clone()).unwrap(), released);
    }

    #[test]
    fn full_width_money_and_block_numbers_are_not_truncated_to_machine_integers() {
        let mut signed = fixture(Form::EipBytes);
        let max = U256::MAX.to_string();
        signed.budget.limit_atomic = max.clone();
        signed.budget.held_atomic = max.clone();
        signed.operation.terms.as_mut().unwrap().maximum_atomic = max.clone();
        signed.operation.terms.as_mut().unwrap().requirements.amount = max.clone();
        if let Some(UnsignedAuthorization::Eip3009 { value, .. }) = &mut signed.operation.authorization { *value = max.clone(); }
        let mut raw = evidence(&signed.operation, Form::EipBytes);
        let number = format!("{:#x}", U256::MAX);
        for key in ["finalized", "canonicalFinalized", "recheckedFinalized"] { raw[key]["number"] = json!(number); }
        let head = raw["finalized"].clone();
        raw["settlement"]["canonicalBlock"] = head.clone();
        raw["settlement"]["transaction"]["blockNumber"] = head["number"].clone();
        raw["settlement"]["transaction"]["blockHash"] = head["hash"].clone();
        raw["settlement"]["receipt"]["blockNumber"] = head["number"].clone();
        raw["settlement"]["receipt"]["blockHash"] = head["hash"].clone();
        let result = verified(&signed.operation, &raw).apply(signed.budget, signed.operation).unwrap();
        assert_eq!(result.budget.held_atomic, "0");
        assert_eq!(result.budget.spent_atomic, max);
        assert!(matches!(result.operation.final_proof, Some(FinalProof::Settled { finalized_block_number, .. }) if finalized_block_number == max));
    }

    #[test]
    fn persisted_financial_fields_are_revalidated_before_plan_or_evidence() {
        let signed = fixture(Form::UptoPermit2);
        for index in 0..8 {
            let mut operation = signed.operation.clone();
            match index {
                0 => operation.terms.as_mut().unwrap().asset = OTHER.into(),
                1 => operation.terms.as_mut().unwrap().requirements.extra.facilitator_address = Some(OTHER.into()),
                2 => operation.terms.as_mut().unwrap().requirements.extra.name = Some("wrong domain".into()),
                3 => operation.terms.as_mut().unwrap().maximum_atomic = "07000".into(),
                4 => operation.state = OperationState::Requesting,
                5 => operation.state = OperationState::Settled,
                6 => operation.authorization = None,
                _ => {
                    if let Some(UnsignedAuthorization::Permit2 { chain_id, .. }) = &mut operation.authorization { *chain_id = "84532".into(); }
                },
            }
            assert!(matches!(reconciliation_plan(operation.clone()), Err(Error::PaymentUnresolved)));
            assert!(matches!(verify_evidence(operation, &unused(&signed.operation).to_string()), Err(Error::PaymentUnresolved)));
        }
    }
}
