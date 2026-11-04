import { writeFileSync } from 'node:fs';

if (process.env.CAP_CLI_READY) writeFileSync(process.env.CAP_CLI_READY, 'pending import\n');
setInterval(() => {}, 1000);
await new Promise(() => {});
