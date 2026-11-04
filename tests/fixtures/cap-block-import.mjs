import { writeFileSync } from 'node:fs';

if (process.env.CAP_CLI_READY) writeFileSync(process.env.CAP_CLI_READY, 'import\n');
while (true) {}
