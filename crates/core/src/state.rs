use crate::model::*;

pub use crate::model::authorization_key;

fn require(condition: bool) -> Result<()> {
    if condition { Ok(()) } else { Err(Error::OperationConflict) }
}

pub fn new_operation(budget: &BudgetSnapshot, input: StartInput) -> Result<PaymentOperation> {
    check_budget(budget)?;
    validate_id(&input.owner_id)?;
    validate_id(&input.budget_id)?;
    validate_id(&input.agent_id)?;
    validate_id(&input.operation_id)?;
    require(input.owner_id == budget.owner_id && input.budget_id == budget.budget_id)?;
    validate_fingerprint(&input.request_fingerprint)?;
    check_origin(budget.network, &input.target_origin)?;
    Ok(PaymentOperation {
        owner_id: input.owner_id, budget_id: input.budget_id, agent_id: input.agent_id, operation_id: input.operation_id,
        request_fingerprint: input.request_fingerprint,
        target_origin: input.target_origin,
        network: budget.network, payer: normalize_address(&budget.payer)?, state: OperationState::Requesting,
        terms: None, authorization: None, report: None, transaction_hash: None,
        final_amount_atomic: None, final_proof: None, last_error_code: None,
    })
}

pub fn check_start(existing: &PaymentOperation, candidate: &PaymentOperation) -> Result<()> {
    require(existing.owner_id == candidate.owner_id && existing.budget_id == candidate.budget_id
        && existing.agent_id == candidate.agent_id && existing.operation_id == candidate.operation_id
        && existing.request_fingerprint == candidate.request_fingerprint && existing.target_origin == candidate.target_origin
        && existing.network == candidate.network && existing.payer == candidate.payer)?;
    Err(if existing.state.is_terminal() { Error::OperationAlreadyProcessed } else { Error::OperationInProgress })
}

pub fn validate_operation(budget: &BudgetSnapshot, mut operation: PaymentOperation) -> Result<PaymentOperation> {
    check_budget(budget)?;
    validate_id(&operation.owner_id)?;
    validate_id(&operation.budget_id)?;
    validate_id(&operation.agent_id)?;
    validate_id(&operation.operation_id)?;
    validate_fingerprint(&operation.request_fingerprint)?;
    check_origin(operation.network, &operation.target_origin)?;
    normalize_owned_address(&mut operation.payer)?;
    require(operation.owner_id == budget.owner_id && operation.budget_id == budget.budget_id
        && operation.network == budget.network && operation.payer.eq_ignore_ascii_case(&budget.payer))?;
    if let Some(terms) = operation.terms.take() { operation.terms = Some(normalize_terms(&operation, terms)?); }
    if let Some(authorization) = operation.authorization.take() {
        require(operation.terms.is_some())?;
        operation.authorization = Some(normalize_authorization(operation.network, authorization, operation.terms.as_ref())?);
    }
    if let Some(report) = operation.report.take() {
        validate_stored_report(&report)?;
        operation.report = Some(normalize_report(report));
    }
    if let Some(hash) = operation.transaction_hash.take() { operation.transaction_hash = Some(normalize_hash(&hash)?); }
    if let Some(amount) = &operation.final_amount_atomic { parse_uint(amount)?; }
    if let Some(proof) = operation.final_proof.take() { operation.final_proof = Some(normalize_final_proof(proof)?); }

    match operation.state {
        OperationState::Requesting => require(operation.terms.is_none() && operation.authorization.is_none()
            && operation.report.is_none() && operation.transaction_hash.is_none())?,
        OperationState::Signing | OperationState::Submitted => require(operation.terms.is_some() && operation.authorization.is_some()
            && operation.report.is_none() && operation.transaction_hash.is_none())?,
        OperationState::Reported | OperationState::Unknown | OperationState::Settled => {
            require(operation.terms.is_some() && operation.authorization.is_some())?;
        },
        OperationState::Unpaid => {},
    }
    if !operation.state.is_terminal() {
        require(operation.final_proof.is_none() && operation.final_amount_atomic.is_none())?;
        if let Some(terms) = &operation.terms {
            require(parse_uint(&budget.held_atomic)? >= parse_uint(&terms.maximum_atomic)?)?;
        }
    } else {
        match (&operation.state, &operation.final_proof) {
            (OperationState::Settled, Some(FinalProof::Settled { transaction_hash, amount_atomic, .. })) => {
                let terms = operation.terms.as_ref().ok_or(Error::OperationConflict)?;
                require(operation.final_amount_atomic.as_ref() == Some(amount_atomic)
                    && operation.transaction_hash.as_ref() == Some(transaction_hash))?;
                check_final_amount(terms, amount_atomic)?;
                require(parse_uint(&budget.spent_atomic)? >= parse_uint(amount_atomic)?)?;
            },
            (OperationState::Unpaid, Some(FinalProof::Unpaid { reason, .. })) => {
                require(operation.final_amount_atomic.is_none())?;
                match reason {
                    UnpaidReason::NoAuthorizationCreated => require(operation.terms.is_none() && operation.authorization.is_none()
                        && operation.report.is_none() && operation.transaction_hash.is_none())?,
                    UnpaidReason::ExpiredNonceUnspent => require(operation.terms.is_some() && operation.authorization.is_some())?,
                }
            },
            _ => return Err(Error::OperationConflict),
        }
    }
    if operation.state == OperationState::Reported {
        require(operation.report.as_ref().is_some_and(|report| coherent_report(report, &operation)))?;
    }
    Ok(operation)
}

