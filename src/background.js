/**
 * Background relay (a service worker on Chromium, an event page on Gecko).
 *
 * Content scripts can't talk to the archive page directly, and the archive page
 * is where the storage backend lives — neither a service worker nor an event
 * page can call showDirectoryPicker or hold an <input> full of File objects. So
 * everything routes through here.
 *
 * Deliberately import-free: Gecko event pages load this as a classic script.
 */

// See src/lib/ext.js — Gecko only returns promises from `browser.*`.
const ext = globalThis.browser ?? globalThis.chrome;

const ARCHIVE_URL = ext.runtime.getURL('src/archive/archive.html');

/**
 * Every archive page: the tabs, and the one run out of sight for the Library
 * (see startEngine), which is the port with no `sender.tab`.
 *
 * @type {Set<chrome.runtime.Port>}
 */
const archivePorts = new Set();

/**
 * The page whose sync or song pass is running — one at a time, whichever page
 * started it. Two pages each holding archive.json in memory and both writing
 * it would leave whichever finished last, and lose the other's run.
 *
 * @type {chrome.runtime.Port | null}
 */
let syncHolder = null;

/** How the last run went, as the page that ran it put it — for a Library asking after it has gone. */
let lastRun = null;

ext.runtime.onConnect.addListener((port) => {
	if (port.name !== 'archive') return;
	archivePorts.add(port);
	port.onDisconnect.addListener(() => {
		archivePorts.delete(port);
		if (syncHolder === port) syncHolder = null;
		if (engine && engine.port === port) engine.port = null;
	});
	port.onMessage.addListener((msg) => handleArchiveMessage(msg, port));
	// A tab is now what holds the archive; one page holding it is enough.
	if (port.sender && port.sender.tab) closeIdleEngine();
});

/** An archive page open in a tab, if there is one. */
function archiveTab() {
	for (const port of archivePorts) if (port.sender && port.sender.tab) return port;
	return null;
}

function broadcast(type, payload, except = null) {
	for (const port of archivePorts) {
		if (port === except) continue;
		try {
			port.postMessage({ type, payload });
		} catch (_) {
			archivePorts.delete(port);
		}
	}
}

// ---------------------------------------------------------------- from content

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (!msg || !msg.type) return;

	// Checked before the broadcast below: these come from a tab too, but they are
	// requests with an answer, not collector output to fan out.
	if (msg.type === 'viewer-token') {
		// The version too, for the page run out of sight: its runtime has no getManifest.
		viewerToken().then((token) => sendResponse({ ok: true, token, version: ext.runtime.getManifest().version }));
		return true;
	}
	if (msg.type === 'viewer-request') {
		handleViewerRequest(msg).then(sendResponse);
		return true;
	}
	if (msg.type === 'open-archive') {
		openArchive().then(() => sendResponse({ ok: true }));
		return true;
	}
	if (msg.type === 'show-in-folder') {
		showInFolder(msg.path).then(sendResponse);
		return true;
	}
	if (msg.type === 'helper-ensure') {
		ensureHelper().then(sendResponse);
		return true;
	}
	if (msg.type === 'helper-root') {
		setHelperRoot(msg.root).then(sendResponse);
		return true;
	}

	// The collector's clock. Its own timers are clamped while its tab is in the
	// background — which is where we want that tab — and ours are not.
	if (msg.type === 'sleep') {
		const ms = Math.max(0, Math.min(60000, Number(msg.ms) || 0));
		setTimeout(() => sendResponse({ ok: true }), ms);
		return true;
	}
	if (msg.type === 'borrow-focus') {
		borrowFocus(sender.tab).then(sendResponse);
		return true;
	}
	if (msg.type === 'return-focus') {
		returnFocus(sender.tab).then(sendResponse);
		return true;
	}

	// Still fanned out below like any other, but a tab being got ready for a sync
	// may be waiting on exactly this — see ensureProfileTab.
	if (msg.type === 'collector-ready' && sender.tab) {
		for (const arrived of arrivalWatches) arrived(sender.tab.id, msg.payload && msg.payload.instance);
	}

	if (sender.tab) {
		broadcast(msg.type, { ...msg.payload, tabId: sender.tab.id });
	}
});

// ----------------------------------------------------------------- from viewer

