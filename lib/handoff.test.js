import { describe, expect, test } from '@jest/globals';
import { findPausedHandoff, pausedHandoff } from './handoff.js';

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
});
