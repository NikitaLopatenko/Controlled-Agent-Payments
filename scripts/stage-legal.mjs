import { copyFile } from 'node:fs/promises';
for (const name of ['payments', 'testing']) {
  for (const file of ['LICENSE', 'NOTICE']) {
    await copyFile(new URL(`../${file}`, import.meta.url), new URL(`../packages/${name}/${file}`, import.meta.url));
  }
}
