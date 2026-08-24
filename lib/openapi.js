/**
 * OpenAPI spec generation via swagger-jsdoc plus the bundled API reference.
 *
 * swagger-jsdoc scans JSDoc `@openapi` comments on route handlers in server.js
 * (and any file passed in `apis`) to build the spec at startup.
 * The dependency-free docs UI lives in docs/api.html.
 *
 * Usage:
 *   import { mountDocs } from './lib/openapi.js';
 *   // After all routes are registered:
 *   mountDocs(app);
 */

import swaggerJsdoc from 'swagger-jsdoc';
import express from 'express';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { SESSION_POLICY_ACTIONS, SESSION_POLICY_DANGEROUS_ACTIONS } from './session-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let version = 'unknown';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  version = pkg.version;
} catch { /* ignore */ }

const swaggerDefinition = {
  openapi: '3.0.3',
  info: {
    title: 'goliath',
    version,
    description:
      'Firefox-based browser automation for AI agents with configurable anti-detection measures. ' +
      'Accessibility snapshots, stable element refs, human-like actions, secure uploads, session isolation, and structured logs.',
    license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
    contact: { name: 'Mechanica Labs', url: 'https://github.com/Mechanica-Labs/goliath' },
  },
  servers: [{ url: 'http://127.0.0.1:9377', description: 'Local development' }],
  tags: [
    { name: 'System', description: 'Server health, metrics, and status.' },
    { name: 'Tabs', description: 'Create, list, inspect, and destroy browser tabs.' },
    { name: 'Navigation', description: 'Navigate tabs to URLs or via search macros.' },
    { name: 'Interaction', description: 'Click, type, scroll, press keys, evaluate JS.' },
    { name: 'Content', description: 'Accessibility snapshots, screenshots, links, images, downloads.' },
    { name: 'Sessions', description: 'Per-user session state: cookies, teardown.' },
    { name: 'Browser', description: 'Global browser lifecycle (start/stop).' },
    { name: 'Legacy', description: 'OpenClaw-compatible endpoints (deprecated).' },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Bearer token matching GOLIATH_API_KEY (per-route auth for sensitive endpoints like cookie import and traces).',
      },
      AccessKeyAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Bearer token matching GOLIATH_ACCESS_KEY. Required for non-loopback access and accepted as a superkey by routes that normally require GOLIATH_API_KEY.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: { error: { type: 'string' } },
      },
      ApprovalRequired: {
        type: 'object',
        description: 'Returned instead of acting when a click/type/hands request targets a dangerous control and confirm was not true. Set GOLIATH_DANGEROUS_ACTIONS=annotate or off to change the behavior.',
        required: ['ok', 'status', 'action', 'category', 'risk'],
        properties: {
          ok: { type: 'boolean', enum: [false] },
          status: { type: 'string', enum: ['approval_required'] },
          action: { type: 'string', description: 'What was about to happen, e.g. "Click" or "Type and submit".' },
          kind: { type: 'string', enum: ['click', 'submit', 'type_submit'] },
          category: { type: 'string', enum: ['change_password', 'payment', 'transfer', 'sign', 'delete', 'send', 'publish', 'confirm', 'unresolved_target'] },
          risk: { type: 'string', enum: ['credential_change', 'financial', 'legal_commitment', 'destructive', 'external_side_effect', 'irreversible_commit', 'unknown'] },
          element: { type: 'string', nullable: true, description: 'Accessible name of the target control.' },
          role: { type: 'string', nullable: true },
          domain: { type: 'string', nullable: true, description: 'Hostname of the page the action targets.' },
          matched: { type: 'string', nullable: true, description: 'Keyword that triggered the classification.' },
          source: { type: 'string', enum: ['element', 'nearby_control', 'form_action', 'lookup_failed'] },
          hint: { type: 'string' },
        },
      },
      SessionPolicy: {
        type: 'object',
        additionalProperties: false,
        description: 'Optional runtime-only capability policy. Unset fields default to allow, and no registered policy preserves unrestricted behavior.',
        properties: {
          allowedOrigins: {
            type: 'array',
            maxItems: 100,
            items: { type: 'string' },
            description: 'Exact HTTP(S) origins or scheme-pinned subdomain wildcards such as https://*.example.com.',
          },
          deniedOrigins: {
            type: 'array',
            maxItems: 100,
            items: { type: 'string' },
            description: 'Origins denied before allowedOrigins is evaluated.',
          },
          actions: {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(SESSION_POLICY_ACTIONS.map(action => [action, { type: 'string', enum: ['allow', 'deny'] }])),
            description: 'Per-capability decisions. Unset capabilities default to allow.',
          },
          dangerousActions: {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(SESSION_POLICY_DANGEROUS_ACTIONS.map(category => [category, { type: 'string', enum: ['allow', 'deny'] }])),
            description: 'Hard denies by dangerous-action category. A deny cannot be overridden with confirm: true.',
          },
        },
      },
      PolicyViolation: {
        type: 'object',
        required: ['error', 'code', 'action', 'origin', 'category', 'reason'],
        properties: {
          error: { type: 'string' },
          code: { type: 'string', enum: ['policy_violation'] },
          action: { type: 'string' },
          origin: { type: 'string', nullable: true },
          category: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

/**
 * Mount GET /openapi.json and GET /docs on the Express app.
 * Call AFTER all routes are registered so swagger-jsdoc can scan them.
 *
 * @param {import('express').Application} app
 * @param {Object} [opts]
 * @param {string[]} [opts.apis] - Files or glob patterns with @openapi JSDoc
 */
export function mountDocs(app, opts = {}) {
  // Resolve from the package, not process.cwd(); installed services commonly
  // run with a parent directory as their WorkingDirectory.
  const apis = opts.apis || [join(__dirname, '..', 'server.js')];

  const spec = swaggerJsdoc({
    definition: swaggerDefinition,
    apis,
  });

  app.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });

  // Serve docs static assets (api.html, fox.png, openapi.json)
  const docsDir = join(__dirname, '..', 'docs');
  const assetsDir = join(__dirname, '..', 'assets');
  app.use('/docs', express.static(docsDir, { index: 'api.html' }));
  app.use('/assets', express.static(assetsDir));

  // Keep the legacy artwork route, backed by the packaged Goliath logo.
  app.get('/fox.png', (_req, res) => {
    res.sendFile(join(assetsDir, 'goliath-logo.jpg'));
  });

  return spec;
}

export { swaggerDefinition };
