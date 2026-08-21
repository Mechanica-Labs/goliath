// Terminal UI toolkit for Goliath's CLI surfaces (installer, postinstall, server banner).
//
// Design constraints:
//   1. Zero dependencies. This module runs during `npm install`, before the
//      dependency tree is guaranteed to be complete, so it cannot import
//      anything outside node: builtins.
//   2. Degrades instead of corrupting. Every decorative feature (color,
//      box-drawing glyphs, spinners, in-place progress bars) is gated on a
//      capability probe. In a pipe, a CI log, or a dumb terminal the output
//      is plain single-line text with no escape sequences and no redraws.
//   3. Injectable. `createTui()` takes the stream and env so behavior can be
//      asserted in tests without touching the real process streams.
//
// The default export is a lazily-constructed instance bound to process.stdout.

import { platform } from 'node:os';

const ESC = '\x1b[';

const GRADIENT_START = [124, 58, 237];  // violet
const GRADIENT_END = [34, 211, 238];    // cyan

// figlet "ANSI Regular" rendering of GOLIATH; 53 columns wide.
const WORDMARK = [
  ' ██████   ██████  ██      ██  █████  ████████ ██   ██ ',
  '██       ██    ██ ██      ██ ██   ██    ██    ██   ██ ',
  '██   ███ ██    ██ ██      ██ ███████    ██    ███████ ',
  '██    ██ ██    ██ ██      ██ ██   ██    ██    ██   ██ ',
  ' ██████   ██████  ███████ ██ ██   ██    ██    ██   ██ ',
];

const UNICODE_SYMBOLS = {
  ok: '✔', fail: '✖', warn: '▲', info: 'ℹ', bullet: '•', arrow: '›',
  pending: '◌', barFull: '█', barEmpty: '░', mid: '·',
  tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│',
};

const ASCII_SYMBOLS = {
  ok: 'v', fail: 'x', warn: '!', info: 'i', bullet: '*', arrow: '>',
  pending: 'o', barFull: '#', barEmpty: '.', mid: '-',
  tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|',
};

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Detect usable color depth as a bit count: 0 (none), 4 (16 colors),
 * 8 (256 colors), or 24 (truecolor).
 *
 * Precedence follows the de-facto cross-tool convention: the NO_COLOR standard
 * (https://no-color.org) wins over everything, then explicit FORCE_COLOR, then
 * terminal capability sniffing. A non-TTY stream gets 0 so redirected output
 * and CI logs stay free of escape sequences unless FORCE_COLOR opts in.
 */
export function colorDepth(env = process.env, stream = process.stdout) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0;
  if (env.TERM === 'dumb') return 0;

  const forced = env.FORCE_COLOR;
  if (forced !== undefined) {
    if (forced === '0' || forced === 'false') return 0;
    if (forced === '3' || forced === 'truecolor') return 24;
    if (forced === '2') return 8;
    return 4;
  }

  if (!stream?.isTTY) return 0;
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 24;
  if (/-256(color)?$/i.test(env.TERM || '')) return 8;
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'Apple_Terminal') return 8;
  if (env.WT_SESSION) return 24;
  return 4;
}

/**
 * Decide whether box-drawing and braille glyphs will render.
 *
 * Legacy Windows consoles (cmd.exe, PowerShell on conhost) use a codepage that
 * mangles them, so Windows only qualifies when a modern host announces itself.
 * Elsewhere the locale has to advertise UTF-8; an unset locale is treated as
 * capable because that is the common case in containers that do render UTF-8.
 */
export function supportsUnicode(env = process.env, plat = platform()) {
  if (env.GOLIATH_ASCII === '1' || env.GOLIATH_ASCII === 'true') return false;
  if (plat === 'win32') return Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuTask);
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  if (!locale) return true;
  return /UTF-?8$/i.test(locale);
}

