// Pomodoro/break durations stored in sessionStorage. Validation guards a
// stale or hand-edited cache so the app never starts with NaN or negative
// timer values.

import { STORAGE_KEYS, safeParse } from './storage';

type Durations = {
  pomodoro: number;
  'short-break': number;
  'long-break': number;
};

const DEFAULT_DURATIONS: Durations = {
  pomodoro: 25 * 60,
  'short-break': 5 * 60,
  'long-break': 15 * 60,
};

// Bounds enforced everywhere a duration crosses a trust boundary: the
// settings form, sessionStorage loads, DB writes, and the user_settings
// CHECK constraint (migration 0008) — keep them in sync.
const MAX_DURATION_MINUTES = 120;
const MIN_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = MAX_DURATION_MINUTES * 60;

const isDurationInRange = (n: unknown): n is number =>
  typeof n === 'number' &&
  Number.isInteger(n) &&
  n >= MIN_DURATION_SECONDS &&
  n <= MAX_DURATION_SECONDS;

const isValidDurations = (raw: unknown): raw is Durations => {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    isDurationInRange(r.pomodoro) &&
    isDurationInRange(r['short-break']) &&
    isDurationInRange(r['long-break'])
  );
};

// Round a worked-seconds value up to the nearest whole minute, floored at one
// minute. Used by the "finished early" flow to size a cat to the time actually
// worked (e.g. 37m40s worked → a 38-minute cat; a few seconds → 1 minute).
const roundUpWorkedSeconds = (elapsedSeconds: number) =>
  Number.isFinite(elapsedSeconds)
    ? Math.max(MIN_DURATION_SECONDS, Math.ceil(elapsedSeconds / 60) * 60)
    : MIN_DURATION_SECONDS;

const clampDurationSeconds = (value: number, fallback: number) =>
  Number.isFinite(value)
    ? Math.min(
        MAX_DURATION_SECONDS,
        Math.max(MIN_DURATION_SECONDS, Math.round(value)),
      )
    : fallback;

const loadDurations = (): Durations => {
  const parsed = safeParse<unknown>(
    sessionStorage.getItem(STORAGE_KEYS.durations),
    null,
  );
  return isValidDurations(parsed) ? parsed : DEFAULT_DURATIONS;
};

export {
  DEFAULT_DURATIONS,
  MAX_DURATION_MINUTES,
  MIN_DURATION_SECONDS,
  MAX_DURATION_SECONDS,
  clampDurationSeconds,
  roundUpWorkedSeconds,
  isValidDurations,
  loadDurations,
};
export type { Durations };
