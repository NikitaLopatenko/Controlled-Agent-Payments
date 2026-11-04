import { createAgentPayments } from '@cap/payments';

export default function createAgent(options) {
  const agent = createAgentPayments(options);
  return { fetch: agent.fetch, async reconcile() { return new Promise(() => {}); } };
}