/**
 * A generated viewer.html asking the archive page for something, relayed by
 * src/content/viewer-bridge.js.
 *
 * The token is issued once and kept here rather than in the page, so that a
 * local HTML file that isn't one of ours gets nothing but 'not-recognised' no
 * matter what meta tags it carries.
 */
const VIEWER_TOKEN_KEY = 'viewerToken';

async function viewerToken() {
	const stored = await ext.storage.local.get(VIEWER_TOKEN_KEY);
	if (stored && stored[VIEWER_TOKEN_KEY]) return stored[VIEWER_TOKEN_KEY];
	// Stable once issued: regenerating would silently orphan every viewer.html
	// already written into a folder.
	const token = crypto.randomUUID();
	await ext.storage.local.set({ [VIEWER_TOKEN_KEY]: token });
	return token;
}

let viewerReqId = 0;
/** @type {Map<number, (payload: any) => void>} */
const viewerWaiting = new Map();

function askArchivePage(port, cmd, args) {
	const rid = ++viewerReqId;
	return new Promise((resolve) => {
		viewerWaiting.set(rid, resolve);
		port.postMessage({ type: 'viewer-request', payload: { rid, cmd, args } });
		setTimeout(() => {
			if (viewerWaiting.delete(rid)) resolve({ ok: false, error: 'the archive page did not answer' });
		}, 30000);
	});
}

async function handleViewerRequest(msg) {
	if (!msg.token || msg.token !== (await viewerToken())) {
		return { ok: false, error: 'not-recognised' };
	}
	if (msg.cmd === 'open') {
		await openArchive();
		return { ok: true };
	}
	// Answered here, not by the archive page: the helper needs no folder handle,
	// so the button works with that page closed.
	if (msg.cmd === 'show-in-folder') return showInFolder(msg.args && msg.args.path);

	// Whoever is running a sync, so that its progress is what the Library sees;
	// then a tab; then the page already running out of sight.
	const page = syncHolder || archiveTab() || (engine && engine.port);
	if (page) {
		const res = await askArchivePage(page, msg.cmd, msg.args);
		// The last run may have been another page's — the one run out of sight,
		// closed since — and this worker heard about every run.
		if (msg.cmd === 'status' && res && res.ok && lastRun) res.lastRun = lastRun;
		return res;
	}

	// No page at all. With the helper one can be run out of sight, which is all a
	// sync needs — so the Library can start one with the archive page closed.
	const info = await engineCanRun();
	if (!info) return { ok: false, error: 'no-archive-page' };
	if (msg.cmd === 'status') {
		return { ok: true, ready: true, syncing: false, folder: folderLabel(info.root), lastRun };
	}
	if (msg.cmd === 'sync') {
		const started = await startEngine();
		if (!started.ok) return started;
		// A tab that opened meanwhile closed it again, and is as good to ask.
		const ready = syncHolder || archiveTab() || (engine && engine.port);
		if (!ready) return { ok: false, error: 'the archiver closed before the sync could start' };
		return askArchivePage(ready, msg.cmd, msg.args);
	}
	// 'state': nothing newer to give than what viewer.html was written with at the
	// end of the last run, which the Library already has.
	return { ok: false, error: 'no-archive-page' };
}

// -------------------------------------------------------------- out of sight

/**
 * The archive page, run as an offscreen document when the Library asks for a
 * sync with no archive tab open.
 *
 * A sync is the archive page's work: the list arrives there, and every file is
 * fetched there and written through its storage backend. Without the helper
 * that backend is a folder permission granted in a tab, which nothing out of
 * sight can ask for; with it, the folder is the helper's, and the same page can
 * do the whole run unseen. An offscreen document gets nothing but
 * chrome.runtime, and that is all the page needs once the helper is writing.
 *
 * Started by the first Sync from the Library, it closes itself once it has sat
 * idle for a while (ENGINE_IDLE_MS in archive.js), and is closed at once when an
 * archive tab opens — an idle one, that is; one mid-run finishes first.
 *
 * @type {{ port: chrome.runtime.Port | null, ready: Promise<any>, announce: (res: any) => void } | null}
 */
let engine = null;
const ENGINE_PATH = 'src/archive/archive.html?engine';
/** Long enough to read a big archive.json and list the folder behind it. */
const ENGINE_START_MS = 60000;

