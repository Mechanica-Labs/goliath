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

function cloneEntry(entry) {
  return entry == null ? null : structuredClone(entry);
}

function ownershipError(id) {
  return new Error(`${id} Goliath entry has drifted; refusing to modify it`);
}

export function parseJsonCommandOutput(output, label) {
  try {
    return JSON.parse(String(output));
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

export function makeCommandAdapter({
  id,
  identity,
  version,
  entry: configuredEntry,
  executable,
  configPath,
  add,
  remove,
  read,
  parse,
  missing = () => false,
  canRestore = () => true,
  runCommand,
}) {
  const entry = configuredEntry || generatedMcpEntry(identity, version);
  async function currentEntry() {
    try {
      return cloneEntry(parse(await runCommand(read())));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async function validate(expected = entry) {
    if (!entriesEqual(await currentEntry(), expected)) throw ownershipError(id);
  }

  const adapter = {
    id,
    identity,
    executable,
    configPath,
    generatedEntry: () => cloneEntry(entry),
    currentEntry,
    existingEntry: currentEntry,
    supportsReplacement: (original) => canRestore(cloneEntry(original)),
    addCommand: () => add(entry),
    removeCommand: () => remove(),
    readCommand: () => read(),
    supportsMissingIntermediate: true,
    async apply(value = entry, options = {}) {
      if (Object.hasOwn(options, 'expected') && !entriesEqual(await currentEntry(), options.expected)) {
        throw ownershipError(id);
      }
      return runCommand(add(cloneEntry(value), options));
    },
    validate,
    async reconcile(expected, replacement = null) {
      if (!entriesEqual(await currentEntry(), expected)) throw ownershipError(id);
      // Reconciliation is deliberately resumable from the state between the
      // native client's remove and add commands. A process can die in that
      // window; on retry currentEntry() is null and removing it again may make
      // the client fail before the original entry can be restored.
      if (expected != null) await runCommand(remove());
      if (replacement != null) {
        if (!canRestore(replacement)) throw new Error(`${id} cannot safely restore the original entry`);
        await runCommand(add(cloneEntry(replacement), { replace: true }));
        await validate(replacement);
      } else if (await currentEntry() != null) {
        throw new Error(`${id} Goliath entry still exists after removal`);
      }
    },
    async remove(expected = entry) {
      return adapter.reconcile(expected, null);
    },
  };
  return adapter;
}
