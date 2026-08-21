import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@jest/globals';
import swaggerJsdoc from 'swagger-jsdoc';
import express from 'express';
import { mountDocs, swaggerDefinition } from '../../lib/openapi.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const serverPath = resolve(root, 'server.js');

test('committed OpenAPI document matches server annotations', () => {
  const generated = swaggerJsdoc({
    definition: swaggerDefinition,
    apis: [serverPath],
  });
  const committed = JSON.parse(readFileSync(resolve(root, 'openapi.json'), 'utf8'));
  expect(committed).toEqual(generated);
});

test('every Express route in server.js has an OpenAPI operation', () => {
  const source = readFileSync(serverPath, 'utf8');
  const spec = JSON.parse(readFileSync(resolve(root, 'openapi.json'), 'utf8'));
  const routes = [...source.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'/g)]
    .map((match) => ({
      method: match[1],
      path: match[2].replace(/:([A-Za-z0-9_]+)/g, '{$1}'),
    }));
  const missing = routes.filter(({ method, path }) => !spec.paths?.[path]?.[method]);
  expect(missing).toEqual([]);
});

test('runtime docs resolve server annotations outside the package cwd', () => {
  const previous = process.cwd();
  try {
    process.chdir('/tmp');
    const spec = mountDocs(express());
    expect(Object.keys(spec.paths || {}).length).toBeGreaterThan(0);
  } finally {
    process.chdir(previous);
  }
});