/** The helper's answer when a page can run out of sight, null when it can't. */
async function engineCanRun() {
	if (!ext.offscreen) return null;
	const info = await ensureHelper();
	return info.ok && info.rootOk ? info : null;
}

function folderLabel(path) {
	return String(path || '').split(/[\\/]/).filter(Boolean).pop() || path;
}

/** Resolves once the page has read the folder: `{ ok }`, or `{ ok: false, error }` saying why it couldn't. */
function startEngine() {
	if (engine) return engine.ready;
	const state = { port: null, ready: null, announce: null };
	state.ready = new Promise((resolve) => (state.announce = resolve));
	engine = state;

	ext.offscreen
		.createDocument({
			url: ENGINE_PATH,
			reasons: ['BLOBS'],
			justification: 'Runs a sync the archive’s Library asked for while the archive page is closed: fetches each post as a blob and hands it to the local helper to write.',
		})
		.catch(() => {
			// Already open: left by a worker before this one. It finds its way back
			// to this one by itself (see channel() in archive.js) and says so the same
			// way a new one does, so it is waited for like one.
		});

	const timer = setTimeout(
		() => state.announce({ ok: false, error: `the archiver did not start within ${ENGINE_START_MS / 1000}s` }),
		ENGINE_START_MS
	);
	state.ready.then((res) => {
		clearTimeout(timer);
		if (!res.ok && engine === state) closeEngine();
	});
	return state.ready;
}

function closeEngine() {
	engine = null;
	ext.offscreen.closeDocument().catch(() => {});
}

/** Unless it is mid-run, or still starting for a Sync that is waiting on it. */
function closeIdleEngine() {
	if (engine && engine.port && syncHolder !== engine.port) closeEngine();
}

// --------------------------------------------------------------- local helper

/**
 * tools/helper.py: everything the extension needs from outside the browser, as
 * one native-messaging host. Optional, and used whenever it is installed —
 * nothing to choose. Then it owns the archive folder (writes what the archive
 * page downloads, serves the folder on 127.0.0.1); either way it is what shows
 * a file in the system's file manager, which no extension API can do for a file
 * the browser didn't download.
 *
 * Started here and not by the archive page so that it outlives that page: the
 * Library's address keeps answering with the page closed. The pipe to it is
 * what keeps it running, and since Chromium 105 an open native port is also
 * what keeps this worker running — so in practice the helper is up for as long
 * as the browser is, and comes back with the worker if Chromium stops it.
 *
 * Gecko never runs it: its backend downloaded every file itself and asks
 * `downloads.show` instead.
 */
const HELPER_HOST = 'com.ttarchive.helper';
/** The command that installs the helper, as this system spells it; shown when it is missing. */
let helperSetup = 'python3 tools/helper.py install';
ext.runtime.getPlatformInfo().then((info) => {
	if (info.os === 'win') helperSetup = 'python tools\\helper.py install';
});
/** `{ token, root, port }` — the helper keeps nothing; everything it is told is here. */
const HELPER_KEY = 'helper';
/** Asked for first, so the Library's address stays the same from one start to the next. */
const HELPER_PORT = 8737;

/** @type {{ port: chrome.runtime.Port | null, ready: Promise<any> } | null} */
let helper = null;

const nativeMessaging = typeof ext.runtime.connectNative === 'function';

async function helperConfig() {
	const config = (await ext.storage.local.get(HELPER_KEY))[HELPER_KEY] || {};
	if (!config.token) {
		// Kept, not made fresh each start: it is also the cookie the Library tab
		// holds, and a new one would lock every open Library out.
		config.token = crypto.randomUUID();
		await ext.storage.local.set({ [HELPER_KEY]: config });
	}
	return config;
}

function helperProblem(text) {
	// Chromium's own wording: "Specified native messaging host not found." when
	// nothing is registered, "…is forbidden." when it is but not for this id.
	if (/not found|forbidden/i.test(text)) return { ok: false, error: 'no-helper', detail: text, setup: helperSetup };
	return { ok: false, error: text };
}