/** Remove SGR/CSI sequences so width math counts only printable cells. */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/** Printable width of a string, ignoring escape sequences. */
export function visibleWidth(text) {
  return stripAnsi(text).length;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function lerpChannel(from, to, ratio) {
  return Math.round(from + (to - from) * ratio);
}

/** Sample the brand gradient at `ratio` in [0,1] and return an RGB triple. */
function gradientAt(ratio) {
  const clamped = Math.min(1, Math.max(0, ratio));
  return [
    lerpChannel(GRADIENT_START[0], GRADIENT_END[0], clamped),
    lerpChannel(GRADIENT_START[1], GRADIENT_END[1], clamped),
    lerpChannel(GRADIENT_START[2], GRADIENT_END[2], clamped),
  ];
}

/** Map an RGB triple onto the 6x6x6 region of the xterm-256 cube. */
function rgbTo256(r, g, b) {
  const axis = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * axis(r) + 6 * axis(g) + axis(b);
}

export function createTui({ stream = process.stdout, env = process.env, plat = platform() } = {}) {
  const depth = colorDepth(env, stream);
  const unicode = supportsUnicode(env, plat);
  const sym = unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS;
  const interactive = Boolean(stream?.isTTY) && depth > 0;

  const wrap = (open, text) => (depth === 0 ? String(text) : `${ESC}${open}m${text}${ESC}0m`);

  const style = {
    bold: (t) => wrap(1, t),
    dim: (t) => wrap(2, t),
    italic: (t) => wrap(3, t),
    red: (t) => wrap(31, t),
    green: (t) => wrap(32, t),
    yellow: (t) => wrap(33, t),
    blue: (t) => wrap(34, t),
    magenta: (t) => wrap(35, t),
    cyan: (t) => wrap(36, t),
    gray: (t) => wrap(90, t),
  };

  /** Colorize with a truecolor/256 value, degrading to a plain 16-color hue. */
  function rgb(text, [r, g, b], fallback = style.cyan) {
    if (depth >= 24) return `${ESC}38;2;${r};${g};${b}m${text}${ESC}0m`;
    if (depth >= 8) return `${ESC}38;5;${rgbTo256(r, g, b)}m${text}${ESC}0m`;
    if (depth > 0) return fallback(text);
    return String(text);
  }

  const width = () => Math.min(stream?.columns || 80, 88);

  const write = (text) => { stream.write(text); };
  const line = (text = '') => { stream.write(`${text}\n`); };

  /** Paint each character of `text` along the brand gradient. */
  function gradientText(text) {
    if (depth === 0) return text;
    const chars = [...text];
    const span = Math.max(chars.length - 1, 1);
    return chars.map((ch, i) => (ch === ' ' ? ch : rgb(ch, gradientAt(i / span)))).join('');
  }

  /**
   * Full-width wordmark plus subtitle. Falls back to a one-line title when the
   * terminal is too narrow for the 53-column art or when glyphs are unavailable.
   */
  function banner(subtitle = '') {
    const cols = stream?.columns || 80;
    line();
    if (!unicode || cols < WORDMARK[0].length + 2) {
      line(`  ${gradientText('GOLIATH')}${subtitle ? style.gray(`  ${subtitle}`) : ''}`);
      line();
      return;
    }
    WORDMARK.forEach((row, i) => {
      line(`  ${depth === 0 ? row : rgb(row, gradientAt(i / (WORDMARK.length - 1)))}`);
    });
    if (subtitle) {
      line();
      line(`  ${style.gray(subtitle)}`);
    }
    line();
  }

  /** Horizontal separator with an optional inline label. */
  function rule(title = '') {
    const total = width();
    if (!title) return line(style.gray(sym.h.repeat(total)));
    const label = ` ${title} `;
    const fill = Math.max(total - label.length - 2, 0);
    line(style.gray(`${sym.h.repeat(2)}${label}${sym.h.repeat(fill)}`));
  }

  /**
   * Bordered block. `lines` may contain color codes; padding accounts for them.
   *
   * Every row is built to the same total width of `inner + 4`:
   * corner + space + inner + space + corner. The titled header spends
   * `title.length + 1` of its fill on the label, hence the asymmetric repeat.
   */
  function box(lines, { title = '', tone = style.gray, indent = '  ' } = {}) {
    const inner = Math.max(
      ...lines.map(visibleWidth),
      title ? title.length + 2 : 0,
      Math.min(width() - indent.length - 4, 56),
    );
    const head = title
      ? `${sym.tl}${sym.h} ${style.bold(title)} ${tone(sym.h.repeat(Math.max(inner - title.length - 1, 0)))}${sym.tr}`
      : `${sym.tl}${sym.h.repeat(inner + 2)}${sym.tr}`;
    line(indent + tone(head));
    for (const content of lines) {
      const pad = ' '.repeat(Math.max(inner - visibleWidth(content), 0));
      line(`${indent}${tone(sym.v)} ${content}${pad} ${tone(sym.v)}`);
    }
    line(indent + tone(`${sym.bl}${sym.h.repeat(inner + 2)}${sym.br}`));
  }

  /** Aligned two-column list, used for summaries and environment reports. */
  function kv(rows, { indent = '  ' } = {}) {
    const keyWidth = Math.max(...rows.map(([k]) => k.length));
    for (const [key, value] of rows) {
      line(`${indent}${style.gray(key.padEnd(keyWidth))}  ${value}`);
    }
  }

  const ok = (text) => line(`  ${style.green(sym.ok)} ${text}`);
  const fail = (text) => line(`  ${style.red(sym.fail)} ${text}`);
  const warn = (text) => line(`  ${style.yellow(sym.warn)} ${text}`);
  const info = (text) => line(`  ${style.cyan(sym.info)} ${text}`);
  const note = (text) => line(`    ${style.gray(text)}`);

  /** "[2/6] Label" step header. */
  function step(index, total, text) {
    line();
    line(`  ${style.gray(`[${index}/${total}]`)} ${style.bold(text)}`);
  }

  const clearLine = () => { if (interactive) write(`\r${ESC}2K`); };

  // A process killed mid-progress would otherwise leave the cursor hidden for
  // the rest of the shell session, so callers must pair these in a finally.
  const hideCursor = () => { if (interactive) write(`${ESC}?25l`); };
  const showCursor = () => { if (interactive) write(`${ESC}?25h`); };

  /**
   * Braille spinner. In a non-interactive stream it prints the label once and
   * every `update()` becomes a no-op, so build logs stay one line per phase.
   */
  function spinner(label) {
    let text = label;
    let frame = 0;
    let timer = null;

    const render = () => {
      clearLine();
      write(`  ${style.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length])} ${text}`);
      frame++;
    };

    if (interactive) {
      render();
      timer = setInterval(render, 80);
      if (typeof timer.unref === 'function') timer.unref();
    } else {
      line(`  ${sym.pending} ${text}`);
    }

    // The outcome line is printed in both modes: a TTY overwrites the spinner
    // frame, while a build log gets a second line. Suppressing it outside a TTY
    // would drop resolved versions and warnings from CI output entirely.
    const finish = (renderFinal) => {
      if (timer) clearInterval(timer);
      timer = null;
      if (interactive) clearLine();
      renderFinal();
    };

    return {
      // Outside a TTY there is no frame to repaint; the new label is picked up
      // by whichever outcome line runs next.
      update(next) { text = next; },
      succeed(message = text) { finish(() => ok(message)); },
      fail(message = text) { finish(() => fail(message)); },
      warn(message = text) { finish(() => warn(message)); },
      stop() { finish(() => {}); },
    };
  }

  /**
   * Byte-oriented progress bar with throughput and ETA.
   *
   * `total` may be null when the server withholds a content-length; the bar
   * then reports transferred bytes and speed without a percentage. Outside a
   * TTY it emits a milestone line every 10% instead of redrawing in place.
   */
  function progress({ label, total = null, startedAt = Date.now() } = {}) {
    let value = 0;
    let lastMilestone = -1;
    let lastPaint = 0;

    const paint = (force = false) => {
      const now = Date.now();
      const elapsed = Math.max(now - startedAt, 1);
      const speed = (value / elapsed) * 1000;

      if (!interactive) {
        if (!total) return;
        const milestone = Math.floor((value / total) * 10);
        if (milestone > lastMilestone) {
          lastMilestone = milestone;
          line(`  ${label} ${Math.round((value / total) * 100)}% (${formatBytes(value)} / ${formatBytes(total)})`);
        }
        return;
      }

      // Cap repaints at ~20fps; the download loop fires far more often than that.
      if (!force && now - lastPaint < 50) return;
      lastPaint = now;

      const stats = [];
      if (total) stats.push(`${formatBytes(value)} / ${formatBytes(total)}`);
      else stats.push(formatBytes(value));
      if (speed > 0) stats.push(`${formatBytes(speed)}/s`);
      if (total && speed > 0 && value < total) {
        stats.push(`ETA ${formatDuration(((total - value) / speed) * 1000)}`);
      }

      clearLine();
      if (total) {
        const barWidth = 28;
        const ratio = Math.min(value / total, 1);
        const filled = Math.round(barWidth * ratio);
        const bar = [...Array(barWidth)].map((_, i) => (
          i < filled ? rgb(sym.barFull, gradientAt(i / (barWidth - 1))) : style.gray(sym.barEmpty)
        )).join('');
        const pct = String(Math.round(ratio * 100)).padStart(3);
        write(`  ${label} ${bar} ${style.bold(`${pct}%`)}  ${style.gray(stats.join(`  ${sym.mid}  `))}`);
      } else {
        write(`  ${style.cyan(SPINNER_FRAMES[Math.floor(Date.now() / 80) % SPINNER_FRAMES.length])} ${label}  ${style.gray(stats.join(`  ${sym.mid}  `))}`);
      }
    };

    return {
      setTotal(next) { total = next; },
      advance(delta) { value += delta; paint(); },
      update(next) { value = next; paint(); },
      done(message) {
        if (interactive) {
          paint(true);
          clearLine();
        }
        if (message) ok(message);
      },
    };
  }

  return {
    depth, unicode, interactive, sym, style, rgb, width,
    write, line, banner, rule, box, kv,
    ok, fail, warn, info, note, step, spinner, progress,
    gradientText, hideCursor, showCursor,
  };
}

export default createTui();
