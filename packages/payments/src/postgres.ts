// Adapted from UBB's Apache-2.0 PostgreSQL adapter; see NOTICE.
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { PaymentError, paymentStateForOperation } from './errors.js';
import {
  authorizationKey, checkStart, nativeTransition, newOperation, normalizeBudget, normalizeBudgetKey,
  normalizeContext, normalizeOperationKey, registerStore, validateBudget, validateOperation,
} from './internal.js';
import type { StartInput, StoreAction } from './internal.js';
import type { BudgetInput, BudgetKey, BudgetSnapshot, BudgetStore, OperationKey, PaymentOperation } from './types.js';

const namespaceConstraint = 'cap_operations_authorization_namespace_key';
const budgetColumns = 'owner_id, budget_id, network, payer, limit_atomic::text, held_atomic::text, spent_atomic::text';
const operationColumns = 'owner_id, budget_id, operation_id, agent_id, request_fingerprint, target_origin, network, payer, state, payload::text, authorization_contract, authorization_nonce';
type PoolAccess = Pick<Pool, 'query' | 'connect'>;
type BudgetRow = {
  owner_id: string; budget_id: string; network: BudgetSnapshot['network']; payer: BudgetSnapshot['payer'];
  limit_atomic: string; held_atomic: string; spent_atomic: string;
};
type OperationRow = {
  owner_id: string; budget_id: string; operation_id: string; agent_id: string;
  request_fingerprint: string; target_origin: string; network: PaymentOperation['network'];
  payer: PaymentOperation['payer']; state: PaymentOperation['state']; payload: string;
  authorization_contract: string | null; authorization_nonce: string | null;
};
type JoinedOperationRow = OperationRow & {
  budget_owner_id: string; budget_budget_id: string; budget_network: BudgetSnapshot['network'];
  budget_payer: BudgetSnapshot['payer']; limit_atomic: string; held_atomic: string; spent_atomic: string;
};

function capturePool(pool: Pool): PoolAccess {
  try {
    if (pool === null || typeof pool !== 'object' || Array.isArray(pool) ||
      typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new Error();
    return { query: pool.query.bind(pool), connect: pool.connect.bind(pool) };
  } catch { throw new PaymentError('invalid_config'); }
}

function databaseError(error: unknown): PaymentError {
  try {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505' &&
      'constraint' in error && error.constraint === namespaceConstraint) return new PaymentError('operation_conflict');
  } catch {}
  return new PaymentError('storage_unavailable');
}

function safeError(error: unknown): PaymentError {
  return error instanceof PaymentError ? new PaymentError(error.code, {
    paymentState: error.paymentState, operationId: error.operationId, transactionHash: error.transactionHash,
  }) : new PaymentError('storage_unavailable');
}

async function query<Row extends QueryResultRow = QueryResultRow>(client: Pick<Pool, 'query'>,
  text: string, values?: unknown[]): Promise<QueryResult<Row>> {
  try { return await client.query<Row>(text, values); }
  catch (error) { throw databaseError(error); }
}

async function transaction<T>(pool: PoolAccess, action: (client: Pick<PoolClient, 'query'>) => Promise<T>): Promise<T> {
  let client: Pick<PoolClient, 'query'> | undefined, release: PoolClient['release'] | undefined;
  let result: T | undefined, failure: PaymentError | undefined;
  let discardClient = false;
  try {
    try {
      const acquired = await pool.connect();
      if (acquired === null || typeof acquired !== 'object' || Array.isArray(acquired)) throw new Error();
      if (typeof acquired.release === 'function') release = acquired.release.bind(acquired);
      if (typeof acquired.query !== 'function' || release === undefined) throw new Error();
      client = { query: acquired.query.bind(acquired) };
    } catch (error) { throw databaseError(error); }
    await query(client, 'BEGIN');
    result = await action(client);
    await query(client, 'COMMIT');
  } catch (error) {
    failure = safeError(error);
    if (client) { try { await query(client, 'ROLLBACK'); } catch { discardClient = true; } }
  } finally {
    if (release !== undefined) { try { release(discardClient); } catch { failure ??= new PaymentError('storage_unavailable'); } }
  }
  if (failure !== undefined) throw failure;
  return result as T;
}