/** The helper, started if it isn't: `{ ok, base, token, root, rootOk }`. */
function ensureHelper() {
	if (!nativeMessaging) return Promise.resolve({ ok: false, error: 'no-helper' });
	if (helper) return helper.ready;
	const state = { port: null, ready: null };
	state.ready = (async () => {
		const config = await helperConfig();
		return new Promise((resolve) => {
			let port;
			try {
				port = ext.runtime.connectNative(HELPER_HOST);
			} catch (err) {
				resolve(helperProblem(String((err && err.message) || err)));
				return;
			}
			state.port = port;
			const timer = setTimeout(() => {
				resolve({ ok: false, error: 'the helper did not start within 15 seconds' });
				port.disconnect();
				if (helper === state) helper = null;
			}, 15000);
			port.onMessage.addListener((msg) => {
				if (!msg) return;
				clearTimeout(timer);
				if (msg.type !== 'ready') {
					resolve({ ok: false, error: msg.error || 'the helper would not start' });
					return;
				}
				// With no folder of its own yet it took over the one the browser's
				// picker chose. Kept, so it is this folder from now on and not whatever
				// that record says next time.
				if (msg.adopted && msg.root) {
					config.root = msg.root;
					ext.storage.local.set({ [HELPER_KEY]: config });
				}
				resolve({
					ok: true,
					base: `http://127.0.0.1:${msg.port}`,
					token: config.token,
					root: msg.root,
					rootOk: msg.rootOk,
					version: msg.version,
				});
			});
			port.onDisconnect.addListener(() => {
				clearTimeout(timer);
				// Read here or Chromium logs it as unchecked.
				const why = ext.runtime.lastError ? ext.runtime.lastError.message : 'the helper exited';
				if (helper === state) helper = null;
				resolve(helperProblem(why || 'the helper exited'));
			});
			port.postMessage({ cmd: 'start', token: config.token, root: config.root || null, port: config.port || HELPER_PORT });
		});
	})();
	helper = state;
	// A start that failed isn't kept: the next ask tries again, and the helper may
	// have been installed in between.
	state.ready.then((res) => {
		if (!res.ok && helper === state) helper = null;
	});
	return state.ready;
}

/**
 * Point the helper at another folder, or at none. The helper is asked first,
 * so a folder it can't use — gone by the time it looks — is never remembered.
 */
async function setHelperRoot(root) {
	const info = await ensureHelper();
	if (!info.ok) return info;
	let res;
	try {
		const reply = await fetch(`${info.base}/api/root`, {
			method: 'POST',
			headers: { 'X-Ttarchive-Token': info.token, 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: root || null }),
		});
		res = await reply.json();
	} catch (err) {
		return { ok: false, error: `could not reach the helper (${String((err && err.message) || err)})` };
	}
	if (!res || !res.ok) return res || { ok: false, error: 'the helper gave no answer' };

	const config = await helperConfig();
	config.root = res.root;
	config.port = Number(new URL(info.base).port);
	await ext.storage.local.set({ [HELPER_KEY]: config });

	const next = { ...info, root: res.root, rootOk: res.rootOk };
	if (helper && helper.port) helper.ready = Promise.resolve(next);
	return next;
}

/**
 * Show in folder. A helper process of its own per click, for the reason in
 * helper.py's docstring. `path` is archive-relative; the folder is the one the
 * helper writes, when it is the one writing, and otherwise the one the
 * browser's picker chose, which the helper reads out of the profile — File
 * System Access never says where anything is.
 */
async function showInFolder(path) {
	if (typeof path !== 'string' || !path) return { ok: false, error: 'no path' };
	const info = await ensureHelper();
	const root = info.ok && info.rootOk ? info.root : null;
	try {
		const res = await ext.runtime.sendNativeMessage(HELPER_HOST, { cmd: 'show', path, root });
		return res || { ok: false, error: 'the helper gave no answer' };
	} catch (err) {
		return helperProblem(String((err && err.message) || err));
	}
}

// Whenever this worker runs, so does the helper, if it is installed; see above.
ensureHelper();

// The archive page reloads the extension when it finds a worker older than
// itself, which closes the page; this is the new worker putting it back.
const REOPEN_KEY = 'reopenArchive';
ext.storage.local.get(REOPEN_KEY).then((stored) => {
	if (!stored[REOPEN_KEY]) return;
	ext.storage.local.remove(REOPEN_KEY);
	openArchive();
});

