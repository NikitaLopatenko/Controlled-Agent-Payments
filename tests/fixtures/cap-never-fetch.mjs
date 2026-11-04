import { writeFileSync } from 'node:fs';

export default function createAgent() {
  return {
    async fetch() {
      if (process.env.CAP_CLI_READY) writeFileSync(process.env.CAP_CLI_READY, 'fetch\n');
      return new Promise(() => {});
    },
    async reconcile() { throw new Error('CAP_PRIVATE_LOG_SENTINEL unreachable reconcile'); },
  };
}