function budgetFromRow(row: BudgetRow, key: BudgetKey): BudgetSnapshot {
  const budget = validateBudget({ ownerId: row.owner_id, budgetId: row.budget_id, network: row.network, payer: row.payer,
    limitAtomic: row.limit_atomic, heldAtomic: row.held_atomic, spentAtomic: row.spent_atomic });
  if (budget.ownerId !== key.ownerId || budget.budgetId !== key.budgetId || budget.payer !== row.payer) {
    throw new PaymentError('storage_unavailable');
  }
  return budget;
}

function operationFromRow(row: OperationRow, budget: BudgetSnapshot, key: OperationKey): PaymentOperation {
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    const stored = parsed as PaymentOperation;
    if (stored.ownerId !== row.owner_id || stored.budgetId !== row.budget_id || stored.operationId !== row.operation_id ||
      stored.agentId !== row.agent_id || stored.requestFingerprint !== row.request_fingerprint ||
      stored.targetOrigin !== row.target_origin || stored.network !== row.network || stored.payer !== row.payer ||
      stored.state !== row.state || stored.ownerId !== key.ownerId || stored.budgetId !== key.budgetId ||
      stored.operationId !== key.operationId) throw new Error();
    const operation = validateOperation(budget, parsed);
    const namespace = operation.authorization === undefined ? null : authorizationKey(operation.network, operation.authorization);
    if ((namespace?.contract ?? null) !== row.authorization_contract || (namespace?.nonce ?? null) !== row.authorization_nonce ||
      (namespace !== null && namespace.payer !== row.payer) || operation.payer !== row.payer) throw new Error();
    return operation;
  } catch { throw new PaymentError('storage_unavailable'); }
}

async function lockBudget(client: Pick<PoolClient, 'query'>, key: BudgetKey): Promise<BudgetSnapshot> {
  const result = await query<BudgetRow>(client,
    `SELECT ${budgetColumns} FROM cap_payments.budgets WHERE owner_id = $1 AND budget_id = $2 FOR UPDATE`,
    [key.ownerId, key.budgetId]);
  const row = result.rows[0];
  if (row === undefined) throw new PaymentError('operation_conflict');
  return budgetFromRow(row, key);
}

function captureStart(input: StartInput): StartInput {
  try {
    const captured = { ...normalizeContext(input), requestFingerprint: input.requestFingerprint, targetOrigin: input.targetOrigin };
    if (typeof captured.requestFingerprint !== 'string' || typeof captured.targetOrigin !== 'string') throw new Error();
    return captured;
  } catch { throw new PaymentError('invalid_config'); }
}

function captureAction(action: StoreAction): StoreAction {
  try {
    if (action.kind === 'beginSigning') return { kind: 'beginSigning', prepared: action.prepared };
    if (action.kind === 'resolve') return { kind: 'resolve', resolution: action.resolution };
    return structuredClone(action);
  } catch { throw new PaymentError('invalid_config'); }
}

function requireUpdated(rowCount: number | null): void {
  if (rowCount !== 1) throw new PaymentError('operation_conflict');
}

export class PostgresPaymentStore implements BudgetStore {
  #pool: PoolAccess;

