import { getStoreHandle } from '../packages/payments/dist/internal.js';
import { prepareAuthorization } from '../packages/payments/dist/protocol.js';

export { getStoreHandle };
export const network = 'eip155:84532';
export const payer = '0x1111111111111111111111111111111111111111';
export const merchant = '0x2222222222222222222222222222222222222222';
export const origin = 'https://merchant.example';
export const transactionHash = `0x${'a'.repeat(64)}`;
export const budgetInput = (budgetId = 'shared', ownerId = 'postgres-proof') => ({
  ownerId, budgetId, network, payer, limitAtomic: '10000',
});
export const startInput = (budget, operationId = 'purchase', agentId = operationId) => ({
  ownerId: budget.ownerId, budgetId: budget.budgetId, operationId, agentId,
  requestFingerprint: 'b'.repeat(64), targetOrigin: origin,
});

export function prepare(operation, scheme = 'upto') {
  const header = Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: { url: `${origin}/purchase`, mimeType: 'application/json' },
    accepts: [{
      scheme, network, asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', amount: '7000', payTo: merchant,
      maxTimeoutSeconds: 300,
      extra: {
        assetTransferMethod: 'permit2', paymentFlow: 'authorization', name: 'USDC', version: '2',
        ...(scheme === 'upto' ? { facilitatorAddress: '0x3333333333333333333333333333333333333333' } : {}),
      },
    }],
  })).toString('base64');
  const prepared = prepareAuthorization(header, operation, {
    maxPerPaymentAtomic: '7000', allowedSchemes: ['exact', 'upto'], merchants: [{ origin, payTo: merchant }],
  });
  prepared.checkAllowance(JSON.stringify(`0x${'f'.repeat(64)}`));
  return prepared;
}

export const successReport = (amount = '1200') => ({
  kind: 'reported', receipt: { success: true, network, payer, amount, transaction: transactionHash },
});
