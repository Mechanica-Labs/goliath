import { HARNESS_IDS } from './adapters/index.js';

const ALLOWED = new Set(HARNESS_IDS);

export class HarnessInstallUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HarnessInstallUsageError';
    this.exitCode = 64;
  }
}

function parseClients(value) {
  const clients = [...new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))];
  if (clients.length === 0) throw new HarnessInstallUsageError('--client requires a comma-separated client list');
  const unknown = clients.filter((client) => !ALLOWED.has(client));
  if (unknown.length) throw new HarnessInstallUsageError(`unknown client${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  return clients;
}

export function parseHarnessInstallArgs(argv = []) {
  const options = { clients: [], replaceExisting: false, dryRun: false, noConfig: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--client') {
      if (index + 1 >= argv.length) throw new HarnessInstallUsageError('--client requires a value');
      options.clients = parseClients(argv[index += 1]);
    } else if (arg.startsWith('--client=')) {
      options.clients = parseClients(arg.slice('--client='.length));
    } else if (arg === '--replace-existing') {
      options.replaceExisting = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--no-config') {
      options.noConfig = true;
    } else if (arg === '--json') {
      options.json = true;
    } else {
      throw new HarnessInstallUsageError(`unknown option: ${arg}`);
    }
  }
  if (options.replaceExisting && options.clients.length === 0) {
    throw new HarnessInstallUsageError('--replace-existing requires an explicit --client');
  }
  return options;
}
