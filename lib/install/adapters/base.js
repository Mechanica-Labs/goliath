import { PACKAGE_NAME } from '../state.js';

export function generatedMcpEntry(identity, version, environment = {}) {
  return {
    command: 'npx',
    args: ['-y', `${PACKAGE_NAME}@${version}`, 'mcp'],
    env: { ...environment, GOLIATH_USER_ID: identity },
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function entriesEqual(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function makeCommandAdapter({ id, identity, version, executable, configPath, add, remove, validate, runCommand }) {
  const entry = generatedMcpEntry(identity, version);
  return {
    id,
    identity,
    executable,
    configPath,
    generatedEntry: () => structuredClone(entry),
    addCommand: () => add(entry),
    removeCommand: () => remove(),
    validateCommand: () => validate(),
    async apply() {
      return runCommand(add(entry));
    },
    async validate() {
      return runCommand(validate());
    },
    async remove() {
      return runCommand(remove());
    },
  };
}