// ---------------------------------------------------------------- from archive

async function handleArchiveMessage(msg, port) {
	const reply = (payload) => port.postMessage({ type: 'reply', id: msg.id, payload });

	// An answer to a viewer request, not a request of its own — it resolves the
	// pending sendMessage instead of getting a reply.
	if (msg.cmd === 'viewer-response') {
		const resolve = viewerWaiting.get(msg.rid);
		if (resolve) {
			viewerWaiting.delete(msg.rid);
			resolve(msg.payload);
		}
		return;
	}

	// The page run out of sight, done reading the folder — or back after this
	// worker restarted, in which case it is one this worker never started.
	if (msg.cmd === 'engine-ready') {
		if (!engine) engine = { port: null, ready: Promise.resolve(msg), announce() {} };
		engine.port = port;
		engine.announce({ ok: !!msg.ok, error: msg.error || undefined });
		if (!msg.ok || archiveTab()) closeIdleEngine();
		return;
	}
	if (msg.cmd === 'engine-idle') {
		if (engine && engine.port === port) closeIdleEngine();
		return;
	}

	if (msg.cmd === 'claim-sync') {
		if (syncHolder && syncHolder !== port && archivePorts.has(syncHolder)) {
			reply({
				ok: false,
				error: syncHolder.sender && syncHolder.sender.tab
					? 'a sync is already running on the archiver page'
					: 'a sync started from the Library is already running in the background',
			});
		} else {
			syncHolder = port;
			reply({ ok: true });
		}
		return;
	}
	if (msg.cmd === 'release-sync') {
		if (syncHolder === port) syncHolder = null;
		if (msg.lastRun) lastRun = msg.lastRun;
		// Every other page is now holding an archive.json older than the one just
		// written, and would write it back over this run if it synced from it.
		broadcast('archive-changed', {}, port);
		if (archiveTab()) closeIdleEngine();
		reply({ ok: true });
		return;
	}

	// Chromium stops this worker after thirty seconds without an extension API
	// call or event, in-flight request or not, and the port dies with it. Most
	// of what is below finishes well inside that; ensure-profile need not — a
	// profile reload can sit between tab events for longer, with the archive
	// page still waiting on the reply. Any API call resets the clock, so one is
	// made every so often for as long as a request is being handled.
	const heartbeat = setInterval(() => {
		try {
			ext.runtime.getPlatformInfo();
		} catch (_) {}
	}, 20000);

	try {
		switch (msg.cmd) {
			case 'find-tiktok-tab':
				reply(await findTikTokTab());
				break;
			case 'ensure-profile':
				reply(await ensureProfileTab(msg.uniqueId, { background: !!msg.background }));
				break;
			case 'start-harvest':
				reply(await sendToTab(msg.tabId, { cmd: 'harvest', opts: msg.opts }));
				break;
			case 'stop-harvest':
				reply(await sendToTab(msg.tabId, { cmd: 'stop' }));
				break;
			// Downloads run on the archive page and the list is paged in the tab, so
			// a refusal met by one is news the other can't get any other way.
			case 'throttle':
				reply(await sendToTab(msg.tabId, { cmd: 'throttle', payload: msg.payload }));
				break;
			// The song pass's inner step, driven from the archive page in short asks
			// — see readPostPage there for why it is not one request here.
			case 'detail-tab':
				reply(await sendToTab(msg.tabId, { cmd: 'item-detail', id: msg.postId }));
				break;
			case 'navigate-tab':
				reply(await navigateTab(msg.tabId, msg.url));
				break;
			case 'ping-tab':
				reply(await sendToTab(msg.tabId, { cmd: 'ping' }));
				break;
			case 'focus-tab':
				await ext.tabs.update(msg.tabId, { active: true });
				reply({ ok: true });
				break;
			default:
				reply({ ok: false, error: `unknown command ${msg.cmd}` });
		}
	} catch (err) {
		reply({ ok: false, error: String((err && err.message) || err) });
	} finally {
		clearInterval(heartbeat);
	}
}

// ------------------------------------------------------------- borrowed focus

