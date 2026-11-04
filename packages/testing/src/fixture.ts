// Adapted from UBB's Apache-2.0 integration fixture; see NOTICE.
import { once } from 'node:events';
import type { Server } from 'node:http';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from '@x402/hono';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { UptoEvmScheme } from '@x402/evm/upto/server';
import type { SimulatedFacilitator } from './facilitator.js';

export interface PaymentFixture {
  origin: string;
  exactUrl: string;
  uptoUrl: string;
  uptoInit: { method: 'POST'; body: 'fixture-input'; headers: { 'content-type': 'text/plain' } };
  controls: { input: string; work: number };
  close(): Promise<void>;
}

export async function startFixture(simulator: SimulatedFacilitator): Promise<PaymentFixture> {
  const controls = { input: '', work: 0 };
  const app = new Hono();
  const resource = new x402ResourceServer(simulator)
    .register(simulator.network, new ExactEvmScheme())
    .register(simulator.network, new UptoEvmScheme());
  let server: Server | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    simulator.stop();
    closing = server ? promisify(server.close.bind(server))().then(() => {}) : Promise.resolve();
    server?.closeAllConnections();
    return closing;
  };
  try {
    await resource.initialize();
    app.use(paymentMiddleware({
      'GET /exact': { accepts: { scheme: 'exact', network: simulator.network, payTo: simulator.merchant.address,
        price: { asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', amount: '1000', extra: { name: 'USDC', version: '2' } },
        maxTimeoutSeconds: 300, extra: { assetTransferMethod: 'eip3009' } }, mimeType: 'text/plain' },
      'POST /upto': { accepts: { scheme: 'upto', network: simulator.network, payTo: simulator.merchant.address,
        price: { asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', amount: '7000', extra: { name: 'USDC', version: '2' } },
        maxTimeoutSeconds: 300, extra: { assetTransferMethod: 'permit2' } }, mimeType: 'text/plain' },
    }, resource, undefined, undefined, false));
    app.get('/exact', c => {
      if (closed) return c.text('Fixture stopped.', 503);
      controls.work++;
      return c.text('fixture-resource');
    });
    app.post('/upto', async c => {
      const input = await c.req.text();
      if (closed) return c.text('Fixture stopped.', 503);
      controls.input = input;
      controls.work++;
      setSettlementOverrides(c, { amount: '1200' });
      return c.text('fixture-resource');
    });
    app.onError(() => new Response(null, { status: 500 }));
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false }) as Server;
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable.');
    const origin = `http://127.0.0.1:${address.port}`;
    return { origin, exactUrl: `${origin}/exact`, uptoUrl: `${origin}/upto`,
      uptoInit: { method: 'POST', body: 'fixture-input', headers: { 'content-type': 'text/plain' } }, controls, close };
  } catch (error) {
    await close();
    throw error;
  }
}