pub fn begin_signing(budget: BudgetSnapshot, operation: PaymentOperation, terms: Terms, authorization: UnsignedAuthorization) -> Result<Transition> {
    let mut budget = validate_budget(budget)?;
    let mut operation = validate_operation(&budget, operation)?;
    if operation.state.is_terminal() { return Err(Error::OperationAlreadyProcessed); }
    require(operation.state == OperationState::Requesting)?;
    let terms = normalize_terms(&operation, terms)?;
    let authorization = normalize_authorization(operation.network, authorization, Some(&terms))?;
    let held = parse_uint(&budget.held_atomic)?.checked_add(parse_uint(&terms.maximum_atomic)?)
        .ok_or(Error::BudgetExceeded)?;
    let committed = held.checked_add(parse_uint(&budget.spent_atomic)?).ok_or(Error::BudgetExceeded)?;
    if committed > parse_uint(&budget.limit_atomic)? { return Err(Error::BudgetExceeded); }
    budget.held_atomic = held.to_string();
    operation.terms = Some(terms);
    operation.authorization = Some(authorization);
    operation.state = OperationState::Signing;
    Ok(Transition { budget, operation })
}

pub fn transition(budget: BudgetSnapshot, operation: PaymentOperation, action: Action) -> Result<Transition> {
    let budget = validate_budget(budget)?;
    let mut operation = validate_operation(&budget, operation)?;
    if operation.state.is_terminal() && matches!(action, Action::Report { .. } | Action::Failure { .. }) {
        return Ok(Transition { budget, operation });
    }
    match action {
        Action::Submitted {} => {
            if operation.state.is_terminal() { return Err(Error::OperationAlreadyProcessed); }
            require(operation.state == OperationState::Signing)?;
            operation.state = OperationState::Submitted;
        },
        Action::Report { report, outcome } => {
            require(matches!(operation.state, OperationState::Submitted | OperationState::Reported | OperationState::Unknown))?;
            let report = normalize_report(report);
            if let ReceiptRead::Reported { receipt } = &report {
                if !receipt.transaction.is_empty() { operation.transaction_hash = Some(receipt.transaction.clone()); }
            }
            operation.state = if outcome == ReportOutcome::Received && coherent_report(&report, &operation) {
                OperationState::Reported
            } else {
                operation.last_error_code = Some(Error::PaymentUnresolved);
                OperationState::Unknown
            };
            operation.report = Some(report);
        },
        Action::Failure { code } => {
            operation.last_error_code = Some(code);
            if operation.authorization.is_some() { operation.state = OperationState::Unknown; }
        },
        Action::CloseUnsigned {} => {
            if operation.state == OperationState::Unpaid && matches!(operation.final_proof,
                Some(FinalProof::Unpaid { reason: UnpaidReason::NoAuthorizationCreated, .. })) {
                return Ok(Transition { budget, operation });
            }
            if operation.authorization.is_some() || operation.terms.is_some() { return Err(Error::PaymentUnresolved); }
            require(operation.state == OperationState::Requesting)?;
            operation.state = OperationState::Unpaid;
            operation.final_proof = Some(FinalProof::Unpaid {
                reason: UnpaidReason::NoAuthorizationCreated, finalized_block_number: None, finalized_block_hash: None,
            });
        },
    }
    Ok(Transition { budget, operation })
}

