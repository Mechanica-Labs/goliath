export function beginSessionActivity(session, now = Date.now()) {
  session.activeOperations = (session.activeOperations || 0) + 1;
  session.lastAccess = now;
}

export function endSessionActivity(session, now = Date.now()) {
  session.activeOperations = Math.max(0, (session.activeOperations || 1) - 1);
  session.lastAccess = now;
}

export async function withSessionActivity(session, operation) {
  beginSessionActivity(session);
  try {
    return await operation();
  } finally {
    endSessionActivity(session);
  }
}

export function sessionHasPausedHandoff(session) {
  for (const group of session?.tabGroups?.values?.() || []) {
    for (const tabState of group.values()) {
      if (tabState?.handoff?.status === 'paused') return true;
    }
  }
  return false;
}

export function sessionCanBeReaped(session) {
  return !session._closing && !sessionHasPausedHandoff(session) && (session.activeOperations || 0) === 0;
}

export function removeSessionIfCurrent(sessions, key, session) {
  if (sessions.get(key) !== session) return false;
  sessions.delete(key);
  return true;
}
