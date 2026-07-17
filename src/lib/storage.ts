// Sample-repo stub. In the full app, storage.ts centralises every
// sessionStorage key plus the safe JSON helpers shared across features; only
// what durations.ts imports is reproduced here (safeParse verbatim).

const STORAGE_KEYS = {
  durations: 'catodoro-durations',
} as const;

const safeParse = <T>(raw: string | null, fallback: T): T => {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export { STORAGE_KEYS, safeParse };
