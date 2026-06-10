/**
 * Generate docs/schemas/container.schema.json from src/container-config.ts.
 *
 * Source of truth: the ContainerConfig TypeScript interface (+ JSDoc).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CONTAINER_SCHEMA_ID = 'https://frontlane.dev/schemas/container.json';
export const CONTAINER_SCHEMA_PATH = path.join(process.cwd(), 'docs', 'schemas', 'container.schema.json');

type JsonSchema = Record<string, unknown>;

function generatorBin(): string {
  return path.join(
    process.cwd(),
    'node_modules',
    'ts-json-schema-generator',
    'bin',
    'ts-json-schema-generator.js',
  );
}

function generateRawSchema(): JsonSchema {
  const stdout = execFileSync(
    process.execPath,
    [
      generatorBin(),
      '--path',
      path.join(process.cwd(), 'src', 'container-config.ts'),
      '--type',
      'ContainerConfig',
      '--expose',
      'export',
      '--no-type-check',
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(stdout) as JsonSchema;
}

/** Rewrite #/definitions/Foo → #/$defs/Foo after hoisting ContainerConfig to root. */
function rewriteDefinitionRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(rewriteDefinitionRefs);
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj)) {
      if (key === '$ref' && typeof child === 'string') {
        out[key] = child.replace('#/definitions/', '#/$defs/');
      } else {
        out[key] = rewriteDefinitionRefs(child);
      }
    }
    return out;
  }
  return value;
}

export function postProcessGeneratedSchema(raw: JsonSchema): JsonSchema {
  const definitions = raw.definitions as Record<string, JsonSchema> | undefined;
  if (!definitions?.ContainerConfig) {
    throw new Error('generated schema missing definitions.ContainerConfig');
  }

  const { ContainerConfig, ...restDefs } = definitions;
  const hoisted = rewriteDefinitionRefs(ContainerConfig) as JsonSchema;

  const properties = {
    $schema: {
      type: 'string',
      description: 'JSON Schema reference for editor validation (not read by runtime).',
    },
    ...(hoisted.properties as Record<string, unknown>),
  };

  return {
    $schema: raw.$schema ?? 'http://json-schema.org/draft-07/schema#',
    $id: CONTAINER_SCHEMA_ID,
    title: 'FrontLane Agent Group Container Config',
    description:
      'Per-agent-group configuration at groups/<folder>/container.json. Generated from src/container-config.ts — run pnpm generate:container-schema to refresh.',
    type: hoisted.type ?? 'object',
    additionalProperties: hoisted.additionalProperties ?? false,
    required: hoisted.required,
    properties,
    $defs: rewriteDefinitionRefs(restDefs),
  };
}

export function generateContainerSchema(): JsonSchema {
  return postProcessGeneratedSchema(generateRawSchema());
}

export function writeContainerSchema(targetPath = CONTAINER_SCHEMA_PATH): JsonSchema {
  const schema = generateContainerSchema();
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(schema, null, 2)}\n`);
  return schema;
}
