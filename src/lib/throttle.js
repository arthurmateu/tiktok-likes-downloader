/**
 * Back-off shared by everything that talks to TikTok during a sync.
 *
 * The rule this encodes: a refusal has to make the extension quieter, never
 * louder. Before it existed, a 429 on one CDN mirror sent `fetchFirst` straight
 * to the next mirror with no delay — five more requests, same edge fleet, same
 * answer — times four parallel downloads. Being rate-limited accelerated us.
 *
 * Two outcomes, deliberately different:
 *
 *   pause  429 / 5xx / connection refusals. Everything parks for a growing
 *          interval and carries on afterwards.
 *   halt   A captcha or challenge page. No interval fixes that — it needs a
 *          human in the tab — so the run stops and says so, rather than
 *          switching to another request path and carrying on.
 *
 * Every request a sync makes carries the user's own logged-in session and
 * TikTok's own signing, so a limit tripped here is attributable to the account
 * and not just the IP. That is the reason for the conservative defaults, and
 * the reason a challenge stops the run instead of being retried around.
 *
 * The archive page and the collector each hold their own Guard, because they
 * live in different worlds and can't share an object. Whichever one is refused
 * first tells the other over the background relay, and `adopt` merges the two.
 */

/** First pause, doubling per consecutive hit. */
export const BASE_PAUSE_MS = 20_000;
export const MAX_PAUSE_MS = 10 * 60_000;

/** Parallel downloads meeting one limit are one event, not four. */
const COALESCE_MS = 5_000;

/** Clean requests needed to walk one level of back-off back down. */
const DECAY_AFTER = 20;

/**
 * Thrown by `Guard.pass` once a run is halted, so no caller can carry on
 * through a challenge by forgetting to check a flag.
 */
export class Halt extends Error {
	constructor(reason) {
		super(reason);
		this.name = 'Halt';
	}
}

export function jitter(ms, spread = 0.3) {
	return Math.round(ms * (1 + (Math.random() * 2 - 1) * spread));
}

/** Statuses that mean "slow down", as opposed to "this URL is no good". */
export function classifyStatus(status) {
	if (status === 429) return 'rate-limit';
	if (status === 502 || status === 503 || status === 504) return 'server';
	return null;
}

/** `Retry-After` in ms — seconds or an HTTP date, both are legal. */
export function retryAfterMs(headers) {
	const raw = headers && typeof headers.get === 'function' ? headers.get('Retry-After') : null;
	if (!raw) return 0;
	const secs = Number(raw);
	if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
	const at = Date.parse(raw);
	return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException('Aborted', 'AbortError'));
			return;
		}
		const t = setTimeout(done, ms);
		function done() {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}
		function onAbort() {
			clearTimeout(t);
			reject(new DOMException('Aborted', 'AbortError'));
		}
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export class Guard {
	/**
	 * @param {{onNotice?: (ev: {kind: string, waitMs: number, level: number, halted: string|null}) => void}} opts
	 *   Fires only for locally-originated events, never for `adopt` — otherwise
	 *   the two sides would echo each other's notices back and forth.
	 */
	constructor({ onNotice = () => {} } = {}) {
		this.onNotice = onNotice;
		this.until = 0;
		this.level = 0;
		this.halted = null;
		this.lastHit = 0;
		this.clean = 0;
	}

	get waitMs() {
		return Math.max(0, this.until - Date.now());
	}

	/** Call before every request. */
	async pass(signal) {
		if (this.halted) throw new Halt(this.halted);
		// Stepped rather than one long sleep, so a `reset` or a shorter pause
		// arriving from the other side takes effect instead of being slept through.
		while (this.waitMs > 0) {
			await sleep(Math.min(this.waitMs, 1000), signal);
			if (this.halted) throw new Halt(this.halted);
		}
	}

	/**
	 * Record a refusal. `hintMs` is a server-supplied `Retry-After`, which wins
	 * whenever it asks for longer than our own schedule.
	 */
	penalise(kind, hintMs = 0) {
		const now = Date.now();
		if (now - this.lastHit < COALESCE_MS && this.waitMs > 0) {
			if (hintMs) this.until = Math.max(this.until, now + jitter(hintMs));
			return this.waitMs;
		}
		this.lastHit = now;
		this.clean = 0;
		this.level = Math.min(this.level + 1, 8);
		const backoff = Math.min(BASE_PAUSE_MS * 2 ** (this.level - 1), MAX_PAUSE_MS);
		const until = now + jitter(Math.max(backoff, hintMs));
		if (until > this.until) this.until = until;
		this.onNotice({ kind, waitMs: this.waitMs, level: this.level, halted: this.halted });
		return this.waitMs;
	}

	/** A challenge: stop, and say why. */
	halt(reason) {
		if (this.halted) return;
		this.halted = reason;
		this.onNotice({ kind: 'challenge', waitMs: this.waitMs, level: this.level, halted: reason });
	}

	/** A request that came back clean. Walks the back-off down again. */
	ok() {
		if (!this.level) return;
		if (++this.clean >= DECAY_AFTER) {
			this.clean = 0;
			this.level -= 1;
		}
	}

	/** Merge in the other side's state. Never notifies — see the constructor. */
	adopt(snap) {
		if (!snap) return;
		if (snap.until > this.until) this.until = snap.until;
		if (snap.level > this.level) this.level = snap.level;
		if (snap.halted && !this.halted) this.halted = snap.halted;
	}

	snapshot() {
		return { until: this.until, level: this.level, halted: this.halted };
	}

	/** New run: forget everything, including a halt the user has since cleared. */
	reset() {
		this.until = 0;
		this.level = 0;
		this.halted = null;
		this.lastHit = 0;
		this.clean = 0;
	}
}
