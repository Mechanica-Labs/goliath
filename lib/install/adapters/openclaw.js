import { join } from 'node:path';

import { PACKAGE_NAME } from '../state.js';
import { makeCommandAdapter } from './base.js';

export function openClawAdapter({ home, version, runCommand }) {
  return makeCommandAdapter({
    id: 'openclaw',
    identity: 'openclaw',
    executable: 'openclaw',
    version,
    runCommand,
    configPath: join(home, '.openclaw', 'openclaw.json'),
    add: () => ['openclaw', 'plugins', 'install', '--pin', `${PACKAGE_NAME}@${version}`],
    remove: () => ['openclaw', 'plugins', 'uninstall', '--force', 'goliath'],
    validate: () => ['openclaw', 'plugins', 'inspect', 'goliath'],
  });
}