fn check_final_amount(terms: &Terms, amount: &str) -> Result<()> {
    require(parse_uint(amount)? <= parse_uint(&terms.maximum_atomic)?
        && (terms.requirements.scheme != Scheme::Exact || amount == terms.maximum_atomic))
}

pub(crate) fn apply_final_resolution(budget: BudgetSnapshot, operation: PaymentOperation, proof: FinalProof) -> Result<Transition> {
    let mut budget = validate_budget(budget)?;
    let mut operation = validate_operation(&budget, operation)?;
    let proof = normalize_final_proof(proof)?;
    if operation.state.is_terminal() {
        require(operation.final_proof.as_ref() == Some(&proof))?;
        return Ok(Transition { budget, operation });
    }
    match &proof {
        FinalProof::Settled { transaction_hash, amount_atomic, .. } => {
            let terms = operation.terms.as_ref().ok_or(Error::OperationConflict)?;
            require(operation.authorization.is_some())?;
            check_final_amount(terms, amount_atomic)?;
            let held = parse_uint(&budget.held_atomic)?.checked_sub(parse_uint(&terms.maximum_atomic)?)
                .ok_or(Error::OperationConflict)?;
            let spent = parse_uint(&budget.spent_atomic)?.checked_add(parse_uint(amount_atomic)?)
                .ok_or(Error::OperationConflict)?;
            require(held.checked_add(spent).is_some_and(|total| parse_uint(&budget.limit_atomic).is_ok_and(|limit| total <= limit)))?;
            budget.held_atomic = held.to_string();
            budget.spent_atomic = spent.to_string();
            operation.state = OperationState::Settled;
            operation.final_amount_atomic = Some(amount_atomic.clone());
            operation.transaction_hash = Some(transaction_hash.clone());
        },
        FinalProof::Unpaid { reason: UnpaidReason::NoAuthorizationCreated, .. } => {
            require(operation.state == OperationState::Requesting && operation.terms.is_none() && operation.authorization.is_none())?;
            operation.state = OperationState::Unpaid;
        },
        FinalProof::Unpaid { reason: UnpaidReason::ExpiredNonceUnspent, .. } => {
            let terms = operation.terms.as_ref().ok_or(Error::OperationConflict)?;
            require(operation.authorization.is_some())?;
            budget.held_atomic = parse_uint(&budget.held_atomic)?.checked_sub(parse_uint(&terms.maximum_atomic)?)
                .ok_or(Error::OperationConflict)?.to_string();
            operation.state = OperationState::Unpaid;
        },
    }
    operation.final_proof = Some(proof);
    Ok(Transition { budget, operation })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::U256;
    use proptest::prelude::*;
    use x402_chain_eip155::chain::permit2::{EXACT_PERMIT2_PROXY_ADDRESS, UPTO_PERMIT2_PROXY_ADDRESS};

    const PAYER: &str = "0x1111111111111111111111111111111111111111";
    const PAYEE: &str = "0x2222222222222222222222222222222222222222";
    const FACILITATOR: &str = "0x3333333333333333333333333333333333333333";

    fn initial(limit: &str) -> Transition {
        let budget = normalize_budget(BudgetInput { owner_id: "owner".into(), budget_id: "budget".into(),
            network: BaseNetwork::Base, payer: PAYER.into(), limit_atomic: limit.into() }).unwrap();
        let operation = new_operation(&budget, StartInput { owner_id: "owner".into(), budget_id: "budget".into(),
            agent_id: "agent".into(), operation_id: "purchase".into(), request_fingerprint: "a".repeat(64),
            target_origin: "https://merchant.example".into() }).unwrap();
        Transition { budget, operation }
    }
    fn terms(operation: &PaymentOperation, maximum: &str, scheme: Scheme, method: AssetTransferMethod) -> Terms {
        let config = network_config(operation.network);
        Terms { maximum_atomic: maximum.into(), request_fingerprint: operation.request_fingerprint.clone(),
            payer: operation.payer.clone(), network: operation.network, asset: config.asset.into(), pay_to: PAYEE.into(),
            requirements: Requirements { scheme, network: operation.network, asset: config.asset.into(), amount: maximum.into(),
                pay_to: PAYEE.into(), max_timeout_seconds: 300,
                extra: RequirementsExtra { asset_transfer_method: method, payment_flow: PaymentFlow::Authorization,
                    name: Some(config.name.into()), version: Some(config.version.into()),
                    facilitator_address: (scheme == Scheme::Upto).then(|| FACILITATOR.into()) } } }
    }
    fn authorization(terms: &Terms) -> UnsignedAuthorization {
        let chain_id = network_config(terms.network).chain_id.to_string();
        match terms.requirements.extra.asset_transfer_method {
            AssetTransferMethod::Eip3009 => UnsignedAuthorization::Eip3009 { from: terms.payer.clone(), to: terms.pay_to.clone(),
                value: terms.maximum_atomic.clone(), valid_after: "0".into(), valid_before: "1000".into(),
                nonce: format!("0x{}", "a".repeat(64)), token: terms.asset.clone(), chain_id },
            AssetTransferMethod::Permit2 => UnsignedAuthorization::Permit2 { scheme: terms.requirements.scheme,
                from: terms.payer.clone(), permitted: TokenPermission { token: terms.asset.clone(), amount: terms.maximum_atomic.clone() },
                spender: format!("{:#x}", match terms.requirements.scheme {
                    Scheme::Exact => EXACT_PERMIT2_PROXY_ADDRESS, Scheme::Upto => UPTO_PERMIT2_PROXY_ADDRESS }),
                nonce: "123".into(), deadline: "1000".into(), witness: PermitWitness { to: terms.pay_to.clone(),
                    valid_after: "0".into(), facilitator: terms.requirements.extra.facilitator_address.clone() },
                token: terms.asset.clone(), chain_id },
        }
    }
    fn signing(maximum: &str, scheme: Scheme, method: AssetTransferMethod) -> Transition {
        let start = initial("10000");
        let terms = terms(&start.operation, maximum, scheme, method);
        let authorization = authorization(&terms);
        begin_signing(start.budget, start.operation, terms, authorization).unwrap()
    }
    fn settled(amount: &str) -> FinalProof {
        FinalProof::Settled { transaction_hash: format!("0x{}", "b".repeat(64)), amount_atomic: amount.into(),
            finalized_block_number: "10".into(), finalized_block_hash: format!("0x{}", "c".repeat(64)) }
    }
    fn expired() -> FinalProof {
        FinalProof::Unpaid { reason: UnpaidReason::ExpiredNonceUnspent, finalized_block_number: Some("10".into()),
            finalized_block_hash: Some(format!("0x{}", "c".repeat(64))) }
    }
    fn report(amount: Option<&str>, transaction: &str) -> ReceiptRead {
        ReceiptRead::Reported { receipt: SafeReceipt { success: true, network: "eip155:8453".into(),
            transaction: transaction.into(), payer: Some(PAYER.into()), amount: amount.map(str::to_owned), error_reason: None } }
    }

    #[test]
    fn atomic_begin_signing_and_identity_conflicts() {
        let start = initial("10000");
        let candidate = start.operation.clone();
        assert_eq!(check_start(&start.operation, &candidate), Err(Error::OperationInProgress));
        for field in 0..8 {
            let mut other = candidate.clone();
            match field {
                0 => other.owner_id.push('x'), 1 => other.budget_id.push('x'), 2 => other.agent_id.push('x'),
                3 => other.operation_id.push('x'), 4 => other.request_fingerprint = "b".repeat(64),
                5 => other.target_origin = "https://other.example".into(), 6 => other.network = BaseNetwork::Sepolia,
                _ => other.payer = PAYEE.into(),
            }
            assert_eq!(check_start(&start.operation, &other), Err(Error::OperationConflict));
        }
        let captured_terms = terms(&start.operation, "7000", Scheme::Upto, AssetTransferMethod::Permit2);
        let captured = authorization(&captured_terms);
        let signed = begin_signing(start.budget, start.operation, captured_terms.clone(), captured.clone()).unwrap();
        assert_eq!(signed.operation.state, OperationState::Signing);
        assert_eq!((&signed.budget.held_atomic, &signed.budget.spent_atomic), (&"7000".to_owned(), &"0".to_owned()));
        assert_eq!(signed.operation.terms, Some(captured_terms));
        assert_eq!(signed.operation.authorization, Some(captured));
        let mut competitor = candidate;
        competitor.agent_id = "other-agent".into();
        competitor.operation_id = "other-purchase".into();
        let denied_terms = terms(&competitor, "7000", Scheme::Upto, AssetTransferMethod::Permit2);
        assert_eq!(begin_signing(signed.budget.clone(), competitor.clone(), denied_terms.clone(), authorization(&denied_terms)),
            Err(Error::BudgetExceeded));
        let denied = transition(signed.budget.clone(), competitor, Action::CloseUnsigned {}).unwrap();
        assert_eq!(denied.budget, signed.budget);
        assert_eq!(denied.operation.state, OperationState::Unpaid);
        assert_eq!(check_start(&denied.operation, &denied.operation), Err(Error::OperationAlreadyProcessed));
    }

    #[test]
    fn all_unsigned_forms_are_bound_and_have_permanent_nonce_keys() {
        for (scheme, method) in [(Scheme::Exact, AssetTransferMethod::Eip3009),
            (Scheme::Exact, AssetTransferMethod::Permit2), (Scheme::Upto, AssetTransferMethod::Permit2)] {
            let signed = signing("7000", scheme, method);
            let authorization = signed.operation.authorization.as_ref().unwrap();
            let key = authorization_key(BaseNetwork::Base, authorization).unwrap();
            assert_eq!(key.payer, PAYER);
            assert_eq!(key.contract, if method == AssetTransferMethod::Eip3009 { network_config(BaseNetwork::Base).asset.to_owned() }
                else { format!("{:#x}", x402_chain_eip155::chain::permit2::PERMIT2_ADDRESS) });
            assert!(normalize_authorization(BaseNetwork::Sepolia, authorization.clone(), None).is_err());
            let json = serde_json::to_value(authorization).unwrap();
            assert!(json["chainId"].is_string());
            let mut unknown = json;
            unknown["signature"] = "secret".into();
            assert!(serde_json::from_value::<UnsignedAuthorization>(unknown).is_err());
        }
        let exact = signing("7000", Scheme::Exact, AssetTransferMethod::Permit2);
        let upto = signing("7000", Scheme::Upto, AssetTransferMethod::Permit2);
        assert_eq!(authorization_key(BaseNetwork::Base, exact.operation.authorization.as_ref().unwrap()).unwrap(),
            authorization_key(BaseNetwork::Base, upto.operation.authorization.as_ref().unwrap()).unwrap());
    }

    #[test]
    fn invalid_unsigned_fields_and_terms_never_claim_a_hold() {
        let start = initial("10000");
        let valid_terms = terms(&start.operation, "7000", Scheme::Upto, AssetTransferMethod::Permit2);
        let valid_auth = authorization(&valid_terms);
        for field in 0..11 {
            let mut value = serde_json::to_value(&valid_auth).unwrap();
            match field {
                0 => value["from"] = PAYEE.into(), 1 => value["chainId"] = "84532".into(),
                2 => value["token"] = PAYEE.into(), 3 => value["permitted"]["token"] = PAYEE.into(),
                4 => value["permitted"]["amount"] = "6999".into(), 5 => value["spender"] = PAYEE.into(),
                6 => value["nonce"] = "01".into(), 7 => value["deadline"] = "18446744073709551616".into(),
                8 => value["witness"]["to"] = PAYER.into(), 9 => value["witness"]["validAfter"] = "1".into(),
                _ => value["witness"]["facilitator"] = PAYEE.into(),
            }
            let authorization = serde_json::from_value(value).unwrap();
            assert!(begin_signing(start.budget.clone(), start.operation.clone(), valid_terms.clone(), authorization).is_err());
            assert_eq!(start.budget.held_atomic, "0");
            assert!(start.operation.authorization.is_none());
        }
        for field in 0..9 {
            let mut bad = valid_terms.clone();
            match field {
                0 => bad.maximum_atomic = "0".into(), 1 => bad.requirements.amount = "01".into(),
                2 => bad.requirements.max_timeout_seconds = 301, 3 => bad.requirements.max_timeout_seconds = 0,
                4 => bad.requirements.extra.asset_transfer_method = AssetTransferMethod::Eip3009,
                5 => bad.requirements.extra.name = Some("Other token".into()), 6 => bad.requirements.extra.version = Some("3".into()),
                7 => bad.requirements.extra.facilitator_address = None, _ => bad.request_fingerprint = "b".repeat(64),
            }
            assert!(begin_signing(start.budget.clone(), start.operation.clone(), bad, valid_auth.clone()).is_err());
        }
    }

    #[test]
    fn unsigned_close_cas_cannot_release_an_authorized_hold() {
        let start = initial("10000");
        let closed = transition(start.budget.clone(), start.operation.clone(), Action::CloseUnsigned {}).unwrap();
        assert_eq!(closed.operation.state, OperationState::Unpaid);
        assert_eq!(transition(closed.budget.clone(), closed.operation.clone(), Action::CloseUnsigned {}).unwrap(), closed);
        let terms = terms(&start.operation, "7000", Scheme::Upto, AssetTransferMethod::Permit2);
        assert_eq!(begin_signing(closed.budget, closed.operation, terms.clone(), authorization(&terms)), Err(Error::OperationAlreadyProcessed));
        let signed = begin_signing(start.budget, start.operation, terms.clone(), authorization(&terms)).unwrap();
        assert_eq!(transition(signed.budget.clone(), signed.operation.clone(), Action::CloseUnsigned {}), Err(Error::PaymentUnresolved));
        assert_eq!(signed.budget.held_atomic, "7000");
        assert!(transition(signed.budget.clone(), signed.operation.clone(), Action::Report { report: ReceiptRead::Missing {},
            outcome: ReportOutcome::Received }).is_err());
        let failed = transition(signed.budget, signed.operation, Action::Failure { code: Error::AuthorizationFailed }).unwrap();
        assert_eq!(failed.operation.state, OperationState::Unknown);
        assert_eq!(failed.budget.held_atomic, "7000");
        assert_eq!(transition(failed.budget.clone(), failed.operation.clone(), Action::CloseUnsigned {}), Err(Error::PaymentUnresolved));
    }

    #[test]
    fn reports_do_not_spend_or_release_and_incoherent_reports_become_unknown() {
        let signed = signing("7000", Scheme::Upto, AssetTransferMethod::Permit2);
        let submitted = transition(signed.budget, signed.operation, Action::Submitted {}).unwrap();
        let hash = format!("0x{}", "b".repeat(64));
        for receipt in [ReceiptRead::Missing {}, ReceiptRead::Invalid {}, report(Some("7001"), &hash)] {
            let unknown = transition(submitted.budget.clone(), submitted.operation.clone(), Action::Report {
                report: receipt, outcome: ReportOutcome::Received }).unwrap();
            assert_eq!(unknown.operation.state, OperationState::Unknown);
            assert_eq!(unknown.budget, submitted.budget);
        }
        for receipt in [report(Some("0"), ""), report(Some("1200"), &hash), report(None, &hash)] {
            let reported = transition(submitted.budget.clone(), submitted.operation.clone(), Action::Report {
                report: receipt.clone(), outcome: ReportOutcome::Received }).unwrap();
            assert_eq!(reported.operation.state, OperationState::Reported);
            assert_eq!(reported.budget.held_atomic, "7000");
            assert_eq!(reported.budget.spent_atomic, "0");
            assert!(validate_operation(&reported.budget, reported.operation).is_ok());
            let unknown = transition(submitted.budget.clone(), submitted.operation.clone(), Action::Report {
                report: receipt, outcome: ReportOutcome::TransportFailed }).unwrap();
            assert_eq!(unknown.operation.state, OperationState::Unknown);
            assert_eq!(unknown.budget, submitted.budget);
        }
        let exact = signing("1000", Scheme::Exact, AssetTransferMethod::Eip3009);
        let submitted = transition(exact.budget, exact.operation, Action::Submitted {}).unwrap();
        assert_eq!(transition(submitted.budget, submitted.operation, Action::Report {
            report: report(Some("999"), &hash), outcome: ReportOutcome::Received }).unwrap().operation.state, OperationState::Unknown);
    }

    #[test]
    fn settlement_replaces_whole_hold_once_and_terminals_ignore_late_effects() {
        let signed = signing("7000", Scheme::Upto, AssetTransferMethod::Permit2);
        let final_state = apply_final_resolution(signed.budget, signed.operation, settled("1200")).unwrap();
        assert_eq!(final_state.budget.held_atomic, "0");
        assert_eq!(final_state.budget.spent_atomic, "1200");
        assert_eq!(final_state.operation.state, OperationState::Settled);
        assert!(validate_operation(&final_state.budget, final_state.operation.clone()).is_ok());
        assert_eq!(apply_final_resolution(final_state.budget.clone(), final_state.operation.clone(), settled("1200")).unwrap(), final_state);
        assert_eq!(apply_final_resolution(final_state.budget.clone(), final_state.operation.clone(), settled("1201")), Err(Error::OperationConflict));
        for action in [Action::Failure { code: Error::PaymentUnresolved },
            Action::Report { report: ReceiptRead::Missing {}, outcome: ReportOutcome::TransportFailed }] {
            assert_eq!(transition(final_state.budget.clone(), final_state.operation.clone(), action).unwrap(), final_state);
        }
        assert_eq!(transition(final_state.budget.clone(), final_state.operation.clone(), Action::Submitted {}), Err(Error::OperationAlreadyProcessed));
        let signed = signing("1000", Scheme::Exact, AssetTransferMethod::Eip3009);
        assert_eq!(apply_final_resolution(signed.budget.clone(), signed.operation.clone(), settled("999")), Err(Error::OperationConflict));
        assert_eq!(apply_final_resolution(signed.budget.clone(), signed.operation.clone(), settled("1001")), Err(Error::OperationConflict));
        assert!(apply_final_resolution(signed.budget, signed.operation, settled("1000")).is_ok());
    }

    #[test]
    fn expired_unused_releases_without_spending_and_proof_binding_fields_are_validated() {
        let signed = signing("7000", Scheme::Upto, AssetTransferMethod::Permit2);
        let unpaid = apply_final_resolution(signed.budget, signed.operation, expired()).unwrap();
        assert_eq!((&unpaid.budget.held_atomic, &unpaid.budget.spent_atomic), (&"0".to_owned(), &"0".to_owned()));
        assert_eq!(unpaid.operation.state, OperationState::Unpaid);
        assert_eq!(apply_final_resolution(unpaid.budget.clone(), unpaid.operation.clone(), expired()).unwrap(), unpaid);
        assert!(validate_operation(&unpaid.budget, unpaid.operation.clone()).is_ok());
        assert_eq!(apply_final_resolution(unpaid.budget, unpaid.operation, settled("1200")), Err(Error::OperationConflict));
        let mut forged = initial("10000");
        forged.operation.state = OperationState::Unknown;
        assert!(validate_operation(&forged.budget, forged.operation).is_err());
        let mut forged = signing("7000", Scheme::Upto, AssetTransferMethod::Permit2);
        forged.budget.held_atomic = "6999".into();
        assert!(validate_operation(&forged.budget, forged.operation).is_err());
    }

    #[test]
    fn uint256_capacity_overflow_and_maximum_accounting() {
        let maximum = U256::MAX.to_string();
        let start = initial(&maximum);
        let captured_terms = terms(&start.operation, &maximum, Scheme::Exact, AssetTransferMethod::Eip3009);
        let signed = begin_signing(start.budget, start.operation, captured_terms.clone(), authorization(&captured_terms)).unwrap();
        let done = apply_final_resolution(signed.budget, signed.operation, settled(&maximum)).unwrap();
        assert_eq!(done.budget.spent_atomic, maximum);
        assert_eq!(done.budget.held_atomic, "0");
        let start = initial(&maximum);
        let mut budget = start.budget;
        budget.held_atomic = maximum;
        let terms = terms(&start.operation, "1", Scheme::Exact, AssetTransferMethod::Eip3009);
        assert_eq!(begin_signing(budget, start.operation, terms.clone(), authorization(&terms)), Err(Error::BudgetExceeded));
    }

    #[test]
    fn eip3009_uint64_and_field_boundaries() {
        let start = initial("10000");
        let terms = terms(&start.operation, "1000", Scheme::Exact, AssetTransferMethod::Eip3009);
        let captured = authorization(&terms);
        for field in 0..9 {
            let mut value = serde_json::to_value(&captured).unwrap();
            match field {
                0 => value["from"] = PAYEE.into(), 1 => value["to"] = PAYER.into(),
                2 => value["value"] = "999".into(), 3 => value["validAfter"] = "1".into(),
                4 => value["validBefore"] = "0".into(), 5 => value["validBefore"] = "18446744073709551616".into(),
                6 => value["nonce"] = "123".into(), 7 => value["token"] = PAYEE.into(),
                _ => value["chainId"] = "08453".into(),
            }
            let authorization = serde_json::from_value(value).unwrap();
            assert!(begin_signing(start.budget.clone(), start.operation.clone(), terms.clone(), authorization).is_err());
        }
        let mut value = serde_json::to_value(captured).unwrap();
        value["validBefore"] = u64::MAX.to_string().into();
        assert!(begin_signing(start.budget, start.operation, terms, serde_json::from_value(value).unwrap()).is_ok());
    }

    #[test]
    fn corrupt_persisted_receipts_fail_instead_of_being_sanitized() {
        let signed = signing("7000", Scheme::Upto, AssetTransferMethod::Permit2);
        let mut unknown = transition(signed.budget, signed.operation, Action::Failure { code: Error::PaymentUnresolved }).unwrap();
        let hash = format!("0x{}", "b".repeat(64));
        for field in 0..5 {
            let ReceiptRead::Reported { mut receipt } = report(Some("1200"), &hash) else { panic!("receipt"); };
            match field {
                0 => receipt.error_reason = Some("private diagnostic".into()),
                1 => receipt.amount = Some("01".into()),
                2 => receipt.network = "bad network".into(),
                3 => receipt.transaction = "bad hash".into(),
                _ => receipt.success = false,
            }
            unknown.operation.report = Some(ReceiptRead::Reported { receipt });
            assert!(validate_operation(&unknown.budget, unknown.operation.clone()).is_err());
        }
        unknown.operation.report = Some(ReceiptRead::Invalid {});
        assert!(validate_operation(&unknown.budget, unknown.operation).is_ok());
    }

    proptest! {
        #[test]
        fn authorized_sequences_preserve_money_and_unchanged_errors(
            maximum in 1u64..=10000,
            steps in prop::collection::vec((0u8..8, 0u64..=12000), 0..80),
        ) {
            let mut current = signing(&maximum.to_string(), Scheme::Upto, AssetTransferMethod::Permit2);
            for (action, amount) in steps {
                let before = current.clone();
                let result = match action {
                    0 => transition(current.budget.clone(), current.operation.clone(), Action::Submitted {}),
                    1 => transition(current.budget.clone(), current.operation.clone(), Action::CloseUnsigned {}),
                    2 => transition(current.budget.clone(), current.operation.clone(), Action::Failure { code: Error::RequestAborted }),
                    3 => transition(current.budget.clone(), current.operation.clone(), Action::Report {
                        report: report(Some(&amount.to_string()), &format!("0x{}", "b".repeat(64))), outcome: ReportOutcome::Received }),
                    4 => transition(current.budget.clone(), current.operation.clone(), Action::Report {
                        report: ReceiptRead::Missing {}, outcome: ReportOutcome::TransportFailed }),
                    5 => apply_final_resolution(current.budget.clone(), current.operation.clone(), expired()),
                    _ => apply_final_resolution(current.budget.clone(), current.operation.clone(), settled(&amount.to_string())),
                };
                match result {
                    Ok(next) => {
                        prop_assert!(validate_budget(next.budget.clone()).is_ok());
                        prop_assert!(validate_operation(&next.budget, next.operation.clone()).is_ok());
                        if before.operation.state.is_terminal() { prop_assert_eq!(&next, &before); }
                        let held = parse_uint(&next.budget.held_atomic).unwrap();
                        let spent = parse_uint(&next.budget.spent_atomic).unwrap();
                        prop_assert!(held.checked_add(spent).unwrap() <= U256::from(10000u64));
                        if !next.operation.state.is_terminal() {
                            prop_assert_eq!(held, U256::from(maximum));
                            prop_assert_eq!(spent, U256::ZERO);
                        }
                        current = next;
                    },
                    Err(_) => prop_assert_eq!(&current, &before),
                }
            }
        }

        #[test]
        fn upto_resolution_conserves_existing_balances(maximum in 1u64..5000, actual_seed in any::<u64>(), prior in 0u64..5000) {
            let actual = actual_seed % (maximum + 1);
            let mut start = initial("10000");
            start.budget.spent_atomic = prior.to_string();
            let terms = terms(&start.operation, &maximum.to_string(), Scheme::Upto, AssetTransferMethod::Permit2);
            let signed = begin_signing(start.budget, start.operation, terms.clone(), authorization(&terms)).unwrap();
            let final_state = apply_final_resolution(signed.budget, signed.operation, settled(&actual.to_string())).unwrap();
            prop_assert_eq!(final_state.budget.held_atomic, "0");
            prop_assert_eq!(parse_uint(&final_state.budget.spent_atomic).unwrap(), U256::from(prior + actual));
        }
    }
}
