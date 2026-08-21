import { resolve } from 'node:path';

import { readCookieFile } from '../lib/cookies.js';

const SEARCH_MACROS = [
  '@google_search',
  '@youtube_search',
  '@amazon_search',
  '@reddit_search',
  '@wikipedia_search',
  '@twitter_search',
  '@yelp_search',
  '@spotify_search',
  '@netflix_search',
  '@linkedin_search',
  '@instagram_search',
  '@tiktok_search',
  '@twitch_search',
];

const HUMANIZED_INPUT_SCHEMA = {
  oneOf: [
    { type: 'boolean' },
    {
      type: 'object',
      properties: { profile: { type: 'string', enum: ['fast', 'balanced', 'deliberate'] } },
      additionalProperties: false,
    },
  ],
  description: 'Use variable human-like timing and motion; optionally select a profile',
};

const POSTCONDITIONS_SCHEMA = {
  type: 'array', minItems: 1, maxItems: 20,
  items: { oneOf: [
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['url_matches'] }, pattern: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['kind', 'pattern'] },
    { type: 'object', additionalProperties: false, minProperties: 2, properties: { kind: { type: 'string', enum: ['node_exists'] }, nodeId: { type: 'string', minLength: 1, maxLength: 256 }, name: { type: 'string', minLength: 1, maxLength: 256 }, role: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['kind'] },
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['text_contains'] }, text: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['kind', 'text'] },
  ] },
};

