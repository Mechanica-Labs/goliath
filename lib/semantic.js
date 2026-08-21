import crypto from 'node:crypto';

const REGION_ROLES = new Set([
  'banner', 'complementary', 'contentinfo', 'dialog', 'form', 'main',
  'navigation', 'region', 'search', 'table', 'list', 'grid',
]);

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'menuitem',
  'option', 'tab', 'searchbox', 'slider', 'spinbutton', 'switch',
]);

const INJECTION_PATTERNS = [
  { id: 'instruction_override', pattern: /\b(ignore|forget|override)\b.{0,40}\b(previous|system|developer|instructions?)\b/i, severity: 'high' },
  { id: 'secret_exfiltration', pattern: /\b(send|upload|reveal|copy|paste)\b.{0,50}\b(password|secret|token|api key|credential)\b/i, severity: 'high' },
  { id: 'agent_impersonation', pattern: /\b(system message|developer message|assistant instruction|you are an ai)\b/i, severity: 'medium' },
];

function shortHash(value, length = 16) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function normalizeText(value = '') {
  return String(value)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/\b\d{4,}\b/g, '#')
    .trim()
    .toLowerCase();
}

function routeTemplate(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname
      .split('/')
      .map(part => {
        if (/^\d+$/.test(part)) return ':n';
        if (/^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(part)) return ':id';
        if (/^[0-9a-f]{16,}$/i.test(part)) return ':id';
        return part;
      })
      .join('/');
    return `${parsed.origin}${path}`;
  } catch {
    return String(url || 'about:blank');
  }
}

