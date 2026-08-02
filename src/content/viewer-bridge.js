/**
 * Bridge between a generated viewer.html and the extension.
 *
 * Chromium is the only target: it will run a content script on a `file://` page
 * once the user ticks "Allow access to file URLs" on the extension's card, which
 * is why this is registered in manifest.json and not manifest.firefox.json.
 * Gecko has never run extensions on local files, and adding a `file:///*` match
 * pattern there is rejected outright.
 *
 * That permission covers *every* local file the user opens, so this bails on the
 * first line unless the document is one of ours, and the extension checks the
 * token before answering anything. The token is not a secret — it is sitting in
 * a file on disk — but it does mean another local page can't drive the archiver
 * just by copying the meta tag's name.
 *
 * The page talks over window.postMessage rather than being injected into,
 * because there is nothing here the page needs beyond a request and a reply.
 */

const ext = globalThis.browser ?? globalThis.chrome;

const marker = document.querySelector('meta[name="ttarchive-viewer"]');
const token = marker && marker.content;

if (token) {
	window.addEventListener('message', (ev) => {
		if (ev.source !== window) return;
		const msg = ev.data;
		if (!msg || typeof msg !== 'object' || msg.__ttarchive !== 'req') return;
		if (typeof msg.rid !== 'number') return;

		const reply = (payload) => window.postMessage({ __ttarchive: 'res', rid: msg.rid, payload }, '*');

		let sending;
		try {
			sending = ext.runtime.sendMessage({
				type: 'viewer-request',
				token,
				cmd: String(msg.cmd || ''),
				args: msg.args || {},
			});
		} catch (err) {
			// Throws synchronously if the extension was reloaded under this page.
			reply({ ok: false, error: 'extension-gone' });
			return;
		}

		Promise.resolve(sending).then(
			(res) => reply(res || { ok: false, error: 'no response' }),
			(err) => reply({ ok: false, error: String((err && err.message) || err) })
		);
	});

	// The page's own script runs before this content script does, so its opening
	// probe goes unheard. This is what tells it to try again.
	window.postMessage({ __ttarchive: 'bridge' }, '*');
}
