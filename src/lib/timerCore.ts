// Pure pomodoro state machine shared by the web app and the browser
// extension. A snapshot fully describes the timer: while running, `endsAt`
// (an epoch-ms wall-clock target) is authoritative and clients derive the
// remaining time locally; while paused, `timeLeft` is authoritative. Every
// transition returns a new snapshot — nothing here touches storage, the DB,
// or the clock, so both runtimes (React and the extension service worker)
// stay in lockstep by construction and the logic is trivially testable.

import { roundUpWorkedSeconds } from './durations';
import type { Durations } from './durations';

type TimerMode = 'pomodoro' | 'short-break' | 'long-break';

const TIMER_MODES: readonly TimerMode[] = [
  'pomodoro',
  'short-break',
  'long-break',
];

// Completions observed within this window of the deadline are "live" and may
// auto-start the next phase. Anything older is a catch-up (reload, browser
// restart, machine wake): it completes exactly once and lands paused, so an
// unattended timer can never chain phases. Shared by every completion caller
// (web hook, extension service worker) so the policy can't drift.
const LIVE_COMPLETION_GRACE_MS = 30 * 1000;

type TimerSnapshot = {
  mode: TimerMode;
  // Epoch ms the countdown hits zero; null while paused/idle.
  endsAt: number | null;
  // Seconds remaining while paused; while running, the value armed at start
  // (display fallback only — endsAt is authoritative).
  timeLeft: number;
  // Completed pomodoros since the last long break; odd counts take a short
  // break, even counts a long one. A long break every 2 pomodoros (not
  // classic pomodoro's every 4) is a deliberate product choice.
  pomodoroCount: number;
  // Duration snapshot captured when the in-flight pomodoro started, so the
  // earned cat is sized to what the user actually ran even if they edit the
  // settings mid-session. Null when no pomodoro is in flight.
  pomodoroDuration: number | null;
  // The task the running pomodoro is credited to.
  selectedTaskId: string | null;
};

// What a completion transition produced, so the caller can run the right
// side effects (sound, notification, cat award) for the phase that ended.
type CompletionResult = {
  next: TimerSnapshot;
  completedMode: TimerMode;
  // Seconds the completed pomodoro is credited for; null when a break ended.
  completedPomodoroSeconds: number | null;
};

const createIdleSnapshot = (
  durations: Durations,
  mode: TimerMode = 'pomodoro',
): TimerSnapshot => ({
  mode,
  endsAt: null,
  timeLeft: durations[mode],
  pomodoroCount: 0,
  pomodoroDuration: null,
  selectedTaskId: null,
});

const isTimerRunning = (snapshot: TimerSnapshot) => snapshot.endsAt !== null;

const isTimerExpired = (snapshot: TimerSnapshot, now: number) =>
  snapshot.endsAt !== null && snapshot.endsAt <= now;

const remainingSeconds = (snapshot: TimerSnapshot, now: number) =>
  snapshot.endsAt !== null
    ? Math.max(0, Math.ceil((snapshot.endsAt - now) / 1000))
    : snapshot.timeLeft;

// Start (or resume) the countdown. A snapshot that ran out restarts from the
// full mode duration. The pomodoro duration snapshot is captured on the first
// start of a session and deliberately survives pause/resume.
const startTimer = ({
  snapshot,
  durations,
  now,
}: {
  snapshot: TimerSnapshot;
  durations: Durations;
  now: number;
}): TimerSnapshot => {
  const seconds =
    snapshot.timeLeft > 0 ? snapshot.timeLeft : durations[snapshot.mode];
  return {
    ...snapshot,
    endsAt: now + seconds * 1000,
    timeLeft: seconds,
    pomodoroDuration:
      snapshot.mode === 'pomodoro'
        ? snapshot.pomodoroDuration ?? durations.pomodoro
        : snapshot.pomodoroDuration,
  };
};

// Freeze the remaining time so resuming later recalculates from it instead of
// fast-forwarding through the pause window.
const pauseTimer = (snapshot: TimerSnapshot, now: number): TimerSnapshot => ({
  ...snapshot,
  endsAt: null,
  timeLeft: remainingSeconds(snapshot, now),
});

const resetTimer = (
  snapshot: TimerSnapshot,
  durations: Durations,
): TimerSnapshot => ({
  ...snapshot,
  endsAt: null,
  timeLeft: durations[snapshot.mode],
  pomodoroDuration: null,
});

const switchTimerMode = ({
  snapshot,
  mode,
  durations,
}: {
  snapshot: TimerSnapshot;
  mode: TimerMode;
  durations: Durations;
}): TimerSnapshot => ({
  ...snapshot,
  mode,
  endsAt: null,
  timeLeft: durations[mode],
  pomodoroDuration: null,
});

