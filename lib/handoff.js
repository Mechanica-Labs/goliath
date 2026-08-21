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
