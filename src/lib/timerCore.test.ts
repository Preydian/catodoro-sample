import { describe, it, expect } from 'vitest';
import {
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
} from './timerCore';
import type { TimerSnapshot } from './timerCore';
import type { Durations } from './durations';

const DURATIONS: Durations = {
  pomodoro: 1500,
  'short-break': 300,
  'long-break': 900,
};

const NOW = 1_752_200_000_000;

const idle = (): TimerSnapshot => createIdleSnapshot(DURATIONS);

const running = (overrides: Partial<TimerSnapshot> = {}): TimerSnapshot => ({
  ...idle(),
  endsAt: NOW + 1500 * 1000,
  pomodoroDuration: 1500,
  ...overrides,
});

describe('createIdleSnapshot', () => {
  it('starts paused at the full duration for the mode', () => {
    expect(idle()).toEqual({
      mode: 'pomodoro',
      endsAt: null,
      timeLeft: 1500,
      pomodoroCount: 0,
      pomodoroDuration: null,
      selectedTaskId: null,
    });
    expect(createIdleSnapshot(DURATIONS, 'long-break').timeLeft).toBe(900);
  });
});

describe('remainingSeconds', () => {
  it('derives from endsAt while running, rounding up partial seconds', () => {
    const snap = running({ endsAt: NOW + 4100 });
    expect(remainingSeconds(snap, NOW)).toBe(5);
  });

  it('clamps an elapsed countdown to zero', () => {
    const snap = running({ endsAt: NOW - 10_000 });
    expect(remainingSeconds(snap, NOW)).toBe(0);
  });

  it('reads timeLeft while paused', () => {
    expect(remainingSeconds({ ...idle(), timeLeft: 42 }, NOW)).toBe(42);
  });
});

describe('isTimerRunning / isTimerExpired', () => {
  it('running means endsAt is armed', () => {
    expect(isTimerRunning(idle())).toBe(false);
    expect(isTimerRunning(running())).toBe(true);
  });

  it('expired means the armed target has passed', () => {
    expect(isTimerExpired(idle(), NOW)).toBe(false);
    expect(isTimerExpired(running({ endsAt: NOW + 1 }), NOW)).toBe(false);
    expect(isTimerExpired(running({ endsAt: NOW }), NOW)).toBe(true);
    expect(isTimerExpired(running({ endsAt: NOW - 1 }), NOW)).toBe(true);
  });
});

describe('startTimer', () => {
  it('arms endsAt from the remaining time and captures the duration snapshot', () => {
    const next = startTimer({
      snapshot: idle(),
      durations: DURATIONS,
      now: NOW,
    });
    expect(next.endsAt).toBe(NOW + 1500 * 1000);
    expect(next.timeLeft).toBe(1500);
    expect(next.pomodoroDuration).toBe(1500);
  });

  it('resumes from a paused mid-session state without recapturing the snapshot', () => {
    const paused: TimerSnapshot = {
      ...idle(),
      timeLeft: 600,
      pomodoroDuration: 1500,
    };
    const next = startTimer({
      snapshot: paused,
      durations: DURATIONS,
      now: NOW,
    });
    expect(next.endsAt).toBe(NOW + 600 * 1000);
    expect(next.pomodoroDuration).toBe(1500);
  });

  it('restarts from the full duration when the countdown ran out', () => {
    const done: TimerSnapshot = { ...idle(), timeLeft: 0 };
    const next = startTimer({ snapshot: done, durations: DURATIONS, now: NOW });
    expect(next.timeLeft).toBe(1500);
    expect(next.endsAt).toBe(NOW + 1500 * 1000);
  });

  it('does not capture a pomodoro snapshot when starting a break', () => {
    const brk = createIdleSnapshot(DURATIONS, 'short-break');
    expect(
      startTimer({ snapshot: brk, durations: DURATIONS, now: NOW })
        .pomodoroDuration,
    ).toBeNull();
  });

  it('does not mutate the input snapshot', () => {
    const before = idle();
    startTimer({ snapshot: before, durations: DURATIONS, now: NOW });
    expect(before).toEqual(idle());
  });
});

describe('pauseTimer', () => {
  it('freezes the remaining seconds and clears endsAt', () => {
    const snap = running({ endsAt: NOW + 90_000 });
    const paused = pauseTimer(snap, NOW);
    expect(paused.endsAt).toBeNull();
    expect(paused.timeLeft).toBe(90);
    expect(paused.pomodoroDuration).toBe(1500);
  });
});

describe('resetTimer', () => {
  it('returns to the full duration and drops the session snapshot', () => {
    const reset = resetTimer(running({ pomodoroCount: 3 }), DURATIONS);
    expect(reset.endsAt).toBeNull();
    expect(reset.timeLeft).toBe(1500);
    expect(reset.pomodoroDuration).toBeNull();
    expect(reset.pomodoroCount).toBe(3);
  });
});