  constructor(pool: Pool) {
    this.#pool = capturePool(pool);
    registerStore(this, { start: (input) => this.#start(input), mutate: (key, action) => this.#mutate(key, action) });
  }

  async createBudget(input: BudgetInput): Promise<BudgetSnapshot> {
    const candidate = normalizeBudget(input);
    return transaction(this.#pool, async (client) => {
      await query(client, `INSERT INTO cap_payments.budgets
        (owner_id, budget_id, network, payer, limit_atomic, held_atomic, spent_atomic)
        VALUES ($1, $2, $3, $4, $5, 0, 0) ON CONFLICT (owner_id, budget_id) DO NOTHING`,
      [candidate.ownerId, candidate.budgetId, candidate.network, candidate.payer, candidate.limitAtomic]);
      const budget = await lockBudget(client, candidate);
      if (budget.network !== candidate.network || budget.payer !== candidate.payer || budget.limitAtomic !== candidate.limitAtomic) {
        throw new PaymentError('operation_conflict');
      }
      return budget;
    });
  }

  async #start(input: StartInput): Promise<PaymentOperation> {
    const captured = captureStart(input);
    return transaction(this.#pool, async (client) => {
      const budget = await lockBudget(client, captured), candidate = newOperation(budget, captured);
      const result = await query<OperationRow>(client, `SELECT ${operationColumns} FROM cap_payments.operations
        WHERE owner_id = $1 AND budget_id = $2 AND operation_id = $3 FOR UPDATE`,
      [candidate.ownerId, candidate.budgetId, candidate.operationId]);
      const row = result.rows[0];
      if (row !== undefined) {
        const existing = operationFromRow(row, budget, candidate);
        checkStart(existing, candidate);
        throw new PaymentError('operation_in_progress', { paymentState: paymentStateForOperation(existing),
          operationId: existing.operationId, transactionHash: existing.transactionHash });
      }
      const inserted = await query(client, `INSERT INTO cap_payments.operations
        (owner_id, budget_id, operation_id, agent_id, request_fingerprint, target_origin, network, payer, state, payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [candidate.ownerId, candidate.budgetId, candidate.operationId, candidate.agentId, candidate.requestFingerprint,
        candidate.targetOrigin, candidate.network, candidate.payer, candidate.state, JSON.stringify(candidate)]);
      requireUpdated(inserted.rowCount);
      return candidate;
    });
  }

  async #mutate(input: OperationKey, action: StoreAction): Promise<PaymentOperation> {
    const key = normalizeOperationKey(input), capturedAction = captureAction(action);
    return transaction(this.#pool, async (client) => {
      const budget = await lockBudget(client, key);
      const result = await query<OperationRow>(client, `SELECT ${operationColumns} FROM cap_payments.operations
        WHERE owner_id = $1 AND budget_id = $2 AND operation_id = $3 FOR UPDATE`, [key.ownerId, key.budgetId, key.operationId]);
      const row = result.rows[0];
      if (row === undefined) throw new PaymentError('operation_conflict');
      const current = operationFromRow(row, budget, key), next = nativeTransition(budget, current, capturedAction);
      const namespace = next.operation.authorization === undefined ? null : authorizationKey(next.operation.network, next.operation.authorization);
      if ((namespace !== null && namespace.payer !== next.operation.payer) || (row.authorization_contract !== null &&
        (row.authorization_contract !== namespace?.contract || row.authorization_nonce !== namespace?.nonce))) {
        throw new PaymentError('operation_conflict');
      }
      const updatedBudget = await query(client, `UPDATE cap_payments.budgets SET held_atomic = $3, spent_atomic = $4
        WHERE owner_id = $1 AND budget_id = $2 AND held_atomic = $5 AND spent_atomic = $6`,
      [budget.ownerId, budget.budgetId, next.budget.heldAtomic, next.budget.spentAtomic, budget.heldAtomic, budget.spentAtomic]);
      requireUpdated(updatedBudget.rowCount);
      const updatedOperation = await query(client, `UPDATE cap_payments.operations
        SET state = $4, payload = $5::jsonb, authorization_contract = $6, authorization_nonce = $7
        WHERE owner_id = $1 AND budget_id = $2 AND operation_id = $3 AND state = $8`,
      [current.ownerId, current.budgetId, current.operationId, next.operation.state, JSON.stringify(next.operation),
        namespace?.contract ?? null, namespace?.nonce ?? null, current.state]);
      requireUpdated(updatedOperation.rowCount);
      return next.operation;
    });
  }

  async getBudget(input: BudgetKey): Promise<BudgetSnapshot | null> {
    const key = normalizeBudgetKey(input);
    try {
      const result = await query<BudgetRow>(this.#pool,
        `SELECT ${budgetColumns} FROM cap_payments.budgets WHERE owner_id = $1 AND budget_id = $2`, [key.ownerId, key.budgetId]);
      return result.rows[0] === undefined ? null : budgetFromRow(result.rows[0], key);
    } catch (error) { throw safeError(error); }
  }

  async getOperation(input: OperationKey): Promise<PaymentOperation | null> {
    const key = normalizeOperationKey(input);
    try {
      const result = await query<JoinedOperationRow>(this.#pool, `SELECT
        o.owner_id, o.budget_id, o.operation_id, o.agent_id, o.request_fingerprint, o.target_origin,
        o.network, o.payer, o.state, o.payload::text, o.authorization_contract, o.authorization_nonce,
        b.owner_id AS budget_owner_id, b.budget_id AS budget_budget_id, b.network AS budget_network,
        b.payer AS budget_payer, b.limit_atomic::text, b.held_atomic::text, b.spent_atomic::text
        FROM cap_payments.operations o LEFT JOIN cap_payments.budgets b ON b.owner_id = o.owner_id AND b.budget_id = o.budget_id
        WHERE o.owner_id = $1 AND o.budget_id = $2 AND o.operation_id = $3`, [key.ownerId, key.budgetId, key.operationId]);
      const row = result.rows[0];
      if (row === undefined) return null;
      const budget = budgetFromRow({ owner_id: row.budget_owner_id, budget_id: row.budget_budget_id, network: row.budget_network,
        payer: row.budget_payer, limit_atomic: row.limit_atomic, held_atomic: row.held_atomic, spent_atomic: row.spent_atomic }, key);
      return operationFromRow(row, budget, key);
    } catch (error) { throw safeError(error); }
  }
}

const maximumUint256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
const networkCheck = "network = 'eip155:8453' OR network = 'eip155:84532'";
const payerCheck = "payer ~ '^0x[0-9a-f]{40}$'";
const payerNonzeroCheck = "payer <> '0x0000000000000000000000000000000000000000'";
const expectedColumns: Record<string, readonly (readonly [string, string, boolean])[]> = {
  schema_version: [['singleton', 'boolean', true], ['version', 'integer', true]],
  budgets: [
    ['owner_id', 'text', true], ['budget_id', 'text', true], ['network', 'text', true], ['payer', 'text', true],
    ['limit_atomic', 'numeric(78,0)', true], ['held_atomic', 'numeric(78,0)', true], ['spent_atomic', 'numeric(78,0)', true],
  ],
  operations: [
    ['owner_id', 'text', true], ['budget_id', 'text', true], ['operation_id', 'text', true], ['agent_id', 'text', true],
    ['request_fingerprint', 'text', true], ['target_origin', 'text', true], ['network', 'text', true], ['payer', 'text', true],
    ['state', 'text', true], ['payload', 'jsonb', true], ['authorization_contract', 'text', false], ['authorization_nonce', 'text', false],
  ],
};
type ExpectedConstraint = { table: string; kind: 'p' | 'u' | 'f' | 'c'; columns?: string[]; expression?: string };
const expectedConstraints: Record<string, ExpectedConstraint> = {
  cap_schema_version_pkey: { table: 'schema_version', kind: 'p', columns: ['singleton'] },
  cap_schema_version_singleton_check: { table: 'schema_version', kind: 'c', expression: 'singleton' },
  cap_schema_version_version_check: { table: 'schema_version', kind: 'c', expression: 'version = 1' },
  cap_budgets_pkey: { table: 'budgets', kind: 'p', columns: ['owner_id', 'budget_id'] },
  cap_budgets_network_check: { table: 'budgets', kind: 'c', expression: networkCheck },
  cap_budgets_payer_check: { table: 'budgets', kind: 'c', expression: payerCheck },
  cap_budgets_payer_nonzero_check: { table: 'budgets', kind: 'c', expression: payerNonzeroCheck },
  cap_budgets_available_check: { table: 'budgets', kind: 'c', expression: 'spent_atomic + held_atomic <= limit_atomic' },
  cap_operations_pkey: { table: 'operations', kind: 'p', columns: ['owner_id', 'budget_id', 'operation_id'] },
  cap_operations_budget_fkey: { table: 'operations', kind: 'f', columns: ['owner_id', 'budget_id'] },
  [namespaceConstraint]: { table: 'operations', kind: 'u', columns: ['network', 'authorization_contract', 'payer', 'authorization_nonce'] },
  cap_operations_network_check: { table: 'operations', kind: 'c', expression: networkCheck },
  cap_operations_payer_check: { table: 'operations', kind: 'c', expression: payerCheck },
  cap_operations_payer_nonzero_check: { table: 'operations', kind: 'c', expression: payerNonzeroCheck },
  cap_operations_state_check: { table: 'operations', kind: 'c', expression: "state = 'requesting' OR state = 'signing' OR state = 'submitted' OR state = 'reported' OR state = 'unknown' OR state = 'settled' OR state = 'unpaid'" },
  cap_operations_payload_object_check: { table: 'operations', kind: 'c', expression: "jsonb_typeof(payload) = 'object'" },
  cap_operations_payload_identity_check: { table: 'operations', kind: 'c', expression: "payload @> jsonb_build_object('ownerId', owner_id, 'budgetId', budget_id, 'operationId', operation_id, 'agentId', agent_id, 'requestFingerprint', request_fingerprint, 'targetOrigin', target_origin, 'network', network, 'payer', payer, 'state', state)" },
  cap_operations_authorization_contract_check: { table: 'operations', kind: 'c', expression: "authorization_contract ~ '^0x[0-9a-f]{40}$'" },
  cap_operations_authorization_nonce_check: { table: 'operations', kind: 'c', expression: "authorization_nonce ~ '^(0x[0-9a-f]{64}|0|[1-9][0-9]*)$'" },
  cap_operations_authorization_pair_check: { table: 'operations', kind: 'c', expression: '(authorization_contract IS NULL) = (authorization_nonce IS NULL)' },
};
for (const column of ['limit_atomic', 'held_atomic', 'spent_atomic']) {
  expectedConstraints[`cap_budgets_${column}_check`] = { table: 'budgets', kind: 'c', expression: `${column} >= 0 AND ${column} <= ${maximumUint256}` };
}

function compatible(condition: unknown): asserts condition {
  if (!condition) throw new PaymentError('storage_unavailable');
}

function checkExpression(expression: string): string {
  const tokens = (expression.match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|::(?:pg_catalog\.)?(?:text|numeric)\b|[a-zA-Z_][a-zA-Z_0-9]*|[0-9]+|\s+|./g) ?? [])
    .filter((token) => !/^\s+$/.test(token));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '(' && /^(?:[0-9]+|'(?:[^']|'')*')$/.test(tokens[i + 1] ?? '') && tokens[i + 2] === ')') {
      tokens.splice(i, 3, tokens[i + 1]!); i--;
    } else if ((token === '::text' && /^'/.test(tokens[i - 1] ?? '')) ||
      (token === '::numeric' && /^(?:[0-9]+|'[0-9]+')$/.test(tokens[i - 1] ?? ''))) {
      tokens.splice(i, 1); i--;
    }
  }
  const normalized = tokens.map((token) => /^'[0-9]+'$/.test(token) ? token.slice(1, -1)
    : token.startsWith("'") || token.startsWith('"') ? token : token.toLowerCase());
  function logical(parts: string[]): unknown {
    while (parts[0] === '(' && parts.at(-1) === ')') {
      let depth = 0, wraps = true;
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i] === '(') depth++;
        else if (parts[i] === ')') depth--;
        if (depth === 0) { wraps = false; break; }
      }
      if (!wraps) break;
      parts = parts.slice(1, -1);
    }
    for (const operator of ['or', 'and']) {
      const groups: string[][] = []; let depth = 0, start = 0;
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === '(') depth++;
        else if (parts[i] === ')') depth--;
        else if (depth === 0 && parts[i] === operator) { groups.push(parts.slice(start, i)); start = i + 1; }
      }
      if (groups.length > 0) return [operator, ...[...groups, parts.slice(start)].map(logical)];
    }
    return parts.filter((token) => token !== '(' && token !== ')');
  }
  return JSON.stringify(logical(normalized));
}

async function validateSchema(client: Pick<PoolClient, 'query'>): Promise<void> {
  const relations = await query<{ name: string; kind: string; safe: boolean }>(client, `SELECT c.relname AS name, c.relkind AS kind,
    (c.relpersistence = 'p' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT c.relispartition AND c.reloptions IS NULL
      AND ((c.relkind = 'r' AND am.amname = 'heap' AND c.relreplident = 'd') OR (c.relkind = 'i' AND am.amname = 'btree'))) AS safe
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam WHERE n.nspname = 'cap_payments'`);
  const expectedRelations: Record<string, string> = { schema_version: 'r', budgets: 'r', operations: 'r',
    cap_schema_version_pkey: 'i', cap_budgets_pkey: 'i', cap_operations_pkey: 'i', [namespaceConstraint]: 'i' };
  compatible(relations.rows.length === Object.keys(expectedRelations).length);
  for (const row of relations.rows) compatible(row.safe && expectedRelations[row.name] === row.kind);

  const columns = await query<{
    table_name: string; name: string; type: string; not_null: boolean; collation: string | null; safe: boolean;
  }>(client, `SELECT c.relname AS table_name, a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
    a.attnotnull AS not_null, co.collname AS collation,
    (d.oid IS NULL AND NOT a.attisdropped AND a.attidentity = '' AND a.attgenerated = '' AND a.attislocal AND a.attinhcount = 0
      AND a.attstorage = t.typstorage AND a.attcompression = ''
      AND (a.attcollation = 0 OR co.collnamespace = 'pg_catalog'::regnamespace)) AS safe
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'cap_payments' AND c.relkind = 'r' AND a.attnum > 0 ORDER BY c.relname, a.attnum`);
  compatible(columns.rows.length === Object.values(expectedColumns).reduce((sum, list) => sum + list.length, 0));
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const actual = columns.rows.filter((column) => column.table_name === table);
    compatible(actual.length === expected.length);
    expected.forEach(([name, type, notNull], index) => {
      const row = actual[index];
      compatible(row && row.name === name && row.type === type && row.not_null === notNull && row.safe &&
        row.collation === (type === 'text' ? 'C' : null));
    });
  }

  const constraints = await query<{
    table_name: string; name: string; kind: string; safe: boolean; columns: string[]; expression: string | null;
    foreign_schema: string | null; foreign_table: string | null; foreign_columns: string[];
    foreign_update: string; foreign_delete: string; foreign_match: string;
  }>(client, `SELECT t.relname AS table_name, c.conname AS name, c.contype AS kind,
    (c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND c.conislocal AND c.coninhcount = 0 AND c.conparentid = 0
      AND (c.contype <> 'c' OR NOT c.connoinherit)) AS safe,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS columns,
    pg_catalog.pg_get_expr(c.conbin, c.conrelid) AS expression, fn.nspname AS foreign_schema, ft.relname AS foreign_table,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord) AS foreign_columns,
    c.confupdtype AS foreign_update, c.confdeltype AS foreign_delete, c.confmatchtype AS foreign_match
    FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace LEFT JOIN pg_catalog.pg_class ft ON ft.oid = c.confrelid
    LEFT JOIN pg_catalog.pg_namespace fn ON fn.oid = ft.relnamespace WHERE n.nspname = 'cap_payments'`);
  compatible(constraints.rows.length === Object.keys(expectedConstraints).length);
  for (const row of constraints.rows) {
    const expected = expectedConstraints[row.name];
    compatible(expected && expected.table === row.table_name && expected.kind === row.kind && row.safe);
    if (expected.expression !== undefined) compatible(row.expression !== null && checkExpression(row.expression) === checkExpression(expected.expression));
    if (expected.columns !== undefined) compatible(JSON.stringify(row.columns) === JSON.stringify(expected.columns));
    if (expected.kind === 'f') compatible(row.foreign_schema === 'cap_payments' && row.foreign_table === 'budgets' &&
      JSON.stringify(row.foreign_columns) === JSON.stringify(['owner_id', 'budget_id']) &&
      row.foreign_update === 'a' && row.foreign_delete === 'a' && row.foreign_match === 's');
  }

  const indexes = await query<{
    name: string; table_name: string; safe: boolean; primary: boolean; columns: string[];
    options: number[]; opclasses: string[]; collations: string[];
  }>(client, `SELECT c.relname AS name, t.relname AS table_name, i.indisprimary AS primary,
    (i.indisvalid AND i.indisready AND i.indislive AND i.indisunique AND i.indimmediate AND NOT i.indnullsnotdistinct
      AND NOT i.indisclustered AND NOT i.indisreplident AND i.indexprs IS NULL AND i.indpred IS NULL
      AND i.indnatts = i.indnkeyatts AND am.amname = 'btree' AND tn.nspname = 'cap_payments') AS safe,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num ORDER BY k.ord) AS columns,
    ARRAY(SELECT k.option::integer FROM unnest(i.indoption) WITH ORDINALITY k(option, ord) ORDER BY k.ord) AS options,
    ARRAY(SELECT ns.nspname || '.' || op.opcname FROM unnest(i.indclass) WITH ORDINALITY k(id, ord)
      JOIN pg_catalog.pg_opclass op ON op.oid = k.id JOIN pg_catalog.pg_namespace ns ON ns.oid = op.opcnamespace ORDER BY k.ord) AS opclasses,
    ARRAY(SELECT CASE WHEN k.id = 0 THEN '' ELSE ns.nspname || '.' || co.collname END
      FROM unnest(i.indcollation) WITH ORDINALITY k(id, ord) LEFT JOIN pg_catalog.pg_collation co ON co.oid = k.id
      LEFT JOIN pg_catalog.pg_namespace ns ON ns.oid = co.collnamespace ORDER BY k.ord) AS collations
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_class t ON t.oid = i.indrelid JOIN pg_catalog.pg_namespace tn ON tn.oid = t.relnamespace
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_am am ON am.oid = c.relam
    WHERE n.nspname = 'cap_payments'`);
  compatible(indexes.rows.length === 4);
  for (const row of indexes.rows) {
    const expected = expectedConstraints[row.name];
    compatible(row.safe && expected?.columns && (expected.kind === 'p' || expected.kind === 'u') &&
      row.table_name === expected.table && row.primary === (expected.kind === 'p') &&
      JSON.stringify(row.columns) === JSON.stringify(expected.columns) && row.options.length === expected.columns.length &&
      row.options.every((option) => option === 0));
    compatible(JSON.stringify(row.opclasses) === JSON.stringify(
      expected.columns.map(() => row.name === 'cap_schema_version_pkey' ? 'pg_catalog.bool_ops' : 'pg_catalog.text_ops')));
    compatible(JSON.stringify(row.collations) === JSON.stringify(
      expected.columns.map(() => row.name === 'cap_schema_version_pkey' ? '' : 'pg_catalog.C')));
  }

  const extras = await query<{ present: boolean }>(client, `SELECT
    EXISTS (SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_namespace n ON n.oid = d.refobjid
      WHERE d.refclassid = 'pg_catalog.pg_namespace'::regclass AND n.nspname = 'cap_payments'
        AND d.classid NOT IN ('pg_catalog.pg_class'::regclass, 'pg_catalog.pg_type'::regclass, 'pg_catalog.pg_constraint'::regclass))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'cap_payments' AND t.typrelid = 0 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type e WHERE e.typarray = t.oid))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_class c ON c.oid = g.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'cap_payments' AND (NOT g.tgisinternal OR g.tgenabled <> 'O'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'cap_payments')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'cap_payments')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid IN (i.inhrelid, i.inhparent)
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'cap_payments') AS present`);
  compatible(extras.rows[0]?.present === false);
  const version = await query<{ singleton: boolean; version: number }>(client, 'SELECT singleton, version FROM cap_payments.schema_version');
  compatible(version.rows.length === 1 && version.rows[0]?.singleton === true && version.rows[0].version === 1);
}

export async function installPaymentSchema(pool: Pool): Promise<void> {
  const capturedPool = capturePool(pool);
  await transaction(capturedPool, async (client) => {
    await query(client, 'SELECT pg_catalog.pg_advisory_xact_lock($1, $2)', [1430405709, 1]);
    await query(client, 'SET LOCAL search_path = pg_catalog');
    const schema = await query(client, 'SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1', ['cap_payments']);
    if (schema.rows.length === 0) {
      const sql = await readFile(new URL('../sql/001-payments.sql', import.meta.url), 'utf8');
      await query(client, sql);
    }
    await validateSchema(client);
  });
}
