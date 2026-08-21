export function pausedHandoff(tabState) {
  return tabState?.handoff?.status === 'paused' ? tabState.handoff : null;
}

export function findPausedHandoff(group) {
  if (!group) return null;
  for (const [tabId, tabState] of group) {
    const handoff = pausedHandoff(tabState);
    if (handoff) return { tabId, handoff };
  }
  return null;
}

export function findPausedHandoffInSession(session) {
  for (const [groupId, group] of session?.tabGroups || []) {
    const paused = findPausedHandoff(group);
    if (paused) return { ...paused, groupId };
  }
  return null;
}

export function handoffPausedError(handoff) {
  return Object.assign(new Error('tab paused for human handoff'), {
    statusCode: 423,
    code: 'handoff_paused',
    handoff,
  });
}
