/**
 * JSON Schema validation for groups/<folder>/container.json.
 * Schema file: docs/schemas/container.schema.json (generated from ContainerConfig).
 */
import fs from 'fs';
import path from 'path';

import ajvModule, { type ErrorObject, type ValidateFunction } from 'ajv';

import { GROUPS_DIR } from './config.js';
import { CONTAINER_SCHEMA_ID, CONTAINER_SCHEMA_PATH } from './container-config-schema-generate.js';

const SCHEMA_PATH = CONTAINER_SCHEMA_PATH;
const SCHEMA_ID = CONTAINER_SCHEMA_ID;

export type ContainerConfigValidationError = {
  file: string;
  message: string;
};

export type ContainerConfigValidator = {
  validateValue: (raw: unknown, label?: string) => ContainerConfigValidationError[];
  validateFile: (filePath: string) => ContainerConfigValidationError[];
};

function formatValidationErrors(
  errorsText: (errors: ErrorObject[]) => string,
  file: string,
  errors: ErrorObject[],
): ContainerConfigValidationError[] {
  return errors.map((error) => ({
    file,
    message: errorsText([error]),
  }));
}

export function createContainerConfigValidator(): ContainerConfigValidator {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')) as object;
  const Ajv = ajvModule as unknown as new (options: { allErrors: boolean; strict: boolean }) => {
    validateSchema: (value: object) => boolean;
    addSchema: (value: object) => ValidateFunction;
    getSchema: (key: string) => ValidateFunction | undefined;
    errorsText: (errors: ErrorObject[], options?: { separator: string }) => string;
  };
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.validateSchema(schema);
  ajv.addSchema(schema);

  const validate = ajv.getSchema(SCHEMA_ID);
  if (!validate) {
    throw new Error('container schema was not registered');
  }

  const validateValue = (raw: unknown, label = '<value>'): ContainerConfigValidationError[] => {
    if (validate(raw)) return [];
    return formatValidationErrors(
      (errors) => ajv.errorsText(errors, { separator: '; ' }),
      label,
      validate.errors ?? [],
    );
  };

  return {
    validateValue,
    validateFile(filePath: string): ContainerConfigValidationError[] {
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (err) {
        return [{ file: filePath, message: `invalid JSON: ${String(err)}` }];
      }
      return validateValue(raw, filePath);
    },
  };
}

export function listContainerJsonFiles(folders?: string[]): string[] {
  if (folders && folders.length > 0) {
    return folders.map((folder) => path.join(GROUPS_DIR, folder, 'container.json'));
  }

  if (!fs.existsSync(GROUPS_DIR)) return [];

  const files: string[] = [];
  for (const entry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = path.join(GROUPS_DIR, entry.name, 'container.json');
    if (fs.existsSync(p)) files.push(p);
  }
  return files.sort();
}

export function validateAllContainerConfigs(folders?: string[]): ContainerConfigValidationError[] {
  const validator = createContainerConfigValidator();
  const errors: ContainerConfigValidationError[] = [];
  for (const file of listContainerJsonFiles(folders)) {
    errors.push(...validator.validateFile(file));
  }
  return errors;
}
