import { copyFile } from 'node:fs/promises'

await copyFile(
  new URL('../packages/araya/package.json', import.meta.url),
  new URL('../packages/araya/dist/package.json', import.meta.url)
)
