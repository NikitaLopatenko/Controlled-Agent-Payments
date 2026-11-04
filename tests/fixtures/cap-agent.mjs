import { appendFileSync } from 'node:fs';
import { createAgentPayments } from '@cap/payments';

console.log('CAP_PRIVATE_LOG_SENTINEL module stdout');
process.stderr.write('CAP_PRIVATE_LOG_SENTINEL module stderr\n');
if (process.env.CAP_CLI_IMPORT_MARKER) appendFileSync(process.env.CAP_CLI_IMPORT_MARKER, 'import\n');
export default function createAgent(options) {
  console.log('CAP_PRIVATE_LOG_SENTINEL factory stdout');
  if (process.env.CAP_CLI_FACTORY_MARKER) appendFileSync(process.env.CAP_CLI_FACTORY_MARKER, 'factory\n');
  return createAgentPayments(options);
}
