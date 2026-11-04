import { writeFileSync } from 'node:fs';
import { createAgentPayments } from '@cap/payments';

process.once('disconnect', () => {
  if (process.env.CAP_CLI_READY) writeFileSync(process.env.CAP_CLI_READY, 'shutdown after report\n');
  while (true) {}
});
export default createAgentPayments;
