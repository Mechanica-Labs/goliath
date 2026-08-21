import { describe, expect, test } from '@jest/globals';
import { findPausedHandoff, findPausedHandoffInSession, handoffPausedError, pausedHandoff } from './handoff.js';

describe('human handoff mutation guards', () => {
  test('exposes a paused handoff so destructive tab routes can reject it', () => {
    const handoff = { handoffId: 'handoff-1', status: 'paused' };
    expect(pausedHandoff({ handoff })).toBe(handoff);
    expect(pausedHandoff({ handoff: { status: 'resumed' } })).toBeNull();
  });

  test('finds a paused tab before a tab group is deleted', () => {
    const group = new Map([
      ['ready-tab', { handoff: { status: 'resumed' } }],
      ['human-tab', { handoff: { handoffId: 'handoff-2', status: 'paused' } }],
    ]);

    expect(findPausedHandoff(group)).toEqual({
      tabId: 'human-tab',
      handoff: { handoffId: 'handoff-2', status: 'paused' },
    });
  });

  test('finds paused tabs across a whole session and creates a 423 guard error', () => {
    const handoff = { handoffId: 'handoff-3', status: 'paused' };
    const session = { tabGroups: new Map([
      ['default', new Map([['human-tab', { handoff }]])],
    ]) };
    expect(findPausedHandoffInSession(session)).toEqual({ groupId: 'default', tabId: 'human-tab', handoff });
    expect(handoffPausedError(handoff)).toMatchObject({ statusCode: 423, code: 'handoff_paused', handoff });
  });
});
