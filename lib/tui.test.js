import { test, expect, describe } from '@jest/globals';

import {
  BRAND,
  BRAND_HEX,
  colorDepth,
  createTui,
  formatBytes,
  formatDuration,
  stripAnsi,
  supportsUnicode,
  visibleWidth,
} from './tui.js';

function captureStream({ isTTY = false, columns = 100 } = {}) {
  const chunks = [];
  return {
    isTTY,
    columns,
    write: (text) => { chunks.push(text); return true; },
    output: () => chunks.join(''),
    lines: () => chunks.join('').split('\n'),
  };
}

const TTY_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' };

describe('colorDepth', () => {
  test('NO_COLOR disables color even on a truecolor TTY', () => {
    const stream = { isTTY: true };
    expect(colorDepth({ ...TTY_ENV, NO_COLOR: '1' }, stream)).toBe(0);
  });

  test('an empty NO_COLOR is ignored, per the spec', () => {
    expect(colorDepth({ ...TTY_ENV, NO_COLOR: '' }, { isTTY: true })).toBe(24);
  });

  test('a non-TTY stream gets no color', () => {
    expect(colorDepth(TTY_ENV, { isTTY: false })).toBe(0);
  });

  test('FORCE_COLOR overrides the non-TTY default', () => {
    expect(colorDepth({ FORCE_COLOR: '3' }, { isTTY: false })).toBe(24);
    expect(colorDepth({ FORCE_COLOR: '2' }, { isTTY: false })).toBe(8);
    expect(colorDepth({ FORCE_COLOR: '1' }, { isTTY: false })).toBe(4);
    expect(colorDepth({ FORCE_COLOR: '0' }, { isTTY: true })).toBe(0);
  });

  test('TERM=dumb disables color', () => {
    expect(colorDepth({ TERM: 'dumb' }, { isTTY: true })).toBe(0);
  });

  test('256-color terminals are detected', () => {
    expect(colorDepth({ TERM: 'screen-256color' }, { isTTY: true })).toBe(8);
  });

  test('iTerm uses native 24-bit color', () => {
    expect(colorDepth({ TERM_PROGRAM: 'iTerm.app' }, { isTTY: true })).toBe(24);
  });
});

describe('supportsUnicode', () => {
  test('legacy Windows consoles fall back to ASCII', () => {
    expect(supportsUnicode({}, 'win32')).toBe(false);
    expect(supportsUnicode({ WT_SESSION: 'x' }, 'win32')).toBe(true);
  });

  test('a non-UTF-8 locale falls back to ASCII', () => {
    expect(supportsUnicode({ LANG: 'en_US.ISO-8859-1' }, 'linux')).toBe(false);
    expect(supportsUnicode({ LANG: 'en_US.UTF-8' }, 'linux')).toBe(true);
  });

  test('GOLIATH_ASCII forces the ASCII symbol set', () => {
    expect(supportsUnicode({ LANG: 'en_US.UTF-8', GOLIATH_ASCII: '1' }, 'linux')).toBe(false);
  });
});

describe('formatting helpers', () => {
  test('formatBytes scales units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(312626286)).toBe('298 MB');
  });

  test('formatDuration scales units', () => {
    expect(formatDuration(4200)).toBe('4s');
    expect(formatDuration(95000)).toBe('1m 35s');
    expect(formatDuration(3_900_000)).toBe('1h 05m');
  });

  test('stripAnsi and visibleWidth ignore escape sequences', () => {
    const painted = '\x1b[32mok\x1b[0m';
    expect(stripAnsi(painted)).toBe('ok');
    expect(visibleWidth(painted)).toBe(2);
  });
});

describe('non-interactive rendering', () => {
  test('emits no escape sequences when the stream is not a TTY', () => {
    const stream = captureStream();
    const tui = createTui({ stream, env: { LANG: 'en_US.UTF-8' }, plat: 'linux' });
    tui.banner('subtitle');
    tui.ok('done');
    tui.box(['content'], { title: 'Ready' });
    expect(tui.interactive).toBe(false);
    expect(stream.output()).not.toContain('\x1b');
  });

  test('spinner does not redraw in place outside a TTY', () => {
    const stream = captureStream();
    const tui = createTui({ stream, env: {}, plat: 'linux' });
    const spinner = tui.spinner('working');
    spinner.update('still working');
    spinner.succeed('finished');

    // No carriage returns and no per-frame spam: a pending line plus an
    // outcome line, so build logs keep the result without the animation.
    const lines = stream.output().trim().split('\n');
    expect(stream.output()).not.toContain('\r');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('finished');
  });

  test('a stopped spinner prints no outcome line', () => {
    const stream = captureStream();
    const tui = createTui({ stream, env: {}, plat: 'linux' });
    tui.spinner('working').stop();
    expect(stream.output().trim().split('\n')).toHaveLength(1);
  });

  test('progress reports decile milestones instead of repainting', () => {
    const stream = captureStream();
    const tui = createTui({ stream, env: {}, plat: 'linux' });
    const bar = tui.progress({ label: 'Downloading', total: 1000 });
    for (let sent = 0; sent <= 1000; sent += 10) bar.update(sent);
    bar.done();

    const lines = stream.lines().filter(Boolean);
    expect(stream.output()).not.toContain('\r');
    expect(lines).toHaveLength(11); // 0%..100%
    expect(lines[0]).toContain('0%');
    expect(lines[10]).toContain('100%');
  });

  test('progress without a known total still reports nothing noisy', () => {
    const stream = captureStream();
    const tui = createTui({ stream, env: {}, plat: 'linux' });
    const bar = tui.progress({ label: 'Downloading', total: null });
    bar.update(5000);
    bar.done();
    expect(stream.output()).not.toContain('\r');
  });
});

