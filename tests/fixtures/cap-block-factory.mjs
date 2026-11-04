import { writeFileSync } from 'node:fs';

export default function createAgent() {
  if (process.env.CAP_CLI_READY) writeFileSync(process.env.CAP_CLI_READY, 'factory\n');
  while (true) {}
}
