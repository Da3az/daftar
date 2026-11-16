#!/usr/bin/env node
/**
 * Convert the generated OpenAPI document into a committed Postman collection.
 *
 * Why this exists at all, and why now rather than at the end: one of this
 * project's claims is that the API is hammerable by someone who has never seen
 * the repo. That claim is cheap to make and easy to leave untested, so the
 * collection is generated from the real OpenAPI document — itself generated from
 * the Zod schemas the server validates against — and committed, so it cannot
 * drift silently from the routes.
 *
 * Run after `npm run openapi:dump`.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import converter from 'openapi-to-postmanv2';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const openapiPath = resolve(repoRoot, 'apps/api/openapi.json');
const collectionPath = resolve(repoRoot, 'postman/daftar.postman_collection.json');
const environmentPath = resolve(repoRoot, 'postman/daftar.local.postman_environment.json');

const spec = await readFile(openapiPath, 'utf8');

const result = await new Promise((resolvePromise, reject) => {
  converter.convert(
    { type: 'string', data: spec },
    {
      // Point every request at {{baseUrl}} rather than a baked-in host, so the
      // collection works against localhost, a staging box, or the deployed
      // server by swapping one environment variable.
      requestParametersResolution: 'Example',
      exampleParametersResolution: 'Example',
      folderStrategy: 'Tags',
      includeAuthInfoInExample: false,
      enableOptionalParameters: false,
      // Generated response examples bloat the file and go stale the moment a
      // schema changes. The schemas are in the OpenAPI document; the collection
      // is for firing requests.
      shortValidationErrors: true,
    },
    (err, conversionResult) => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!conversionResult.result) {
        reject(new Error(`conversion failed: ${conversionResult.reason ?? 'unknown reason'}`));
        return;
      }
      resolvePromise(conversionResult.output[0].data);
    },
  );
});

/**
 * Rewrite the generated host into a `{{baseUrl}}` variable. The converter
 * derives the host from `servers`, which is `/` here, and leaving that produces
 * requests with an empty host that silently fail in Postman.
 */
function rewriteHost(node) {
  if (Array.isArray(node)) {
    node.forEach(rewriteHost);
    return;
  }
  if (node === null || typeof node !== 'object') return;

  if (node.request?.url && typeof node.request.url === 'object') {
    const url = node.request.url;
    const path = Array.isArray(url.path) ? url.path.join('/') : '';
    node.request.url = {
      raw: `{{baseUrl}}/${path}`,
      host: ['{{baseUrl}}'],
      path: Array.isArray(url.path) ? url.path : [],
      ...(url.query ? { query: url.query } : {}),
      ...(url.variable ? { variable: url.variable } : {}),
    };
  }

  for (const value of Object.values(node)) rewriteHost(value);
}

rewriteHost(result);

result.variable = [
  {
    key: 'baseUrl',
    value: 'http://127.0.0.1:3000',
    type: 'string',
  },
];

/**
 * The flag headers, added to the collection as disabled headers on every
 * request. A reviewer opening the collection sees the names of the switches
 * without having to read the source, and enabling one is a checkbox.
 */
const FLAG_HEADERS = [
  {
    key: 'x-daftar-concurrency-mode',
    value: 'serializable',
    disabled: true,
    description: 'pessimistic | serializable | advisory',
  },
  {
    key: 'x-daftar-naive-overdraft',
    value: 'true',
    disabled: true,
    description: 'Phase 1 naive path: app-level funds check then atomic decrement. Overdrafts.',
  },
  {
    key: 'x-daftar-naive-lost-update',
    value: 'true',
    disabled: true,
    description: 'Phase 1 naive path: read, compute in JS, write absolute. Loses updates.',
  },
];

function addFlagHeaders(node) {
  if (Array.isArray(node)) {
    node.forEach(addFlagHeaders);
    return;
  }
  if (node === null || typeof node !== 'object') return;

  if (node.request && typeof node.request === 'object') {
    const headers = Array.isArray(node.request.header) ? node.request.header : [];
    const present = new Set(headers.map((h) => String(h.key).toLowerCase()));
    node.request.header = [...headers, ...FLAG_HEADERS.filter((h) => !present.has(h.key))];
  }

  for (const value of Object.values(node)) addFlagHeaders(value);
}

addFlagHeaders(result);

await mkdir(dirname(collectionPath), { recursive: true });
await writeFile(collectionPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

const environment = {
  name: 'Daftar — local',
  values: [{ key: 'baseUrl', value: 'http://127.0.0.1:3000', type: 'default', enabled: true }],
  _postman_variable_scope: 'environment',
};
await writeFile(environmentPath, `${JSON.stringify(environment, null, 2)}\n`, 'utf8');

const requestCount = JSON.stringify(result).split('"request":').length - 1;
console.log(`wrote ${collectionPath} (${requestCount} requests)`);
console.log(`wrote ${environmentPath}`);
