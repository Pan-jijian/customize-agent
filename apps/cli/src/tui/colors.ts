// @customize-agent/cli — ANSI 256-color 终端着色

const CSI = '\x1b[';

function c(text: string, code: number): string { return `${CSI}38;5;${code}m${text}${CSI}39m`; }
function cb(text: string, fg: number, bg: number): string { return `${CSI}38;5;${fg}m${CSI}48;5;${bg}m${text}${CSI}39;49m`; }

export const t = {
  accent:    (s: string) => c(s, 81),
  blue:      (s: string) => c(s, 69),
  purple:    (s: string) => c(s, 177),
  success:   (s: string) => c(s, 114),
  warning:   (s: string) => c(s, 222),
  error:     (s: string) => c(s, 210),
  white:     (s: string) => c(s, 255),
  text:      (s: string) => c(s, 252),
  dim:       (s: string) => c(s, 244),
  subtle:    (s: string) => c(s, 240),
  faint:     (s: string) => c(s, 236),
  selected:  (s: string) => cb(s, 255, 240),
  badge:     (s: string) => cb(s, 232, 81),
  planBadge: (s: string) => cb(s, 232, 69),
};

export const s = {
  bold:      (text: string) => `${CSI}1m${text}${CSI}22m`,
  dim:       (text: string) => `${CSI}2m${text}${CSI}22m`,
  italic:    (text: string) => `${CSI}3m${text}${CSI}23m`,
  inverse:   (text: string) => `${CSI}7m${text}${CSI}27m`,
  underline: (text: string) => `${CSI}4m${text}${CSI}24m`,
};

export function formatDuration(ms: number): string {
  const seconds = Math.max(ms / 1000, 0.1);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

export type Mode = 'AGENT' | 'PLAN';

export function modeAccent(mode: Mode): (s: string) => string {
  return mode === 'PLAN' ? t.blue : t.accent;
}

export function modeBadge(mode: Mode): string {
  return mode === 'PLAN' ? t.planBadge(` ${mode} `) : t.badge(` ${mode} `);
}
