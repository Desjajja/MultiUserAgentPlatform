/**
 * CLI: regenerate docs/schemas/container.schema.json from ContainerConfig.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTAINER_SCHEMA_PATH,
  writeContainerSchema,
} from '../src/container-config-schema-generate.js';

function main(): void {
  writeContainerSchema();
  console.log(`Wrote ${path.relative(process.cwd(), CONTAINER_SCHEMA_PATH)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