export const TOOL_DEFS = [
  {
    name: 'goliath_create_tab',
    description:
      'Open a Firefox-based browser tab with configurable anti-detection measures when ordinary browser tools are blocked, challenged, or lack human interaction support. Acceptance by third-party bot-detection systems is not guaranteed. Returns a tabId used by the other Goliath tools.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Initial http(s) URL' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_snapshot',
    description:
      'Read the current page as a compact accessibility snapshot with stable element refs such as e1 and e2. Also returns a screenshot. Take a new snapshot after navigation or major page changes.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        offset: { type: 'number', minimum: 0, description: 'Use nextOffset when a previous snapshot hasMore' },
      },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_observe',
    description: 'Capture versioned semantic state with durable node IDs, diffs, readiness, capabilities, and provenance.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        since: { type: 'string' },
        goalSelector: { type: 'string' },
      },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_plan_action',
    description: 'Create and policy-check a semantic action contract tied to one observed snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        snapshotId: { type: 'string' },
        nodeId: { type: 'string' },
        kind: { type: 'string', enum: ['click', 'type', 'type_secret', 'press'] },
        text: { type: 'string' },
        secretId: { type: 'string' },
        key: { type: 'string' },
        allowedOrigins: { type: 'array', items: { type: 'string' } },
      },
      required: ['tabId', 'snapshotId', 'nodeId', 'kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_execute_action',
    description: 'Execute a semantic action contract and verify caller-supplied postconditions.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        contractId: { type: 'string' },
        confirm: { type: 'boolean' },
        postconditions: POSTCONDITIONS_SCHEMA,
      },
      required: ['tabId', 'contractId', 'postconditions'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_extract',
    description: 'Extract typed data from semantic state with confidence and per-field provenance.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        snapshotId: { type: 'string' },
        schema: { type: 'object' },
      },
      required: ['tabId', 'schema'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_handoff',
    description: 'Pause, resume, or cancel a scoped human takeover for one tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        action: { type: 'string', enum: ['request', 'resume', 'cancel'] },
        reason: { type: 'string' },
      },
      required: ['tabId', 'action'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_checkpoint',
    description: 'Checkpoint cookies, local storage, and IndexedDB for a later isolated fork.',
    inputSchema: {
      type: 'object',
      properties: { checkpointId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_fork',
    description: 'Create an isolated browser session from a storage checkpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        checkpointId: { type: 'string' },
        newUserId: { type: 'string' },
        url: { type: 'string' },
        sessionKey: { type: 'string' },
      },
      required: ['checkpointId', 'newUserId'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_click',
    description: 'Click an element by snapshot ref or CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        ref: { type: 'string', description: 'Element ref from the latest snapshot' },
        selector: { type: 'string', description: 'CSS selector alternative to ref' },
        humanized: HUMANIZED_INPUT_SCHEMA,
      },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_type',
    description: 'Fill or type text into a form control by snapshot ref or CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        ref: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        pressEnter: { type: 'boolean' },
        humanized: HUMANIZED_INPUT_SCHEMA,
      },
      required: ['tabId', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_navigate',
    description: 'Navigate a tab to a URL, or run a search through a supported macro.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        url: { type: 'string' },
        macro: { type: 'string', enum: SEARCH_MACROS },
        query: { type: 'string' },
      },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_scroll',
    description: 'Scroll the page in a direction by a number of pixels.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', minimum: 1 },
        humanized: HUMANIZED_INPUT_SCHEMA,
      },
      required: ['tabId', 'direction'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_hands',
    description:
      'Run an ordered multi-step UI workflow in one tab. Use this for forms and other workflows that would otherwise require repeated click, type, select, check, wait, scroll, press, or submit calls. Stops at the first failing step.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['click', 'type', 'select', 'check', 'wait', 'scroll', 'press', 'submit'],
              },
              ref: { type: 'string', description: 'Element ref from the latest snapshot' },
              selector: { type: 'string', description: 'CSS selector; required for select' },
              text: { type: 'string', maxLength: 3000 },
              value: { type: 'string' },
              values: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 },
              mode: { type: 'string', enum: ['fill', 'keyboard'] },
              submit: { type: 'boolean' },
              pressEnter: { type: 'boolean' },
              doubleClick: { type: 'boolean' },
              direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
              amount: { type: 'number', minimum: 1 },
              key: { type: 'string' },
              ms: { type: 'number', minimum: 0, maximum: 5000 },
            },
            required: ['action'],
            additionalProperties: false,
          },
        },
        humanized: {
          oneOf: [
            { type: 'boolean' },
            {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                profile: { type: 'string', enum: ['fast', 'balanced', 'deliberate'] },
              },
              additionalProperties: false,
            },
          ],
        },
      },
      required: ['tabId', 'steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_behavior',
    description:
      'Get bounded timing-diversity telemetry for a tab. This is a local interaction heuristic, not proof that a third-party bot detector will accept the session.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_act',
    description:
      'Perform the human interactions needed for complex forms and document workflows: press keys, hover, wait, reveal an element, select options, or drag and drop.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        kind: { type: 'string', enum: ['press', 'hover', 'wait', 'scrollIntoView', 'select_option', 'drag'] },
        ref: { type: 'string' },
        selector: { type: 'string' },
        key: { type: 'string', description: 'For press, e.g. Enter or Control+A' },
        timeMs: { type: 'number', minimum: 0, maximum: 30000 },
        text: { type: 'string', description: 'Visible text to wait for' },
        loadState: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
        value: { type: 'string', description: 'Single option value for select_option' },
        values: { type: 'array', items: { type: 'string' }, maxItems: 100 },
        sourceRef: { type: 'string' },
        sourceSelector: { type: 'string' },
        targetRef: { type: 'string' },
        targetSelector: { type: 'string' },
      },
      required: ['tabId', 'kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_upload',
    description:
      'Attach one or more files to a page upload control. For safety, paths must be inside GOLIATH_UPLOADS_DIR (default ~/.goliath/uploads).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        path: {
          description: 'Absolute path or paths inside the configured uploads directory',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
          ],
        },
        ref: { type: 'string', description: 'Upload trigger ref when no file input is mounted' },
        selector: { type: 'string' },
        timeout: { type: 'number', minimum: 0, maximum: 30000 },
      },
      required: ['tabId', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_screenshot',
    description: 'Capture the current page as a PNG image.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        fullPage: { type: 'boolean' },
      },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_evaluate',
    description:
      'Execute JavaScript in the page context for controls or state that cannot be reached through the normal snapshot actions.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        expression: { type: 'string' },
      },
      required: ['tabId', 'expression'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_list_tabs',
    description: 'List the tabs owned by this agent identity.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'goliath_close_tab',
    description: 'Close a browser tab when the task no longer needs it.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'goliath_import_cookies',
    description:
      'Import a Netscape cookies.txt file from GOLIATH_COOKIES_DIR into this agent session. Requires GOLIATH_API_KEY on both bridge and server.',
    inputSchema: {
      type: 'object',
      properties: {
        cookiesPath: { type: 'string', description: 'Relative path inside GOLIATH_COOKIES_DIR' },
        domainSuffix: { type: 'string' },
      },
      required: ['cookiesPath'],
      additionalProperties: false,
    },
  },
];

export const TOOL_NAMES = TOOL_DEFS.map((tool) => tool.name);

function without(args, key = 'tabId') {
  const { [key]: _omitted, ...rest } = args;
  return rest;
}

function tabPath(tabId, suffix = '') {
  return `/tabs/${encodeURIComponent(tabId)}${suffix}`;
}

