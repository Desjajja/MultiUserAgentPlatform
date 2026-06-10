/**
 * Validate each groups/<folder>/container.json against docs/schemas/container.schema.json.
 *
 * Usage:
 *   pnpm validate:container-config
 *   pnpm validate:container-config -- groups/my-group
 */
import path from 'path';
import { fileURLToPath } from 'url';

import {
  createContainerConfigValidator,
  listContainerJsonFiles,
} from '../src/container-config-schema.js';

const ROOT = process.cwd();

function main(): void {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const files = listContainerJsonFiles(args.length > 0 ? args : undefined);
  if (files.length === 0) {
    console.log('No container.json files found under groups/');
    return;
  }

  const validator = createContainerConfigValidator();
  let failed = 0;
  for (const file of files) {
    const errors = validator.validateFile(file);
    if (errors.length === 0) {
      console.log(`ok ${path.relative(ROOT, file)}`);
      continue;
    }
    failed += errors.length;
    for (const error of errors) {
      console.error(`FAIL ${path.relative(ROOT, error.file)}: ${error.message}`);
    }
  }

  if (failed > 0) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
