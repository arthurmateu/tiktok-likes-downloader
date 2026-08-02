/**
 * Archive page controller.
 *
 * This page owns the storage backend and therefore owns all disk I/O and all
 * media fetching. The content script only supplies normalized records.
 */

import { ext } from '../lib/ext.js';
import * as fs from '../lib/fs.js';
import { loadState, saveState, scanDisk, markGone, upsertItem, missingParts } from '../lib/state.js';
import { DownloadQueue } from '../lib/downloader.js';
import { renderLibrary, wireLibrary } from './viewer.js';
import { writeViewer, slimItems, VIEWER_FILE } from './standalone.js';

const $ = (id) => document.getElementById(id);

const app = {
	state: null,
	queue: null,
	tabId: null,
	syncing: false,
	seen: 0,
	newItems: 0,
	expectedTotal: 0,
	/** Ids TikTok returned during this run. Only meaningful if it completes. */
	seenIds: new Set(),
};

// ---------------------------------------------------------------- background

const port = ext.runtime.connect({ name: 'archive' });
let msgId = 0;
const waiting = new Map();

port.onMessage.addListener((msg) => {
	if (msg.type === 'reply') {
		const r = waiting.get(msg.id);
		if (r) {
			waiting.delete(msg.id);
			r(msg.payload);
		}
		return;
	}
	onContentMessage(msg.type, msg.payload || {});
});

function ask(cmd, extra = {}) {
	const id = ++msgId;
	return new Promise((resolve) => {
		waiting.set(id, resolve);
		port.postMessage({ id, cmd, ...extra });
		setTimeout(() => {
			if (waiting.has(id)) {
				waiting.delete(id);
				resolve({ ok: false, error: 'timed out' });
			}
		}, 60000);
	});
}

// ---------------------------------------------------------------- logging

function log(msg, cls = '') {
	const el = $('log');
	const line = document.createElement('span');
	line.className = cls;
	const t = new Date().toLocaleTimeString();
	line.textContent = `[${t}] ${msg}\n`;
	el.appendChild(line);
	el.scrollTop = el.scrollHeight;
}