describe('switchTimerMode', () => {
  it('lands paused at the new mode duration and drops the session snapshot', () => {
    const next = switchTimerMode({
      snapshot: running(),
      mode: 'long-break',
      durations: DURATIONS,
    });
    expect(next.mode).toBe('long-break');
    expect(next.endsAt).toBeNull();
    expect(next.timeLeft).toBe(900);
    expect(next.pomodoroDuration).toBeNull();
  });
});

describe('applyDurationsChange', () => {
  it('re-displays the new duration while idle', () => {
    const next = applyDurationsChange(idle(), {
      ...DURATIONS,
      pomodoro: 3000,
    });
    expect(next.timeLeft).toBe(3000);
  });

  it('leaves a running countdown untouched', () => {
    const snap = running();
    expect(
      applyDurationsChange(snap, { ...DURATIONS, pomodoro: 3000 }),
    ).toEqual(snap);
  });

  it('leaves a paused mid-session snapshot untouched', () => {
    const paused: TimerSnapshot = {
      ...idle(),
      timeLeft: 600,
      pomodoroDuration: 1500,
    };
    expect(
      applyDurationsChange(paused, { ...DURATIONS, pomodoro: 3000 }),
    ).toEqual(paused);
  });
});

describe('selectTask', () => {
  it('sets and clears the credited task', () => {
    const withTask = selectTask(idle(), 'task-1');
    expect(withTask.selectedTaskId).toBe('task-1');
    expect(selectTask(withTask, null).selectedTaskId).toBeNull();
  });
});

describe('completionTransition', () => {
  it('first pomodoro flows into a short break', () => {
    const { next, completedMode, completedPomodoroSeconds } =
      completionTransition({
        snapshot: running(),
        durations: DURATIONS,
        autoStart: false,
        now: NOW,
      });
    expect(completedMode).toBe('pomodoro');
    expect(completedPomodoroSeconds).toBe(1500);
    expect(next.mode).toBe('short-break');
    expect(next.pomodoroCount).toBe(1);
    expect(next.timeLeft).toBe(300);
    expect(next.endsAt).toBeNull();
    expect(next.pomodoroDuration).toBeNull();
  });

  it('second pomodoro flows into a long break', () => {
    const { next } = completionTransition({
      snapshot: running({ pomodoroCount: 1 }),
      durations: DURATIONS,
      autoStart: false,
      now: NOW,
    });
    expect(next.mode).toBe('long-break');
    expect(next.pomodoroCount).toBe(2);
  });

  it('credits the captured duration snapshot, falling back to settings', () => {
    const captured = completionTransition({
      snapshot: running({ pomodoroDuration: 2400 }),
      durations: DURATIONS,
      autoStart: false,
      now: NOW,
    });
    expect(captured.completedPomodoroSeconds).toBe(2400);

    const fallback = completionTransition({
      snapshot: running({ pomodoroDuration: null }),
      durations: DURATIONS,
      autoStart: false,
      now: NOW,
    });
    expect(fallback.completedPomodoroSeconds).toBe(1500);
  });

  it('autoStart arms the break immediately', () => {
    const { next } = completionTransition({
      snapshot: running(),
      durations: DURATIONS,
      autoStart: true,
      now: NOW,
    });
    expect(next.endsAt).toBe(NOW + 300 * 1000);
  });

  it('a short break returns to a paused pomodoro, keeping the count', () => {
    const brk: TimerSnapshot = {
      ...createIdleSnapshot(DURATIONS, 'short-break'),
      endsAt: NOW,
      pomodoroCount: 1,
    };
    const { next, completedMode, completedPomodoroSeconds } =
      completionTransition({
        snapshot: brk,
        durations: DURATIONS,
        autoStart: false,
        now: NOW,
      });
    expect(completedMode).toBe('short-break');
    expect(completedPomodoroSeconds).toBeNull();
    expect(next.mode).toBe('pomodoro');
    expect(next.pomodoroCount).toBe(1);
    expect(next.endsAt).toBeNull();
    expect(next.pomodoroDuration).toBeNull();
  });

  it('a long break resets the pomodoro count', () => {
    const brk: TimerSnapshot = {
      ...createIdleSnapshot(DURATIONS, 'long-break'),
      endsAt: NOW,
      pomodoroCount: 2,
    };
    expect(
      completionTransition({
        snapshot: brk,
        durations: DURATIONS,
        autoStart: false,
        now: NOW,
      }).next.pomodoroCount,
    ).toBe(0);
  });

  it('autoStart into the next pomodoro recaptures the duration snapshot', () => {
    const brk: TimerSnapshot = {
      ...createIdleSnapshot(DURATIONS, 'short-break'),
      endsAt: NOW,
      pomodoroCount: 1,
    };
    const { next } = completionTransition({
      snapshot: brk,
      durations: DURATIONS,
      autoStart: true,
      now: NOW,
    });
    expect(next.endsAt).toBe(NOW + 1500 * 1000);
    expect(next.pomodoroDuration).toBe(1500);
  });

  it('preserves the selected task across the transition', () => {
    const snap = running({ selectedTaskId: 'task-9' });
    expect(
      completionTransition({
        snapshot: snap,
        durations: DURATIONS,
        autoStart: false,
        now: NOW,
      }).next.selectedTaskId,
    ).toBe('task-9');
  });
});

