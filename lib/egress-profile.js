/**
 * Fleet egress (network-class) profiles for anti-bot walls.
 *
 * Anti-bot vendors classify the network before they look at the browser, so the
 * durable lever is which egress the fleet uses, not a per-site trick. This
 * module keeps named profiles, records how each profile actually fared against
 * each vendor, and picks the next profile to try. It performs no network access
 * and reads no process.env: callers pass configuration from lib/config.js.
 */

import fs from 'node:fs';
import path from 'node:path';

export const EGRESS_CLASSES = Object.freeze(['datacenter', 'residential', 'mobile', 'unknown']);
export const EGRESS_OUTCOMES = Object.freeze(['cleared', 'blocked', 'error']);

const KNOWN_CLEAR_ORDER = { residential: 0, mobile: 1, unknown: 2, datacenter: 3 };

function normalizeClass(value) {
  const raw = String(value || '').trim().toLowerCase();
  return EGRESS_CLASSES.includes(raw) ? raw : 'unknown';
}

/** Accepts an array of plain objects or a JSON string; ignores unusable entries. */
export function normalizeEgressProfiles(input) {
  let list = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return [];
    try { list = JSON.parse(text); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const profiles = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    profiles.push({
      name,
      class: normalizeClass(item.class || item.networkClass || item.ipClass),
      server: item.server ? String(item.server) : null,
      username: item.username ? String(item.username) : null,
      password: item.password ? String(item.password) : null,
      provider: item.provider ? String(item.provider) : null,
      country: item.country ? String(item.country) : null,
      city: item.city ? String(item.city) : null,
      notes: item.notes ? String(item.notes) : null,
    });
  }
  return profiles;
}

function emptyState() { return { version: 1, profiles: {}, updatedAt: null }; }

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.profiles !== 'object') return emptyState();
    return { version: 1, profiles: parsed.profiles || {}, updatedAt: parsed.updatedAt || null };
  } catch { return emptyState(); }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export class EgressRegistry {
  constructor({ profiles = [], stateDir = null, now = Date.now } = {}) {
    this.profiles = normalizeEgressProfiles(profiles);
    this.now = now;
    this.file = stateDir ? path.join(stateDir, 'egress-profiles.json') : null;
    this.state = this.file ? readState(this.file) : emptyState();
  }

  list() { return this.profiles.map(p => ({ ...p })); }

  get(name) { return this.profiles.find(p => p.name === name) || null; }

  has(name) { return this.profiles.some(p => p.name === name); }

  record(name, vendor, outcome) {
    if (!name || !vendor) return null;
    const key = String(vendor).toLowerCase();
    const value = EGRESS_OUTCOMES.includes(outcome) ? outcome : 'error';
    const entry = this.state.profiles[name] || (this.state.profiles[name] = {});
    const vendorEntry = entry[key] || (entry[key] = { cleared: 0, blocked: 0, error: 0, lastOutcome: null, lastSeenAt: null });
    vendorEntry[value] = (vendorEntry[value] || 0) + 1;
    vendorEntry.lastOutcome = value;
    vendorEntry.lastSeenAt = new Date(this.now()).toISOString();
    this.state.updatedAt = vendorEntry.lastSeenAt;
    if (this.file) { try { writeState(this.file, this.state); } catch { /* state file is best-effort */ } }
    return vendorEntry;
  }

  outcomesFor(name, vendor) {
    const entry = this.state.profiles[name];
    if (!entry) return null;
    return entry[String(vendor).toLowerCase()] || null;
  }

  /** Every profile with its per-vendor record, for reports and the docs matrix. */
  matrix() {
    return this.profiles.map(profile => {
      const entry = this.state.profiles[profile.name] || {};
      const vendors = {};
      for (const [vendor, record] of Object.entries(entry)) vendors[vendor] = { ...record };
      return { name: profile.name, class: profile.class, provider: profile.provider, country: profile.country, vendors };
    });
  }

  /** Profiles this vendor keeps blocking: recorded dead ends for the current network. */
  deadEndsFor(vendor, { minBlocks = 2 } = {}) {
    const key = String(vendor).toLowerCase();
    return this.matrix()
      .filter(row => (row.vendors[key]?.blocked || 0) >= minBlocks && !(row.vendors[key]?.cleared > 0))
      .map(row => row.name);
  }

  /**
   * Pick the next profile to try for a vendor: never repeat the current one,
   * prefer a class with a recorded clear, then a better network class, and skip
   * recorded dead ends unless nothing else is left.
   */
  nextFor(vendor, currentName, { skip = [] } = {}) {
    const key = String(vendor).toLowerCase();
    const skipSet = new Set([currentName, ...skip].filter(Boolean));
    const candidates = this.profiles.filter(p => !skipSet.has(p.name));
    if (!candidates.length) return null;
    const ranked = candidates.map(profile => {
      const record = this.outcomesFor(profile.name, vendor) || {};
      const cleared = record.cleared || 0;
      const blocked = record.blocked || 0;
      const deadEnd = cleared === 0 && blocked >= 2;
      let score = KNOWN_CLEAR_ORDER[profile.class] ?? 2;
      if (cleared > 0) score -= 10;
      if (deadEnd) score += 100;
      if (profile.class === 'residential' && blocked === 0) score -= 1;
      return { profile, score };
    });
    ranked.sort((a, b) => a.score - b.score);
    return ranked[0].profile;
  }
}

export function createEgressRegistry(options = {}) {
  return new EgressRegistry(options);
}

/** Markdown table of what cleared and what did not, for docs/ANTIBOT_WALLS.md. */
export function renderMatrix(registry, { vendors = null } = {}) {
  const rows = registry.matrix();
  const vendorNames = vendors || [...new Set(rows.flatMap(r => Object.keys(r.vendors)))].sort();
  const header = ['Profile', 'Class', ...vendorNames];
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of rows) {
    const cells = vendorNames.map(vendor => {
      const record = row.vendors[vendor];
      if (!record) return 'untested';
      const parts = [];
      if (record.cleared) parts.push(`${record.cleared} cleared`);
      if (record.blocked) parts.push(`${record.blocked} blocked`);
      if (record.error) parts.push(`${record.error} error`);
      return parts.length ? `${parts.join(', ')} (${record.lastOutcome})` : 'untested';
    });
    lines.push(`| ${row.name} | ${row.class} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}
