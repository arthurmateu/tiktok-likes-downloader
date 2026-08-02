/**
 * MAIN-world hook.
 *
 * TikTok's own page code is the only thing that can produce a correctly signed
 * request to /api/.../item_list/ (X-Bogus / _signature / msToken are computed by
 * an obfuscated bundle that changes often). Rather than reimplement the signer,
 * we let the page make its normal requests and read the responses as they land.
 *
 * We also stash the last signed URL per endpoint so the archive page can *try*
 * replaying it with a different cursor ("fast mode"). That fails whenever TikTok
 * validates the signature against the query string, which is why interception
 * stays the primary path.
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

	function handle(url, bodyText) {
		const endpoint = endpointOf(url);
		if (!endpoint) return;
		let json;
		try {
			json = JSON.parse(bodyText);
		} catch (_) {
			return;
		}
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