describe('workedSeconds', () => {
  it('is null on a break or when no pomodoro is in flight', () => {
    expect(workedSeconds(idle(), NOW)).toBeNull();
    const brk: TimerSnapshot = {
      ...createIdleSnapshot(DURATIONS, 'short-break'),
      pomodoroDuration: 1500,
    };
    expect(workedSeconds(brk, NOW)).toBeNull();
  });

  it('rounds the elapsed time up to a whole minute', () => {
    // 1500s session with 1130s remaining => 370s worked => 7 minutes
    const snap = running({ endsAt: NOW + 1_130_000 });
    expect(workedSeconds(snap, NOW)).toBe(420);
  });

  it('reads the frozen timeLeft while paused', () => {
    const paused: TimerSnapshot = {
      ...idle(),
      timeLeft: 1200,
      pomodoroDuration: 1500,
    };
    expect(workedSeconds(paused, NOW)).toBe(300);
  });

  it('floors a few worked seconds at one minute', () => {
    const snap = running({ endsAt: NOW + 1_495_000 });
    expect(workedSeconds(snap, NOW)).toBe(60);
  });
});

describe('timerSnapshotsEqual', () => {
  it('matches identical snapshots and catches any field diverging', () => {
    expect(timerSnapshotsEqual(running(), running())).toBe(true);
    expect(timerSnapshotsEqual(running(), running({ timeLeft: 1 }))).toBe(
      false,
    );
    expect(timerSnapshotsEqual(running(), running({ endsAt: null }))).toBe(
      false,
    );
    expect(
      timerSnapshotsEqual(running(), running({ selectedTaskId: 't' })),
    ).toBe(false);
  });
});

describe('isValidTimerSnapshot', () => {
  const valid = (): TimerSnapshot => ({
    mode: 'pomodoro',
    endsAt: NOW,
    timeLeft: 1500,
    pomodoroCount: 0,
    pomodoroDuration: 1500,
    selectedTaskId: 'task-1',
  });

  it('accepts a valid snapshot, including nullable fields', () => {
    expect(isValidTimerSnapshot(valid())).toBe(true);
    expect(
      isValidTimerSnapshot({
        ...valid(),
        endsAt: null,
        pomodoroDuration: null,
        selectedTaskId: null,
      }),
    ).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(isValidTimerSnapshot(null)).toBe(false);
    expect(isValidTimerSnapshot('x')).toBe(false);
  });

  it('rejects unknown modes', () => {
    expect(isValidTimerSnapshot({ ...valid(), mode: 'lunch' })).toBe(false);
  });

  it('rejects non-finite or non-positive endsAt', () => {
    expect(isValidTimerSnapshot({ ...valid(), endsAt: NaN })).toBe(false);
    expect(isValidTimerSnapshot({ ...valid(), endsAt: 0 })).toBe(false);
    expect(isValidTimerSnapshot({ ...valid(), endsAt: '123' })).toBe(false);
  });

  it('rejects invalid timeLeft', () => {
    expect(isValidTimerSnapshot({ ...valid(), timeLeft: -1 })).toBe(false);
    expect(isValidTimerSnapshot({ ...valid(), timeLeft: Infinity })).toBe(
      false,
    );
  });

  it('rejects fractional or negative pomodoroCount', () => {
    expect(isValidTimerSnapshot({ ...valid(), pomodoroCount: 1.5 })).toBe(
      false,
    );
    expect(isValidTimerSnapshot({ ...valid(), pomodoroCount: -1 })).toBe(false);
  });

  it('rejects non-positive pomodoroDuration', () => {
    expect(isValidTimerSnapshot({ ...valid(), pomodoroDuration: 0 })).toBe(
      false,
    );
  });

  it('rejects non-string selectedTaskId', () => {
    expect(isValidTimerSnapshot({ ...valid(), selectedTaskId: 7 })).toBe(false);
  });
});