// Durations changed (the user saved settings, or a sign-in loaded them):
// re-display an idle, untouched timer at the new length. A running countdown
// keeps its wall-clock target and a paused mid-session keeps its remaining
// time — a settings change must never eat an in-flight session.
//
// Display-only by contract: callers must NOT persist the result to
// timer_state. Durations are themselves synced (user_settings), so every
// context derives the same idle display locally; writing it up would race
// the initial remote fetch and overwrite a timer another context is running.
const applyDurationsChange = (
  snapshot: TimerSnapshot,
  durations: Durations,
): TimerSnapshot =>
  snapshot.endsAt !== null || snapshot.pomodoroDuration !== null
    ? snapshot
    : { ...snapshot, timeLeft: durations[snapshot.mode] };

const selectTask = (
  snapshot: TimerSnapshot,
  selectedTaskId: string | null,
): TimerSnapshot => ({ ...snapshot, selectedTaskId });

// The countdown hit zero (observed live or discovered late). Produces the
// next phase: pomodoros alternate short/long breaks by count, a long break
// resets the count, and autoStart arms the next phase immediately. Catch-up
// callers (a completion discovered after the fact, e.g. on reload or browser
// restart) pass autoStart=false so an unattended timer never chains phases —
// one completion maximum, landing paused.
const completionTransition = ({
  snapshot,
  durations,
  autoStart,
  now,
}: {
  snapshot: TimerSnapshot;
  durations: Durations;
  autoStart: boolean;
  now: number;
}): CompletionResult => {
  if (snapshot.mode === 'pomodoro') {
    const pomodoroCount = snapshot.pomodoroCount + 1;
    const nextMode: TimerMode =
      pomodoroCount % 2 === 1 ? 'short-break' : 'long-break';
    return {
      next: {
        ...snapshot,
        mode: nextMode,
        endsAt: autoStart ? now + durations[nextMode] * 1000 : null,
        timeLeft: durations[nextMode],
        pomodoroCount,
        pomodoroDuration: null,
      },
      completedMode: 'pomodoro',
      completedPomodoroSeconds: snapshot.pomodoroDuration ?? durations.pomodoro,
    };
  }

  return {
    next: {
      ...snapshot,
      mode: 'pomodoro',
      endsAt: autoStart ? now + durations.pomodoro * 1000 : null,
      timeLeft: durations.pomodoro,
      pomodoroCount:
        snapshot.mode === 'long-break' ? 0 : snapshot.pomodoroCount,
      pomodoroDuration: autoStart ? durations.pomodoro : null,
    },
    completedMode: snapshot.mode,
    completedPomodoroSeconds: null,
  };
};

// Rounded-up seconds worked in the in-flight pomodoro, or null when none is
// in flight (break, or not yet started). Feeds the "finished early" flow.
const workedSeconds = (snapshot: TimerSnapshot, now: number) => {
  if (snapshot.mode !== 'pomodoro' || snapshot.pomodoroDuration === null) {
    return null;
  }
  return roundUpWorkedSeconds(
    snapshot.pomodoroDuration - remainingSeconds(snapshot, now),
  );
};

// Field-wise equality, used to drop realtime echoes of a client's own writes
// (adopting an identical remote state would be a pointless re-render and, mid
// completion, a confusing rollback).
const timerSnapshotsEqual = (a: TimerSnapshot, b: TimerSnapshot) =>
  a.mode === b.mode &&
  a.endsAt === b.endsAt &&
  a.timeLeft === b.timeLeft &&
  a.pomodoroCount === b.pomodoroCount &&
  a.pomodoroDuration === b.pomodoroDuration &&
  a.selectedTaskId === b.selectedTaskId;

// Trust-boundary validation for snapshots arriving from storage or the DB.
const isValidTimerSnapshot = (raw: unknown): raw is TimerSnapshot => {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.mode !== 'string' ||
    !(TIMER_MODES as readonly string[]).includes(r.mode)
  ) {
    return false;
  }
  if (
    r.endsAt !== null &&
    !(typeof r.endsAt === 'number' && Number.isFinite(r.endsAt) && r.endsAt > 0)
  ) {
    return false;
  }
  if (
    typeof r.timeLeft !== 'number' ||
    !Number.isFinite(r.timeLeft) ||
    r.timeLeft < 0
  ) {
    return false;
  }
  if (
    typeof r.pomodoroCount !== 'number' ||
    !Number.isInteger(r.pomodoroCount) ||
    r.pomodoroCount < 0
  ) {
    return false;
  }
  if (
    r.pomodoroDuration !== null &&
    !(
      typeof r.pomodoroDuration === 'number' &&
      Number.isFinite(r.pomodoroDuration) &&
      r.pomodoroDuration > 0
    )
  ) {
    return false;
  }
  if (r.selectedTaskId !== null && typeof r.selectedTaskId !== 'string') {
    return false;
  }
  return true;
};

export {
  LIVE_COMPLETION_GRACE_MS,
  TIMER_MODES,
  applyDurationsChange,
  completionTransition,
  createIdleSnapshot,
  isTimerExpired,
  isTimerRunning,
  isValidTimerSnapshot,
  pauseTimer,
  remainingSeconds,
  resetTimer,
  selectTask,
  startTimer,
  switchTimerMode,
  timerSnapshotsEqual,
  workedSeconds,
};
export type { CompletionResult, TimerMode, TimerSnapshot };