/**
 * Tabs we pulled to the front, and what was in front before.
 *
 * The collector borrows the foreground for the parts that genuinely need a
 * rendered page — finding the Liked tab, and the scroll fallback — and gives it
 * back afterwards. Best-effort: if this worker is restarted mid-sync the tab
 * just stays where it is, which is untidy but not broken.
 *
 * @type {Map<number, number|null>}
 */
const borrowedFocus = new Map();

async function borrowFocus(tab) {
	if (!tab) return { ok: false, error: 'no tab' };
	if (!borrowedFocus.has(tab.id)) {
		const [active] = await ext.tabs.query({ active: true, windowId: tab.windowId });
		borrowedFocus.set(tab.id, active && active.id !== tab.id ? active.id : null);
	}
	try {
		await ext.tabs.update(tab.id, { active: true });
	} catch (_) {
		return { ok: false, error: 'tab is gone' };
	}
	return { ok: true };
}

async function returnFocus(tab) {
	if (!tab || !borrowedFocus.has(tab.id)) return { ok: true, restored: false };
	const previous = borrowedFocus.get(tab.id);
	borrowedFocus.delete(tab.id);
	if (previous == null) return { ok: true, restored: false };
	try {
		await ext.tabs.update(previous, { active: true });
	} catch (_) {
		/* the user closed it in the meantime */
	}
	return { ok: true, restored: true };
}

async function sendToTab(tabId, message) {
	try {
		const res = await ext.tabs.sendMessage(tabId, message);
		return res || { ok: false, error: 'no response' };
	} catch (err) {
		return { ok: false, error: String((err && err.message) || err) };
	}
}

async function findTikTokTab() {
	const tabs = await ext.tabs.query({ url: ['*://*.tiktok.com/*'] });
	const results = [];
	for (const t of tabs) {
		const ping = await sendToTab(t.id, { cmd: 'ping' });
		results.push({ tabId: t.id, url: t.url, title: t.title, ...ping });
	}
	return { ok: true, tabs: results };
}

/**
 * Make sure a tab is sitting on the given profile. Reuses an existing TikTok tab
 * so we don't pile up windows across repeated syncs.
 *
 * In background mode it only reuses a tab already on that profile — normally the
 * one an earlier sync left behind. Navigating away from whatever the user is
 * watching is exactly the interruption background mode exists to avoid.
 */
async function ensureProfileTab(uniqueId, { background = false } = {}) {
	const target = `https://www.tiktok.com/@${uniqueId}`;

	/**
	 * The profile itself, not merely something underneath it.
	 *
	 * `/@user/photo/123` starts with `/@user` and is not the profile — and the
	 * song pass leaves the tab on exactly that. Reusing one "in place" reloads it
	 * rather than navigating, so a sync that mistook a post page for the profile
	 * would reload the post and then wait out its timeout for a list request that
	 * page never makes.
	 */
	const isProfile = (url) => {
		if (!(url || '').startsWith(target)) return false;
		const rest = url.slice(target.length);
		return rest === '' || rest === '/' || rest.startsWith('?') || rest.startsWith('#');
	};

	const tabs = await ext.tabs.query({ url: ['*://*.tiktok.com/*'] });
	// In background mode a tab already sitting on this profile is the only one
	// worth having; otherwise any TikTok tab will do and gets navigated. A tab the
	// song pass parked on a post counts as neither, and is navigated like any other.
	const onProfile = tabs.find((t) => isProfile(t.url));
	let tab = background ? onProfile || tabs.find((t) => (t.url || '').startsWith(target)) : onProfile || tabs[0];
	const reusedInPlace = !!tab && isProfile(tab.url);

	// Begun before the tab is touched, so that a page quick enough to announce
	// itself before the call below returns is not missed.
	const arrivals = watchArrivals();
	try {
		if (!tab) {
			tab = await ext.tabs.create({ url: target, active: !background });
		} else if (!reusedInPlace) {
			tab = await ext.tabs.update(tab.id, { url: target, active: !background });
		} else {
			if (!background) await ext.tabs.update(tab.id, { active: true });
			// A tab left behind by an earlier sync is still holding that run's cursor
			// and its set of already-seen ids. Both are wrong now: paging would resume
			// from the end of the last run, and anything it remembers seeing would be
			// filtered out before the archive page ever hears about it.
			await ext.tabs.reload(tab.id);
		}

		// Either way the page that was there is on its way out, and it goes on
		// answering pings — ready as ever — until the new one replaces it. Asked too
		// early, it is the old page that says yes, the harvest is started on it, and
		// it is destroyed a moment later: the run collects nothing and never hears
		// another word. So nothing is asked until the new page has said it is here.
		//
		// This used to be a wait for the tab to stop reporting `complete`, given
		// three seconds. A page that has sat in a background tab for days can take
		// longer than that to let go — its renderer has been pushed down the queue,
		// and the reload does not begin until it has run its unload handlers — and
		// that is the first sync after a long while failing where the next one, on
		// a page now minutes old, went through.
		if (!(await arrivals.from(tab.id, ARRIVAL_MS))) {
			return {
				ok: false,
				tabId: tab.id,
				error: `the TikTok tab did not load the profile within ${ARRIVAL_MS / 1000}s`,
			};
		}
		await waitForComplete(tab.id);
		for (let i = 0; i < 20; i++) {
			const ping = await sendToTab(tab.id, { cmd: 'ping' });
			if (ping.ok && arrivals.isNew(tab.id, ping.instance)) return { ok: true, tabId: tab.id, ping };
			await new Promise((r) => setTimeout(r, 500));
		}
		return { ok: false, tabId: tab.id, error: 'content script never responded' };
	} finally {
		arrivals.stop();
	}
}

