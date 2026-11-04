import { createAgentPayments } from '@cap/payments';
import createFakeAgent from './cap-fake.mjs';

let first = true;
export default function createAgent(options) {
  if (first) {
    first = false;
    return createFakeAgent();
  }
  return createAgentPayments(options);
}
