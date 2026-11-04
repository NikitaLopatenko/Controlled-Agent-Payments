-- Adapted from UBB's Apache-2.0 payment schema; see NOTICE.
CREATE SCHEMA cap_payments;

CREATE TABLE cap_payments.schema_version (
  singleton boolean NOT NULL,
  version integer NOT NULL,
  CONSTRAINT cap_schema_version_pkey PRIMARY KEY (singleton),
  CONSTRAINT cap_schema_version_singleton_check CHECK (singleton),
  CONSTRAINT cap_schema_version_version_check CHECK (version = 1)
);
INSERT INTO cap_payments.schema_version (singleton, version) VALUES (true, 1);

CREATE TABLE cap_payments.budgets (
  owner_id text COLLATE "C" NOT NULL,
  budget_id text COLLATE "C" NOT NULL,
  network text COLLATE "C" NOT NULL,
  payer text COLLATE "C" NOT NULL,
  limit_atomic numeric(78,0) NOT NULL,
  held_atomic numeric(78,0) NOT NULL,
  spent_atomic numeric(78,0) NOT NULL,
  CONSTRAINT cap_budgets_pkey PRIMARY KEY (owner_id, budget_id),
  CONSTRAINT cap_budgets_network_check CHECK (network = 'eip155:8453' OR network = 'eip155:84532'),
  CONSTRAINT cap_budgets_payer_check CHECK (payer ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT cap_budgets_payer_nonzero_check CHECK (payer <> '0x0000000000000000000000000000000000000000'),
  CONSTRAINT cap_budgets_limit_atomic_check CHECK (limit_atomic >= 0 AND limit_atomic <= 115792089237316195423570985008687907853269984665640564039457584007913129639935),
  CONSTRAINT cap_budgets_held_atomic_check CHECK (held_atomic >= 0 AND held_atomic <= 115792089237316195423570985008687907853269984665640564039457584007913129639935),
  CONSTRAINT cap_budgets_spent_atomic_check CHECK (spent_atomic >= 0 AND spent_atomic <= 115792089237316195423570985008687907853269984665640564039457584007913129639935),
  CONSTRAINT cap_budgets_available_check CHECK (spent_atomic + held_atomic <= limit_atomic)
);

CREATE TABLE cap_payments.operations (
  owner_id text COLLATE "C" NOT NULL,
  budget_id text COLLATE "C" NOT NULL,
  operation_id text COLLATE "C" NOT NULL,
  agent_id text COLLATE "C" NOT NULL,
  request_fingerprint text COLLATE "C" NOT NULL,
  target_origin text COLLATE "C" NOT NULL,
  network text COLLATE "C" NOT NULL,
  payer text COLLATE "C" NOT NULL,
  state text COLLATE "C" NOT NULL,
  payload jsonb NOT NULL,
  authorization_contract text COLLATE "C",
  authorization_nonce text COLLATE "C",
  CONSTRAINT cap_operations_pkey PRIMARY KEY (owner_id, budget_id, operation_id),
  CONSTRAINT cap_operations_budget_fkey FOREIGN KEY (owner_id, budget_id) REFERENCES cap_payments.budgets (owner_id, budget_id),
  CONSTRAINT cap_operations_authorization_namespace_key UNIQUE (network, authorization_contract, payer, authorization_nonce),
  CONSTRAINT cap_operations_network_check CHECK (network = 'eip155:8453' OR network = 'eip155:84532'),
  CONSTRAINT cap_operations_payer_check CHECK (payer ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT cap_operations_payer_nonzero_check CHECK (payer <> '0x0000000000000000000000000000000000000000'),
  CONSTRAINT cap_operations_state_check CHECK (state = 'requesting' OR state = 'signing' OR state = 'submitted' OR state = 'reported' OR state = 'unknown' OR state = 'settled' OR state = 'unpaid'),
  CONSTRAINT cap_operations_payload_object_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT cap_operations_payload_identity_check CHECK (payload @> jsonb_build_object('ownerId', owner_id, 'budgetId', budget_id, 'operationId', operation_id, 'agentId', agent_id, 'requestFingerprint', request_fingerprint, 'targetOrigin', target_origin, 'network', network, 'payer', payer, 'state', state)),
  CONSTRAINT cap_operations_authorization_contract_check CHECK (authorization_contract ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT cap_operations_authorization_nonce_check CHECK (authorization_nonce ~ '^(0x[0-9a-f]{64}|0|[1-9][0-9]*)$'),
  CONSTRAINT cap_operations_authorization_pair_check CHECK ((authorization_contract IS NULL) = (authorization_nonce IS NULL))
);