/** How long a reloaded or redirected tab is given to bring its new page up. */
const ARRIVAL_MS = 30000;

/**
 * Collectors that start up while this is listening, by tab.
 *
 * Each announces itself as its page begins, under an id of its own, and every
 * ping it answers carries the same id. A page that announced itself after a
 * reload was asked for is the new page; any other answer is from the one being
 * left behind.
 *
 * @type {Set<(tabId: number, instance: string) => void>}
 */
const arrivalWatches = new Set();

function watchArrivals() {
	/** @type {Map<number, Set<string>>} */
	const seen = new Map();
	let wake = null;
	const arrived = (tabId, instance) => {
		if (!instance) return;
		if (!seen.has(tabId)) seen.set(tabId, new Set());
		seen.get(tabId).add(instance);
		if (wake) wake();
	};
	arrivalWatches.add(arrived);
	return {
		/** True once a new page is up in the tab; false if none is by `timeout`. */
		from(tabId, timeout) {
			return new Promise((resolve) => {
				const done = (ok) => {
					clearTimeout(timer);
					wake = null;
					resolve(ok);
				};
				const timer = setTimeout(() => done(false), timeout);
				wake = () => {
					if (seen.has(tabId)) done(true);
				};
				wake();
			});
		},
		isNew: (tabId, instance) => !!instance && !!seen.get(tabId)?.has(instance),
		stop: () => arrivalWatches.delete(arrived),
	};
}

/** Point a tab somewhere without bringing it forward. */
async function navigateTab(tabId, url) {
	try {
		await ext.tabs.update(tabId, { url, active: false });
	} catch (_) {
		return { ok: false, error: 'the TikTok tab has been closed' };
	}
	return { ok: true };
}

function waitForComplete(tabId) {
	return new Promise((resolve) => {
		const check = async () => {
			try {
				const t = await ext.tabs.get(tabId);
				if (t.status === 'complete') {
					ext.tabs.onUpdated.removeListener(listener);
					resolve();
					return true;
				}
			} catch (_) {
				ext.tabs.onUpdated.removeListener(listener);
				resolve();
				return true;
			}
			return false;
		};
		const listener = (id) => {
			if (id === tabId) check();
		};
		ext.tabs.onUpdated.addListener(listener);
		check();
		setTimeout(() => {
			ext.tabs.onUpdated.removeListener(listener);
			resolve();
		}, 30000);
	});
}

// ---------------------------------------------------------------- archive tab

async function openArchive() {
	const existing = await ext.tabs.query({ url: ARCHIVE_URL });
	if (existing.length) {
		await ext.tabs.update(existing[0].id, { active: true });
		await ext.windows.update(existing[0].windowId, { focused: true });
		return existing[0];
	}
	return ext.tabs.create({ url: ARCHIVE_URL, active: true });
}

ext.runtime.onInstalled.addListener(({ reason }) => {
	if (reason === 'install') openArchive();
});