describe('interactive rendering', () => {
  const ttyOptions = { env: { ...TTY_ENV }, plat: 'linux' };

  test('box rows all share the same printable width', () => {
    const stream = captureStream({ isTTY: true, columns: 100 });
    const tui = createTui({ stream, ...ttyOptions });
    tui.box(
      ['short', 'a considerably longer line of content than the first one'],
      { title: 'Ready' },
    );

    const widths = stream.lines().filter(Boolean).map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
  });

  test('box without a title also stays rectangular', () => {
    const stream = captureStream({ isTTY: true, columns: 100 });
    const tui = createTui({ stream, ...ttyOptions });
    tui.box(['one', 'two']);
    const widths = stream.lines().filter(Boolean).map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
  });

  test('box accounts for color codes when padding', () => {
    const stream = captureStream({ isTTY: true, columns: 100 });
    const tui = createTui({ stream, ...ttyOptions });
    tui.box([tui.style.bold('bold'), 'plain'], { title: 'T' });
    const widths = stream.lines().filter(Boolean).map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
  });

  test('progress repaints in place and reaches 100%', () => {
    const stream = captureStream({ isTTY: true, columns: 100 });
    const tui = createTui({ stream, ...ttyOptions });
    const bar = tui.progress({ label: 'Downloading', total: 1000, startedAt: Date.now() - 1000 });
    bar.update(1000);
    bar.done('Downloaded');

    const output = stream.output();
    expect(output).toContain('\r');
    expect(stripAnsi(output)).toContain('100%');
    expect(stripAnsi(output)).toContain('Downloaded');
  });

  test('cursor is restored after being hidden', () => {
    const stream = captureStream({ isTTY: true });
    const tui = createTui({ stream, ...ttyOptions });
    tui.hideCursor();
    tui.showCursor();
    expect(stream.output()).toBe('\x1b[?25l\x1b[?25h');
  });

  test('narrow terminals fall back to the compact wordmark', () => {
    const stream = captureStream({ isTTY: true, columns: 40 });
    const tui = createTui({ stream, ...ttyOptions });
    tui.banner('sub');
    expect(stripAnsi(stream.output())).toContain('GOLIATH');
    expect(stream.output()).not.toContain('██████');
  });

  test('ASCII mode avoids box-drawing glyphs entirely', () => {
    const stream = captureStream({ isTTY: true, columns: 100 });
    const tui = createTui({ stream, env: { ...TTY_ENV, GOLIATH_ASCII: '1' }, plat: 'linux' });
    tui.box(['x'], { title: 'T' });
    tui.ok('fine');
    expect(stream.output()).not.toMatch(/[┌┐└┘╭╮╰╯─│✔█░]/);
  });

  test('panels use hard corners, not rounded glass', () => {
    const stream = captureStream({ isTTY: true, columns: 100 });
    const tui = createTui({ stream, ...ttyOptions });
    tui.box(['x'], { title: 'Ready' });
    const out = stripAnsi(stream.output());
    expect(out).toMatch(/┌/);
    expect(out).toMatch(/└/);
    expect(out).not.toMatch(/[╭╮╰╯]/);
  });

  test('truecolor wordmark uses the purple-to-slime brand gradient', () => {
    const stream = captureStream({ isTTY: true, columns: 100 });
    const tui = createTui({ stream, ...ttyOptions });
    tui.banner('Agent-first browser automation server');
    const output = stream.output();
    expect(output).toContain(`38;2;${BRAND.purple.join(';')}`);
    expect(output).toContain(`38;2;${BRAND.slime.join(';')}`);
    expect(stripAnsi(output)).toContain('Agent-first browser automation server');
  });

  test('success, warning, and error hues follow the brand tokens', () => {
    const stream = captureStream({ isTTY: true, columns: 100 });
    const tui = createTui({ stream, ...ttyOptions });
    expect(tui.style.green('ok')).toContain(`38;2;${BRAND.slime.join(';')}`);
    expect(tui.style.yellow('warn')).toContain(`38;2;${BRAND.orange.join(';')}`);
    expect(tui.style.red('fail')).toContain(`38;2;${BRAND.danger.join(';')}`);
    expect(tui.style.cyan('info')).toContain(`38;2;${BRAND.cyan.join(';')}`);
    expect(tui.style.gray('muted')).toContain(`38;2;${BRAND.muted.join(';')}`);
  });

  test('native hex tokens match the brand package', () => {
    expect(BRAND_HEX).toMatchObject({
      void: '#050009',
      panel: '#16001F',
      slime: '#B8FF00',
      purple: '#C13CFF',
      orange: '#FF6A00',
      cyan: '#7DFFE0',
      ink: '#F7FFE7',
      muted: '#A78BB8',
      danger: '#FF3158',
    });
    expect(BRAND.slime).toEqual([184, 255, 0]);
    expect(BRAND.purple).toEqual([193, 60, 255]);
  });
});
