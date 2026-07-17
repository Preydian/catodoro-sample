// Single source of truth for the mobile/desktop boundary.
//
// The desktop layout needs both enough width *and* enough height — a
// landscape phone is wider than a portrait phone but only ~390px tall, and
// the fixed-height desktop layout (with overflow-hidden, floating sticky
// notes that require Space+drag to pan, etc.) is unusable at that height.
// So "mobile" here means "narrow OR short", and "desktop" means "wide AND
// tall". The two constants below feed both the JS `useIsMobile()` hook and
// the Tailwind `desktop:` screen — see `tailwind.config.ts` for the
// matching CSS side, derived from these same constants so they can't drift.

const MOBILE_BREAKPOINT_PX = 768;

// 500px keeps every phone landscape (max ~480px on a 6.7" Android) in the
// mobile branch with headroom while leaving normal desktop setups
// (including a laptop with DevTools docked at the bottom, which usually
// leaves 600px+) on the desktop branch.
const DESKTOP_MIN_HEIGHT_PX = 500;

// matchMedia query string for "below the mobile breakpoint OR below the
// desktop min height". Comma-separated media queries are OR per the CSS
// spec. `max-width` / `max-height` are inclusive, so subtract a pixel to
// align with the `min-width` / `min-height` triggers used on the Tailwind
// `desktop:` side.
const MOBILE_MEDIA_QUERY = `(max-width: ${
  MOBILE_BREAKPOINT_PX - 1
}px), (max-height: ${DESKTOP_MIN_HEIGHT_PX - 1}px)`;

// matchMedia query string for "device has no hover capability" — true on
// touch-primary devices (phones, tablets) and false on devices with a mouse
// or trackpad. Used to gate affordances that would otherwise be invisible
// on touch (a button hidden behind `onMouseEnter`, for example).
const NO_HOVER_MEDIA_QUERY = '(hover: none)';

export {
  MOBILE_BREAKPOINT_PX,
  DESKTOP_MIN_HEIGHT_PX,
  MOBILE_MEDIA_QUERY,
  NO_HOVER_MEDIA_QUERY,
};