export function buildRequest(name, args, ctx) {
  const userId = ctx.userId;
  switch (name) {
    case 'goliath_create_tab':
      return { method: 'POST', path: '/tabs', responseKind: 'json', body: { url: args.url, userId, sessionKey: ctx.sessionKey } };
    case 'goliath_snapshot': {
      const query = new URLSearchParams({ userId, includeScreenshot: 'true' });
      if (args.offset != null) query.set('offset', String(args.offset));
      return { method: 'GET', path: tabPath(args.tabId, `/snapshot?${query}`), responseKind: 'snapshot' };
    }
    case 'goliath_observe':
      return { method: 'POST', path: tabPath(args.tabId, '/observe'), responseKind: 'json', body: { ...without(args), userId } };
    case 'goliath_plan_action': {
      const { snapshotId, nodeId, kind, text, secretId, key, allowedOrigins } = args;
      return {
        method: 'POST',
        path: tabPath(args.tabId, '/actions/plan'),
        responseKind: 'json',
        body: {
          userId,
          snapshotId,
          action: { nodeId, kind, text, secretId, key },
          policy: { allowedOrigins },
        },
      };
    }
    case 'goliath_execute_action':
      return { method: 'POST', path: tabPath(args.tabId, '/actions/execute'), responseKind: 'json', body: { ...without(args), userId } };
    case 'goliath_extract':
      return { method: 'POST', path: tabPath(args.tabId, '/extract'), responseKind: 'json', body: { ...without(args), userId, mode: 'semantic' } };
    case 'goliath_handoff':
      return { method: 'POST', path: tabPath(args.tabId, '/handoff'), responseKind: 'json', body: { ...without(args), userId } };
    case 'goliath_checkpoint':
      return { method: 'POST', path: `/sessions/${encodeURIComponent(userId)}/checkpoints`, responseKind: 'json', body: { ...args } };
    case 'goliath_fork':
      return { method: 'POST', path: `/sessions/${encodeURIComponent(userId)}/forks`, responseKind: 'json', body: { ...args } };
    case 'goliath_click':
    case 'goliath_type':
    case 'goliath_navigate':
    case 'goliath_scroll':
    case 'goliath_hands': {
      const action = name.slice('goliath_'.length);
      return { method: 'POST', path: tabPath(args.tabId, `/${action}`), responseKind: 'json', body: { ...without(args), userId } };
    }
    case 'goliath_behavior':
      return { method: 'GET', path: tabPath(args.tabId, `/behavior?${new URLSearchParams({ userId })}`), responseKind: 'json' };
    case 'goliath_act':
      return { method: 'POST', path: '/act', responseKind: 'json', body: { ...without(args), targetId: args.tabId, userId } };
    case 'goliath_upload':
      return { method: 'POST', path: tabPath(args.tabId, '/upload'), responseKind: 'json', body: { ...without(args), userId } };
    case 'goliath_screenshot': {
      const query = new URLSearchParams({ userId });
      if (args.fullPage != null) query.set('fullPage', String(args.fullPage));
      return { method: 'GET', path: tabPath(args.tabId, `/screenshot?${query}`), responseKind: 'image' };
    }
    case 'goliath_evaluate':
      return { method: 'POST', path: tabPath(args.tabId, '/evaluate'), responseKind: 'json', body: { userId, expression: args.expression } };
    case 'goliath_list_tabs':
      return { method: 'GET', path: `/tabs?${new URLSearchParams({ userId })}`, responseKind: 'json' };
    case 'goliath_close_tab':
      return { method: 'DELETE', path: tabPath(args.tabId, `?${new URLSearchParams({ userId })}`), responseKind: 'json' };
    case 'goliath_import_cookies':
      throw new Error('Cookie import must be built asynchronously');
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function buildCookieRequest(args, ctx, config) {
  if (!config.apiKey) {
    throw new Error('GOLIATH_API_KEY must be set for both the MCP bridge and REST server before importing cookies');
  }
  const cookiesDir = resolve(config.cookiesDir);
  const cookies = await readCookieFile({
    cookiesDir,
    cookiesPath: args.cookiesPath,
    domainSuffix: args.domainSuffix,
  });
  return {
    method: 'POST',
    path: `/sessions/${encodeURIComponent(ctx.userId)}/cookies`,
    responseKind: 'json',
    auth: 'apiKey',
    body: { cookies },
    meta: { imported: cookies.length, userId: ctx.userId },
  };
}

function bearerFor(spec, config) {
  if (spec.auth === 'apiKey') return config.apiKey;
  return config.accessKey;
}

export async function fetchRequest(baseUrl, spec, config) {
  const bearer = bearerFor(spec, config);
  const headers = {};
  if (spec.body) headers['Content-Type'] = 'application/json';
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const response = await fetch(`${baseUrl}${spec.path}`, {
    method: spec.method,
    headers,
    body: spec.body ? JSON.stringify(spec.body) : undefined,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Goliath REST ${response.status}: ${body}`);
  }
  if (spec.responseKind === 'image') {
    const mimeType = response.headers.get('content-type') || '';
    if (!mimeType.startsWith('image/')) throw new Error(`Screenshot returned ${mimeType || 'an unknown content type'}`);
    return { type: 'image', data: Buffer.from(await response.arrayBuffer()).toString('base64'), mimeType };
  }
  return response.json();
}

export function adaptResponse(spec, payload) {
  if (spec.responseKind === 'image') return [payload];
  if (spec.responseKind === 'snapshot') {
    const { screenshot, ...snapshot } = payload || {};
    const content = [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }];
    if (screenshot?.data) {
      content.push({ type: 'image', data: screenshot.data, mimeType: screenshot.mimeType || 'image/png' });
    }
    return content;
  }
  const result = spec.meta ? { ...spec.meta, result: payload } : payload;
  return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
}

export async function runTool(name, args, ctx, baseUrl, config) {
  const spec = name === 'goliath_import_cookies'
    ? await buildCookieRequest(args, ctx, config)
    : buildRequest(name, args, ctx);
  const payload = await fetchRequest(baseUrl, spec, config);
  return { spec, payload };
}
