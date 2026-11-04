import { createServer } from 'node:http';
import { once } from 'node:events';
import { encodeAbiParameters } from 'viem';
import { MemoryPaymentStore } from '../packages/payments/dist/testing.js';
import { protocolFixture, fixtureSigner, facilitatorVerifier, encodeHeader, decodeHeader } from './protocol-fixture.mjs';

export async function paymentFixture(t, options = {}) {
  const protocol = protocolFixture(options.mode ?? 'exact/eip3009');
  const state = { requests: [], signerCalls: 0, signatures: 0, verified: 0, rpcCalls: [], destinationCalls: 0 };
  const transaction = `0x${'ab'.repeat(32)}`;
  let verifier;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024 + 1) { response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const paid = request.headers['payment-signature'] !== undefined;
      state.requests.push({ paid, method: request.method, url: request.url, headers: { ...request.headers }, body });
      if (request.url === '/destination') { state.destinationCalls++; response.writeHead(200).end('destination'); return; }
      if (!paid) {
        if (options.initialStatus && options.initialStatus !== 402) {
          response.writeHead(options.initialStatus, options.initialStatus === 302 ? { location: '/destination' } : {}).end('ordinary-body');
          return;
        }
        response.writeHead(402, { 'PAYMENT-REQUIRED': encodeHeader(protocol.challenge) }).end('payment-required');
        return;
      }
      const payload = decodeHeader(request.headers['payment-signature']);
      const verification = await verifier.verify(payload);
      if (!verification.isValid) { response.writeHead(402).end('invalid-payment'); return; }
      state.verified++;
      if (options.dropPaidResponse) { request.socket.destroy(); return; }
      let receipt = { success: true, network: protocol.network, transaction, payer: fixtureSigner.address,
        amount: protocol.requirements.scheme === 'upto' ? '1200' : protocol.requirements.amount };
      if (options.receipt === 'failed' || options.receipt === 'pending') receipt = { ...receipt, success: false,
        errorReason: options.receipt === 'pending' ? 'settlement_pending' : 'settlement_failed' };
      if (options.receipt === 'wrong-payer') receipt.payer = protocol.requirements.payTo;
      if (options.receipt === 'wrong-network') receipt.network = 'eip155:1';
      if (options.receipt === 'over-maximum') receipt.amount = '7001';
      if (options.receipt === 'zero') receipt = { ...receipt, amount: '0', transaction: '' };
      receipt.errorMessage = 'private-provider-debug'; receipt.extra = { credential: 'private-provider-secret' };
      const headers = { 'content-type': 'text/plain' };
      if (options.receipt !== 'missing') headers['PAYMENT-RESPONSE'] = options.receipt === 'invalid' ? 'not-base64' : encodeHeader(receipt);
      response.writeHead(options.paidStatus ?? 200, headers).end('fixture-resource');
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end('fixture-error'); });
  });
  server.listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  protocol.operation.targetOrigin = origin;
  protocol.policy.merchants[0].origin = origin;
  protocol.challenge.resource.url = `${origin}/purchase`;
  verifier = facilitatorVerifier(protocol);
  const store = new MemoryPaymentStore(options.memoryOptions);
  const budget = { ownerId: 'http-owner', budgetId: 'http-budget', network: protocol.network, payer: fixtureSigner.address, limitAtomic: '10000' };
  await store.createBudget(budget);
  const key = { ownerId: budget.ownerId, budgetId: budget.budgetId, agentId: 'agent-a', operationId: 'purchase-one' };
  const config = {
    network: protocol.network, store, policy: structuredClone(protocol.policy),
    resolveSigner: async () => ({ address: fixtureSigner.address, signTypedData: async typed => {
      state.signerCalls++;
      const signature = await fixtureSigner.signTypedData(typed);
      state.signatures++;
      return signature;
    } }),
    rpc: async request => {
      state.rpcCalls.push(structuredClone(request));
      if (request.method !== 'eth_call') throw new Error('Unsupported fixture RPC method.');
      return encodeAbiParameters([{ type: 'uint256' }], [1000000n]);
    },
  };
  return { origin, url: `${origin}/purchase`, protocol, state, transaction, store, key, config, fixtureSigner };
}
