// Session-only diagnostic UI. Reloading or restarting hides it again.
let unlocked = false;
let clicks = 0;
let lastClickAt = 0;
const listeners = new Set<() => void>();
export function updateSourcesVisible() { return unlocked; }
export function subscribeUpdateSourceAccess(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function clickUpdateVersion(now = Date.now()) {
  clicks = now - lastClickAt > 2000 ? 1 : clicks + 1;
  lastClickAt = now;
  if (clicks < 5) return false;
  clicks = 0;
  unlocked = !unlocked;
  listeners.forEach(listener => listener());
  return true;
}
