/**
 * MAIN-world hook.
 *
 * TikTok's own page code is the only thing that can produce a correctly signed
 * request to /api/.../item_list/ (X-Bogus / _signature / msToken are computed by
 * an obfuscated bundle that changes often). Rather than reimplement the signer,
 * we let the page make its normal requests and read the responses as they land.
 *
 * We also stash the last signed URL per endpoint and can replay it with a
 * different cursor ("background paging"), which is how a sync runs without
 * scrolling — and therefore without needing the tab in front of you. That fails
 * whenever TikTok validates the signature against the query string, so the
 * scroll harvest stays as the fallback rather than being replaced.
 *
 * Talks to collector.js (ISOLATED world) over window.postMessage only — MAIN
 * world has no access to chrome.runtime.
 */
(() => {
	'use strict';

	const TAG = 'ttarchive';
	const LIST_RE = /\/api\/(favorite|post|user\/collect|item)\/item_list\//;
	const DETAIL_RE = /\/api\/item\/detail\//;

	function endpointOf(url) {
		if (LIST_RE.test(url)) return url.match(LIST_RE)[1].replace('user/collect', 'collect');
		if (DETAIL_RE.test(url)) return 'detail';
		return null;
	}

	function emit(kind, payload) {
		try {
			window.postMessage({ __ttarchive: true, kind, payload }, '*');
		} catch (_) {
			/* payload was not structured-cloneable; nothing useful to do */
		}
	}

	/** Last signed URL we saw per endpoint — the seed every replay is built from. */
	const lastUrl = Object.create(null);

	function handle(url, bodyText) {
		const endpoint = endpointOf(url);
		if (!endpoint) return;
		let json;
		try {
			json = JSON.parse(bodyText);
		} catch (_) {
			return;
		}
		try {
			lastUrl[endpoint] = new URL(url, location.href).href;
		} catch (_) {}
		emit('capture', {
			endpoint,
			url,
			itemList: json.itemList || (json.itemInfo ? [json.itemInfo.itemStruct] : []),
			hasMore: json.hasMore === true || json.hasMore === 1,
			cursor: json.cursor != null ? String(json.cursor) : null,
			total: typeof json.total === 'number' ? json.total : null,
			statusCode: json.statusCode ?? json.status_code ?? 0,
		});
	}

	// --- fetch -------------------------------------------------------------
	const nativeFetch = window.fetch;
	window.fetch = function (...args) {
		const p = nativeFetch.apply(this, args);
		try {
			const req = args[0];
			const url = typeof req === 'string' ? req : req && req.url;
			if (url && endpointOf(url)) {
				p.then((res) => {
					res
						.clone()
						.text()
						.then((t) => handle(url, t))
						.catch(() => {});
				}).catch(() => {});
			}
		} catch (_) {}
		return p;
	};

	// --- XMLHttpRequest ----------------------------------------------------
	const nativeOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (method, url, ...rest) {
		this.__ttUrl = url;
		return nativeOpen.call(this, method, url, ...rest);
	};

	const nativeSend = XMLHttpRequest.prototype.send;
	XMLHttpRequest.prototype.send = function (...args) {
		try {
			if (this.__ttUrl && endpointOf(this.__ttUrl)) {
				this.addEventListener('load', () => {
					try {
						if (this.responseType === '' || this.responseType === 'text') {
							handle(this.__ttUrl, this.responseText);
						} else if (this.responseType === 'json') {
							handle(this.__ttUrl, JSON.stringify(this.response));
						}
					} catch (_) {}
				});
			}
		} catch (_) {}
		return nativeSend.apply(this, args);
	};

	// --- background paging -------------------------------------------------

	function cookie(name) {
		const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
		return m ? decodeURIComponent(m[1]) : null;
	}

	/**
	 * Re-sign a URL with TikTok's own signer, if this bundle still exposes it.
	 *
	 * Deliberately best-effort. Some builds validate X-Bogus against the query
	 * string (so a replay with a new cursor needs this), some don't care, and the
	 * global gets renamed often enough that not finding it must not be fatal —
	 * we try the plain replay anyway and let the response say whether it worked.
	 */
	function resign(u) {
		const ac = window.byted_acrawler;
		const sign = ac && (ac.sign || ac.frontierSign);
		if (typeof sign !== 'function') return false;
		try {
			const out = sign.call(ac, { url: u.href });
			const bogus = out && (out['X-Bogus'] || out['x-bogus'] || out.xBogus);
			if (typeof bogus === 'string' && bogus) {
				u.searchParams.set('X-Bogus', bogus);
				return true;
			}
		} catch (_) {}
		return false;
	}

	/**
	 * Ask for one page of a list directly, instead of making the page scroll.
	 *
	 * Runs in the MAIN world on purpose: `nativeFetch` here is the page's own
	 * fetch, so cookies, Origin and Referer are whatever TikTok expects, exactly
	 * as if the page had asked for the page itself.
	 */
	async function paginate(rid, { endpoint, cursor, count } = {}) {
		const reply = (payload) => emit('paginate-result', { rid, ...payload });
		const seed = lastUrl[endpoint];
		if (!seed) {
			reply({ ok: false, error: 'no signed request captured for this list yet' });
			return;
		}

		const u = new URL(seed);
		u.searchParams.set('cursor', String(cursor ?? 0));
		if (count) u.searchParams.set('count', String(count));
		// Rotated per request and set as a cookie by the page; a stale one in the
		// seed URL is one of the ways a replay gets rejected.
		const msToken = cookie('msToken');
		if (msToken) u.searchParams.set('msToken', msToken);
		resign(u);

		let res, text;
		try {
			res = await nativeFetch.call(window, u.href, { credentials: 'include' });
			text = await res.text();
		} catch (err) {
			reply({ ok: false, error: String((err && err.message) || err) });
			return;
		}
		if (!res.ok) {
			reply({ ok: false, error: `HTTP ${res.status}` });
			return;
		}

		let json;
		try {
			json = JSON.parse(text);
		} catch (_) {
			// A captcha or login wall comes back as HTML, not JSON.
			reply({ ok: false, error: 'the reply was not JSON — TikTok may be asking for a captcha' });
			return;
		}

		const status = json.statusCode ?? json.status_code ?? 0;
		if (status !== 0) {
			reply({ ok: false, error: `TikTok returned status ${status}` });
			return;
		}
		const items = json.itemList || [];
		const hasMore = json.hasMore === true || json.hasMore === 1;
		if (!items.length && hasMore) {
			// Signature rejected quietly: 200, status 0, nothing in it.
			reply({ ok: false, error: 'an empty page came back with more supposedly left' });
			return;
		}

		// Feed it through the same path a scrolled-for response takes, so the
		// collector normalizes and dedupes it without knowing where it came from.
		handle(u.href, text);
		reply({ ok: true, count: items.length, hasMore, cursor: json.cursor != null ? String(json.cursor) : null });
	}

	window.addEventListener('message', (ev) => {
		if (ev.source !== window) return;
		const d = ev.data;
		if (!d || d.__ttarchiveCmd !== true) return;
		if (d.kind === 'paginate') paginate(d.rid, d.payload || {});
	});

	// --- initial page state ------------------------------------------------
	// The logged-in user's id/secUid is embedded in the HTML; the collector needs
	// secUid to know which profile to open.
	function scrapeUniversalState() {
		const el =
			document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__') ||
			document.getElementById('SIGI_STATE');
		if (!el) return;
		try {
			const data = JSON.parse(el.textContent);
			const scope = data.__DEFAULT_SCOPE__ || {};
			const user =
				scope['webapp.user-detail']?.userInfo?.user ||
				data.UserModule?.users?.[Object.keys(data.UserModule?.users || {})[0]];
			const me = scope['webapp.app-context']?.user || null;
			emit('pagestate', {
				profileUser: user
					? {
							id: user.id,
							uniqueId: user.uniqueId,
							nickname: user.nickname,
							secUid: user.secUid,
						}
					: null,
				me: me ? { uid: me.uid, secUid: me.secUid, nickName: me.nickName } : null,
			});
		} catch (_) {}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', scrapeUniversalState, { once: true });
	} else {
		scrapeUniversalState();
	}
	// SPA navigations replace the blob without a document event.
	window.addEventListener('ttarchive:rescan', () => {
		emit('hooked', { href: location.href });
		scrapeUniversalState();
	});

	// Both content scripts run at document_start and MAIN goes first, so this
	// first emit lands before collector.js is listening. Repeat once it is.
	emit('hooked', { href: location.href });
	setTimeout(() => emit('hooked', { href: location.href }), 0);
})();