function parseAttributes(suffix = '') {
  const attributes = {};
  for (const match of suffix.matchAll(/\[([\w-]+)(?:=([^\]]+))?\]/g)) {
    attributes[match[1]] = match[2] === undefined ? true : match[2].replace(/^['"]|['"]$/g, '');
  }
  return attributes;
}

function parseAriaSnapshot(yaml = '') {
  const nodes = [];
  const ancestry = [];

  for (const [lineIndex, line] of String(yaml).split('\n').entries()) {
    const match = line.match(/^(\s*)-\s+([\w-]+)(?:\s+"([^"]*)")?(?:\s+\[(e\d+)\])?(.*)$/);
    if (!match) continue;

    const [, whitespace, rawRole, rawName = '', ref = null, suffix = ''] = match;
    const depth = Math.floor(whitespace.length / 2);
    const role = rawRole.toLowerCase();
    const name = rawName || '';
    const attributes = parseAttributes(suffix);
    const valueMatch = suffix.match(/:\s*(.+)$/);

    while (ancestry.length > depth) ancestry.pop();
    const parentIndex = ancestry.length ? ancestry[ancestry.length - 1] : null;
    const node = {
      index: nodes.length,
      lineIndex,
      depth,
      parentIndex,
      role,
      name,
      normalizedName: normalizeText(name),
      value: valueMatch ? valueMatch[1].trim() : null,
      ref,
      attributes,
      interactive: INTERACTIVE_ROLES.has(role),
    };
    nodes.push(node);
    ancestry[depth] = node.index;
    ancestry.length = depth + 1;
  }
  return nodes;
}

function regionFor(node, nodes) {
  let current = node;
  while (current) {
    if (REGION_ROLES.has(current.role)) {
      return `${current.role}:${current.normalizedName}`;
    }
    current = current.parentIndex == null ? null : nodes[current.parentIndex];
  }
  return 'document';
}

function semanticKey(node, nodes, route) {
  const region = regionFor(node, nodes);
  const stableState = Object.entries(node.attributes)
    .filter(([key]) => ['checked', 'disabled', 'expanded', 'level', 'pressed', 'selected'].includes(key))
    .sort(([a], [b]) => a.localeCompare(b));
  return [route, region, node.role, node.normalizedName, JSON.stringify(stableState)].join('|');
}

function matchScore(node, candidate) {
  if (node.role !== candidate.role) return 0;
  let score = 0.25;
  const candidateName = candidate.normalizedName ?? normalizeText(candidate.name);
  if (node.normalizedName && node.normalizedName === candidateName) score += 0.4;
  if (node.regionKey === candidate.regionKey) score += 0.15;
  if (node.depth === candidate.depth) score += 0.05;
  if (node.parentSemanticId && node.parentSemanticId === candidate.parentSemanticId) score += 0.1;
  if (node.index === candidate.index) score += 0.05;
  return Math.min(1, score);
}

function assignSemanticIds(nodes, { url, previous } = {}) {
  const route = routeTemplate(url);
  const previousNodes = previous?.nodes || [];
  const usedPrevious = new Set();
  const collisionCounts = new Map();

  for (const node of nodes) {
    node.regionKey = regionFor(node, nodes);
    node.parentSemanticId = node.parentIndex == null ? null : nodes[node.parentIndex]?.id || null;
    node.semanticKey = semanticKey(node, nodes, route);

    const candidates = previousNodes
      .filter(candidate => !usedPrevious.has(candidate.id) && candidate.role === node.role)
      .map(candidate => ({ candidate, score: matchScore(node, candidate) }))
      .sort((a, b) => b.score - a.score);

    const best = candidates[0];
    const runnerUp = candidates[1];
    const unambiguous = best && best.score >= 0.75 && (!runnerUp || best.score - runnerUp.score >= 0.1);
    if (unambiguous) {
      node.id = best.candidate.id;
      node.identityConfidence = Number(best.score.toFixed(3));
      node.matchedBy = ['previous_snapshot'];
      usedPrevious.add(best.candidate.id);
    } else {
      const collision = collisionCounts.get(node.semanticKey) || 0;
      collisionCounts.set(node.semanticKey, collision + 1);
      node.id = `sem_${shortHash(`${node.semanticKey}|${collision}`)}`;
      node.identityConfidence = previous ? 0.55 : 0.8;
      node.matchedBy = ['semantic_fingerprint'];
      if (best && best.score >= 0.5) {
        node.ambiguousCandidates = candidates.slice(0, 3).map(item => ({
          id: item.candidate.id,
          confidence: Number(item.score.toFixed(3)),
        }));
      }
    }
  }
  return nodes;
}

function nodePublicView(node, snapshotId, url, capturedAt) {
  const text = node.name || node.value || '';
  return {
    id: node.id,
    role: node.role,
    name: node.name,
    normalizedName: node.normalizedName,
    value: node.value,
    depth: node.depth,
    parentId: node.parentSemanticId,
    regionKey: node.regionKey,
    interactive: node.interactive,
    ref: node.ref,
    attributes: node.attributes,
    identityConfidence: node.identityConfidence,
    matchedBy: node.matchedBy,
    ...(node.ambiguousCandidates ? { ambiguousCandidates: node.ambiguousCandidates } : {}),
    provenance: {
      snapshotId,
      nodeId: node.id,
      source: 'accessibility',
      url,
      textHash: `sha256:${shortHash(text, 32)}`,
      capturedAt,
    },
    trust: { level: 'untrusted', origin: 'webpage' },
  };
}

function inferIntent(node) {
  if (!node.interactive) return null;
  const name = normalizeText(node.name);
  if (node.role === 'textbox' || node.role === 'searchbox') return name.includes('search') ? 'search-input' : 'text-input';
  if (node.role === 'link') return 'navigate';
  if (/checkout|buy|place order|pay/.test(name)) return 'purchase';
  if (/delete|remove/.test(name)) return 'destructive-action';
  if (/submit|continue|next|confirm/.test(name)) return 'primary-action';
  return node.role === 'button' ? 'activate' : `set-${node.role}`;
}

function diffSnapshots(previous, current) {
  if (!previous) return current.nodes.map(node => ({ op: 'add', nodeId: node.id, node }));
  const before = new Map(previous.nodes.map(node => [node.id, node]));
  const after = new Map(current.nodes.map(node => [node.id, node]));
  const changes = [];

  for (const [id, node] of after) {
    const prior = before.get(id);
    if (!prior) {
      changes.push({ op: 'add', nodeId: id, node });
      continue;
    }
    const fields = ['name', 'value', 'parentId', 'regionKey', 'attributes']
      .filter(field => JSON.stringify(prior[field]) !== JSON.stringify(node[field]));
    if (fields.length) changes.push({ op: 'update', nodeId: id, fields, node });
  }
  for (const [id] of before) {
    if (!after.has(id)) changes.push({ op: 'remove', nodeId: id });
  }
  return changes;
}

function buildSemanticSnapshot({ yaml, url, previous = null, capturedAt = new Date().toISOString(), readiness = null } = {}) {
  const effectivePrevious = previous && routeTemplate(previous.url) === routeTemplate(url) ? previous : null;
  const parsed = assignSemanticIds(parseAriaSnapshot(yaml), { url, previous: effectivePrevious });
  const snapshotId = `snap_${shortHash(`${url}|${capturedAt}|${parsed.map(node => `${node.id}:${node.name}:${node.value}`).join('|')}`)}`;
  const snapshot = {
    snapshotId,
    stateHash: `sha256:${shortHash(`${routeTemplate(url)}|${parsed.map(node => `${node.id}:${node.role}:${node.name}:${node.value}:${JSON.stringify(node.attributes)}`).join('|')}`, 32)}`,
    baseSnapshotId: effectivePrevious?.snapshotId || null,
    url,
    capturedAt,
    readiness,
    nodes: [],
    regions: [],
    collections: [],
    entities: [],
    affordances: [],
    capabilities: {
      semanticActions: true,
      snapshotDiffs: true,
      provenance: true,
      readiness: true,
      visualFallback: true,
      liveFork: false,
      universalUndo: false,
    },
  };
  snapshot.nodes = parsed.map(node => nodePublicView(node, snapshotId, url, capturedAt));
  snapshot.regions = snapshot.nodes
    .filter(node => REGION_ROLES.has(node.role))
    .map(node => ({ id: node.id, kind: node.role, name: node.name }));
  snapshot.collections = snapshot.nodes
    .filter(node => ['list', 'table', 'grid', 'tree'].includes(node.role))
    .map(node => ({
      id: node.id,
      kind: node.role,
      name: node.name,
      memberIds: snapshot.nodes.filter(candidate => candidate.parentId === node.id).map(candidate => candidate.id),
    }));
  snapshot.entities = snapshot.nodes
    .filter(node => ['listitem', 'row', 'article'].includes(node.role))
    .map(node => ({ id: node.id, type: node.role, name: node.name, regionKey: node.regionKey }));
  snapshot.affordances = snapshot.nodes
    .filter(node => node.interactive)
    .map(node => ({ nodeId: node.id, intent: inferIntent(node), identityConfidence: node.identityConfidence }));
  snapshot.security = {
    contentTrust: 'untrusted',
    policyEnforced: true,
    injectionSignals: snapshot.nodes.flatMap(node => INJECTION_PATTERNS
      .filter(rule => rule.pattern.test(`${node.name || ''} ${node.value || ''}`))
      .map(rule => ({ nodeId: node.id, rule: rule.id, severity: rule.severity }))),
  };
  snapshot.changes = diffSnapshots(effectivePrevious, snapshot);
  return snapshot;
}

function buildReadinessReport(signals = {}) {
  const normalized = {
    document: signals.document ? 1 : 0,
    networkQuiet: Math.max(0, Math.min(1, Number(signals.networkQuiet ?? 0))),
    domQuiet: Math.max(0, Math.min(1, Number(signals.domQuiet ?? 0))),
    layoutStable: Math.max(0, Math.min(1, Number(signals.layoutStable ?? 0))),
    busyIndicatorsGone: signals.busyIndicatorsGone ? 1 : 0,
    goalSatisfied: signals.goalSatisfied === undefined ? 0.5 : (signals.goalSatisfied ? 1 : 0),
  };
  const score = Number((
    normalized.document * 0.2 +
    normalized.networkQuiet * 0.2 +
    normalized.domQuiet * 0.2 +
    normalized.layoutStable * 0.15 +
    normalized.busyIndicatorsGone * 0.15 +
    normalized.goalSatisfied * 0.1
  ).toFixed(3));
  const reasons = [];
  if (!normalized.document) reasons.push('document_not_ready');
  if (normalized.networkQuiet < 0.8) reasons.push('network_active');
  if (normalized.domQuiet < 0.8) reasons.push('mutation_rate_high');
  if (normalized.layoutStable < 0.8) reasons.push('layout_unstable');
  if (!normalized.busyIndicatorsGone) reasons.push('busy_indicator_visible');
  if (!normalized.goalSatisfied) reasons.push('goal_not_satisfied');
  return { ready: score >= 0.85, score, signals: normalized, reasons, retryAfterMs: score >= 0.85 ? 0 : 350 };
}

function createReadinessTracker(page) {
  const state = { pending: 0, lastNetworkActivityAt: Date.now() };
  const ignored = /analytics|tracking|doubleclick|google-analytics|hotjar|segment|sentry/i;
  const onRequest = request => {
    if (ignored.test(request.url())) return;
    state.pending++;
    state.lastNetworkActivityAt = Date.now();
  };
  const onDone = request => {
    if (ignored.test(request.url())) return;
    state.pending = Math.max(0, state.pending - 1);
    state.lastNetworkActivityAt = Date.now();
  };
  page.on('request', onRequest);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);

  return {
    async sample({ goalSelector } = {}) {
      const now = Date.now();
      const pageSignals = await page.evaluate(({ goalSelector }) => {
        const root = globalThis;
        if (!root.__goliathSemanticReadiness) {
          const readiness = root.__goliathSemanticReadiness = { mutations: [], lastRects: new Map() };
          const observer = new MutationObserver(list => {
            const timestamp = performance.now();
            readiness.mutations.push(...list.map(() => timestamp));
            readiness.mutations = readiness.mutations.filter(item => timestamp - item < 2000);
          });
          observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        }
        const readiness = root.__goliathSemanticReadiness;
        const timestamp = performance.now();
        readiness.mutations = readiness.mutations.filter(item => timestamp - item < 1000);
        const busySelectors = [
          '[aria-busy="true"]', '[role="progressbar"]',
          '[class*="spinner" i]', '[class*="loading" i]', '[class*="skeleton" i]',
        ];
        const visible = element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const busy = busySelectors.some(selector => Array.from(document.querySelectorAll(selector)).some(visible));
        return {
          document: document.readyState === 'complete' || document.readyState === 'interactive',
          mutationCount: readiness.mutations.length,
          busy,
          goalSatisfied: goalSelector ? Boolean(document.querySelector(goalSelector)) : undefined,
        };
      }, { goalSelector }).catch(() => ({ document: false, mutationCount: 100, busy: true, goalSatisfied: false }));
      return buildReadinessReport({
        document: pageSignals.document,
        networkQuiet: state.pending === 0 && now - state.lastNetworkActivityAt >= 500 ? 1 : state.pending === 0 ? 0.7 : 0,
        domQuiet: pageSignals.mutationCount === 0 ? 1 : Math.max(0, 1 - pageSignals.mutationCount / 20),
        layoutStable: pageSignals.mutationCount <= 2 ? 1 : 0.5,
        busyIndicatorsGone: !pageSignals.busy,
        goalSatisfied: pageSignals.goalSatisfied,
      });
    },
    dispose() {
      page.off('request', onRequest);
      page.off('requestfinished', onDone);
      page.off('requestfailed', onDone);
    },
  };
}

export {
  buildReadinessReport,
  buildSemanticSnapshot,
  createReadinessTracker,
  diffSnapshots,
  normalizeText,
  parseAriaSnapshot,
  routeTemplate,
};
