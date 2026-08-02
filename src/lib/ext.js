/**
 * The extension API, under one name.
 *
 * Chromium's MV3 `chrome.*` returns promises. Gecko's `chrome.*` is the
 * callback-style compatibility alias — only `browser.*` returns promises there.
 * Preferring `browser` when it exists means every call site can just `await`.
 *
 * Classic scripts (background, content scripts, popup) can't import a module,
 * so they repeat this one line inline.
 */
export const ext = globalThis.browser ?? globalThis.chrome;