function fmtBytes(n) {
	if (!n) return '0 B';
	const u = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
	return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

// ---------------------------------------------------------------- folder

async function afterFolderReady() {
	$('folderName').textContent = fs.rootName();
	$('grantFolder').classList.add('hidden');
	$('noFolder').classList.add('hidden');
	$('syncBody').classList.remove('hidden');
	$('pickFolder').textContent = 'Change folder…';

	log('Scanning folder…');
	const counts = await scanDisk();
	app.state = await loadState();

	// A folder still in the old data/Likes shape has media the flat layout can't
	// see. Saying so beats silently offering to re-download all of it.
	if (!counts.videos && !counts.photoSets && (await fs.listDirs([])).has('data')) {
		$('legacyNote').classList.remove('hidden');
		$('legacyNote').textContent =
			'This folder has a data/ directory but no videos/ — it looks like a myfaveTT ' +
			'archive, or an older version of this one. Run tools/script.py inside it to ' +
			'convert it in place, then rescan. Syncing now would re-download everything.';
	}

	const uid = app.state.user?.uniqueId || '';
	if (uid && !$('username').value) $('username').value = uid;

	renderStats(counts);
	log(`Found ${counts.videos} videos, ${counts.photoSets} photo posts.`, 'ok');
	renderLibrary(app.state);
}

function renderStats(counts) {
	const items = Object.values(app.state.items);
	$('statVideos').textContent = counts.videos.toLocaleString();
	$('statPhotos').textContent = counts.photoSets.toLocaleString();
	$('statGone').textContent = items.filter((i) => i.status === 'gone').length.toLocaleString();
	$('statKnown').textContent = items.length.toLocaleString();
}

$('pickFolder').addEventListener('click', async () => {
	if (!fs.supported()) {
		alert('This browser can neither pick a folder nor write through the downloads API.');
		return;
	}
	// The downloads backend has no picker to open — it takes a folder name.
	if (fs.capabilities.pick === 'name') {
		$('dlSetup').classList.remove('hidden');
		$('dlFolderName').focus();
		$('dlFolderName').select();
		return;
	}
	try {
		await fs.pickFolder();
		await afterFolderReady();
	} catch (err) {
		if (err && err.name !== 'AbortError') log(`Folder selection failed: ${err.message}`, 'err');
	}
});

$('dlFolderSave').addEventListener('click', async () => {
	try {
		await fs.pickFolder({ name: $('dlFolderName').value });
		$('dlSetup').classList.add('hidden');
		log(`Writing into “${fs.rootName()}” under your browser's download folder.`);
		await afterFolderReady();
	} catch (err) {
		log(`Could not set the folder: ${err.message || err}`, 'err');
	}
});

$('grantFolder').addEventListener('click', async () => {
	const state = await fs.requestAccess();
	if (state === 'granted') await afterFolderReady();
	else log('Access was not granted.', 'err');
});

// A directory handed over here is read-only; it's the only way a browser
// without File System Access can see an existing archive at all.
$('scanFolder').addEventListener('click', () => $('scanInput').click());

$('scanInput').addEventListener('change', async (ev) => {
	const files = ev.target.files;
	ev.target.value = '';
	if (!files || !files.length) return;

	const info = fs.scanFolder(files);
	log(`Read ${info.files.toLocaleString()} files from “${info.name}”.`, 'ok');
	if (fs.rootName()) await afterFolderReady();
	else log('Now set a folder name above so new downloads have somewhere to go.');
});

$('rescan').addEventListener('click', async () => {
	const counts = await scanDisk();
	renderStats(counts);
	renderLibrary(app.state);
	log(`Rescan: ${counts.videos} videos, ${counts.photoSets} photo posts.`);
});

// ---------------------------------------------------------------- viewer.html

/**
 * Write the folder's own browsing page. Called after every completed sync so it
 * is never staler than the archive itself, and available as a button for a
 * folder that hasn't been synced since this feature existed.
 */
async function writeViewerFile({ quiet = false } = {}) {
	if (!app.state) return;
	try {
		const { bytes } = await writeViewer(app.state);
		if (!quiet) log(`Wrote ${VIEWER_FILE} (${fmtBytes(bytes)}) — open it from the folder to browse offline.`, 'ok');
	} catch (err) {
		// Never fatal: the media and archive.json are already safe, and this file
		// is regenerable from them.
		log(`Could not write ${VIEWER_FILE}: ${err.message || err}`, 'err');
	}
}

$('writeViewer').addEventListener('click', async () => {
	if (!app.state) {
		log('Pick a folder first.', 'err');
		return;
	}
	$('writeViewer').disabled = true;
	await writeViewerFile();
	$('writeViewer').disabled = false;
});

/**
 * A request from a generated viewer.html, relayed by the background through the
 * content script that runs on it. Chromium only — see src/content/viewer-bridge.js.
 */
function onViewerRequest({ rid, cmd }) {
	const respond = (payload) => port.postMessage({ cmd: 'viewer-response', rid, payload });

	if (cmd === 'status') {
		respond({
			ok: true,
			ready: !!app.state,
			syncing: app.syncing,
			folder: fs.rootName(),
			seen: app.seen,
			stats: app.queue ? { ...app.queue.stats } : null,
		});
		return;
	}

	if (cmd === 'state') {
		if (!app.state) {
			respond({ ok: false, error: 'no folder open' });
			return;
		}
		respond({ ok: true, items: slimItems(app.state) });
		return;
	}

	if (cmd === 'sync') {
		if (app.syncing) {
			respond({ ok: true, already: true });
			return;
		}
		if (!app.state) {
			respond({ ok: false, error: 'no folder open — pick one on the archiver page' });
			return;
		}
		if (!$('username').value.trim()) {
			respond({ ok: false, error: 'no username known — set one on the archiver page once' });
			return;
		}
		// Answer before starting: startSync outlives this message by minutes.
		respond({ ok: true });
		startSync();
		return;
	}

	respond({ ok: false, error: `unknown command ${cmd}` });
}

// ---------------------------------------------------------------- sync

function updateCounters() {
	const s = app.queue?.stats || { done: 0, skipped: 0, failed: 0, bytes: 0 };
	$('cSeen').textContent = app.seen.toLocaleString();
	$('cNew').textContent = app.newItems.toLocaleString();
	$('cDone').textContent = s.done.toLocaleString();
	$('cSkip').textContent = s.skipped.toLocaleString();
	$('cFail').textContent = s.failed.toLocaleString();
	$('cBytes').textContent = fmtBytes(s.bytes);

	const total = app.expectedTotal || 0;
	$('bar').style.width = total ? `${Math.min(100, (app.seen / total) * 100).toFixed(1)}%` : '0%';
}

/** Tell the collector what the downloads have just run into. */
function shareThrottle() {
	if (!app.tabId || !app.queue) return;
	ask('throttle', { tabId: app.tabId, payload: app.queue.guard.snapshot() });
}

function onContentMessage(type, payload) {
	if (type === 'viewer-request') {
		onViewerRequest(payload || {});
		return;
	}

	// The other direction: the list run into a limit, so the downloads adopt it.
	// A halt reaches the queue on its next request, which parks it and fires
	// onHalt — no separate path needed here.
	if (type === 'throttle') {
		if (!app.queue) return;
		app.queue.guard.adopt(payload);
		if (!payload.halted && payload.until > Date.now()) {
			const secs = Math.round((payload.until - Date.now()) / 1000);
			log(`The list was refused (${payload.kind || 'throttled'}); downloads pause for ${secs}s too.`);
		}
		return;
	}

	if (type === 'status') {
		log(payload.msg, payload.fatal ? 'err' : '');
		if (payload.fatal || payload.done) finishSync(payload.fatal ? 'error' : 'complete');
		return;
	}

	if (type === 'pagestate' && payload.profileUser) {
		if (!app.state) return;
		app.state.user = { ...(app.state.user || {}), ...payload.profileUser };
		return;
	}

	if (type === 'items') {
		if (!app.syncing || !app.state) return;
		app.seen = Math.max(app.seen, payload.seenTotal || 0);
		if (payload.total) app.expectedTotal = payload.total;

		const toDownload = [];
		for (const rec of payload.items || []) {
			upsertItem(app.state, rec);
			app.seenIds.add(rec.id);
			if (missingParts(rec).length) {
				toDownload.push(rec);
				app.newItems++;
			}
		}
		if (toDownload.length) app.queue.addMany(toDownload);
		saveState(app.state);
		updateCounters();
	}
}

async function startSync() {
	const uniqueId = $('username').value.trim().replace(/^@/, '');
	if (!uniqueId) {
		log('Enter your TikTok username first.', 'err');
		return;
	}

	app.syncing = true;
	app.seen = 0;
	app.newItems = 0;
	app.seenIds = new Set();
	// favorite/item_list doesn't report a total, so the bar is seeded from
	// whatever we last knew and corrected if a total ever does arrive.
	app.expectedTotal = Object.keys(app.state.items).length || 0;
	$('startSync').disabled = true;
	$('stopSync').disabled = false;

	app.queue = new DownloadQueue({
		concurrency: Math.max(1, Math.min(8, Number($('concurrency').value) || 4)),
		state: app.state,
		onProgress: updateCounters,
		onError: (rec, err) => log(`✗ ${rec.id}: ${err.message || err}`, 'err'),
		onThrottle: (ev) => {
			if (!ev.halted) {
				log(
					`TikTok refused a download (${ev.kind}). Pausing ${Math.round(ev.waitMs / 1000)}s ` +
						`before trying again — the list stops too.`
				);
			}
			shareThrottle();
		},
		onHalt: (reason) => {
			log(`${reason}. Stopping the whole run rather than asking again.`, 'err');
			log('Open the TikTok tab, clear the check, then press Sync — nothing already saved is lost.');
			shareThrottle();
			if (app.tabId) ask('stop-harvest', { tabId: app.tabId });
			// Clears the parked items so finishSync's `idle()` can resolve — a paused
			// queue never drains. Nothing is lost: none of them were marked, so the
			// next sync finds them missing on disk and queues them again.
			app.queue.stop();
			finishSync('error');
		},
	});

	log(`Opening https://www.tiktok.com/@${uniqueId} in the background…`);
	const res = await ask('ensure-profile', { uniqueId, background: true });
	if (!res.ok) {
		log(`Could not prepare the TikTok tab: ${res.error || 'unknown error'}`, 'err');
		finishSync('error');
		return;
	}
	app.tabId = res.tabId;
	log('Tab ready. Leave it open — it does not need to be in front unless the log says so.');
	await ask('start-harvest', { tabId: app.tabId, opts: { which: 'likes', mode: 'auto' } });
}

async function finishSync(reason) {
	if (!app.syncing) return;
	app.syncing = false;
	$('stopSync').disabled = true;

	if (app.queue) {
		log(`Harvest ${reason}. Finishing ${app.queue.pending} queued downloads…`);
		await app.queue.idle();
		if (app.queue.failed.length) {
			log(
				`${app.queue.failed.length} item(s) failed — usually expired media URLs. Run Sync again to retry just those.`,
				'err'
			);
		}
	}

	const counts = await scanDisk();

	// Only a run that reached the end of the list can distinguish "TikTok didn't
	// return it" from "we stopped scrolling early".
	if (reason === 'complete' && app.seenIds.size) {
		const gone = markGone(app.state, app.seenIds);
		if (gone) {
			log(
				`${gone} previously-known item(s) are no longer in your likes — deleted, privated or unliked. Kept in archive.json.`
			);
		}
	}

	renderStats(counts);
	await saveState(app.state, { immediate: true });
	renderLibrary(app.state);
	log('Done. archive.json written.', 'ok');
	await writeViewerFile();
	$('startSync').disabled = false;
}

$('startSync').addEventListener('click', () => startSync());

$('stopSync').addEventListener('click', async () => {
	if (app.tabId) await ask('stop-harvest', { tabId: app.tabId });
	app.queue?.stop();
	finishSync('stopped');
});

// ---------------------------------------------------------------- tabs

for (const tab of document.querySelectorAll('.tab')) {
	tab.addEventListener('click', () => {
		for (const t of document.querySelectorAll('.tab')) t.classList.remove('active');
		for (const p of document.querySelectorAll('.panel')) p.classList.remove('active');
		tab.classList.add('active');
		$(`panel-${tab.dataset.panel}`).classList.add('active');
	});
}

// ---------------------------------------------------------------- boot

/**
 * Firefox's MV3 host permissions are optional by default: they sit in the
 * manifest ungranted until the user says yes, and every media fetch is a CORS
 * failure until they do. On Chromium `contains` is already true and this is a
 * no-op.
 */
async function checkHostAccess() {
	const origins = ext.runtime.getManifest().host_permissions || [];
	if (!origins.length || !ext.permissions) return;

	try {
		if (await ext.permissions.contains({ origins })) return;
	} catch (_) {
		return;
	}

	$('hostAccess').classList.remove('hidden');
	$('grantHost').addEventListener('click', async () => {
		const granted = await ext.permissions.request({ origins });
		if (granted) {
			$('hostAccess').classList.add('hidden');
			log('Access granted.', 'ok');
		} else {
			log('Access refused — every download will fail until it is granted.', 'err');
		}
	});
}

(async function boot() {
	wireLibrary(() => app.state);

	if (!fs.supported()) {
		$('noFolder').textContent =
			'This browser has neither the File System Access API nor a usable downloads API, so there is nowhere to write. Use Firefox 128+, Edge, or Chrome 111+.';
		return;
	}

	await checkHostAccess();

	const byName = fs.capabilities.pick === 'name';
	if (byName) $('pickFolder').textContent = 'Set folder…';
	if (fs.canScanFolder()) $('scanRow').classList.remove('hidden');

	const { state, label } = await fs.restoreFolder();
	if (state === 'granted') {
		await afterFolderReady();
	} else if (label) {
		$('folderName').textContent = `${label} (access needs re-granting)`;
		$('grantFolder').classList.remove('hidden');
	} else if (byName) {
		$('noFolder').classList.add('hidden');
		$('dlSetup').classList.remove('hidden');
	}
})();

window.addEventListener('beforeunload', (e) => {
	if (app.syncing || (app.queue && app.queue.pending > 0)) {
		e.preventDefault();
		e.returnValue = '';
	}
});
