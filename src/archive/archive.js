/**
 * Archive page controller.
 *
 * This page owns the storage backend and therefore owns all disk I/O and all
 * media fetching. The content script only supplies normalized records.
 */

import { ext } from '../lib/ext.js';
import * as fs from '../lib/fs.js';
import {
	loadState,
	saveState,
	scanDisk,
	heldButUnseen,
	listingComplete,
	looksTruncated,
	markGone,
	noteAbsentSongLink,
	songlessPhotoPosts,
	trailingUnseen,
	upsertItem,
	missingParts,
	recordLikeOrder,
	settledStreak,
	CAUGHT_UP_RUN,
	STATUS,
} from '../lib/state.js';
import { DownloadQueue } from '../lib/downloader.js';
import { renderLibrary, refreshPresence, wireLibrary } from './viewer.js';
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
	/** The same ids in the order they arrived, which is like order, newest first. */
	likeSeq: [],
	/** This run reads the list to the end rather than stopping once caught up. */
	full: false,
	/** Consecutive items an earlier run had already settled — see state.js. */
	settled: 0,
	/** The song pass, which runs instead of a sync rather than alongside one. */
	songs: { running: false, stop: false, uniqueId: '' },
};

// ---------------------------------------------------------------- background

let port = null;
let msgId = 0;
const waiting = new Map();

/**
 * The connection to the background, opened on demand rather than held from page
 * load.
 *
 * Chromium stops the service worker once it has been idle for half a minute,
 * and that disconnects this port. A page left open while you do something else
 * therefore has a dead one by the time you come back to it — and posting to a
 * dead port throws, which used to take the whole click down with it: no
 * request, no reply, not even the timeout, because the throw happened before
 * the timer was set. The sync button went grey and nothing else ever happened.
 *
 * Reconnecting is also what wakes the worker back up, so there is nothing else
 * to do about it.
 */
function channel() {
	if (port) return port;
	port = ext.runtime.connect({ name: 'archive' });
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
	port.onDisconnect.addListener(() => {
		port = null;
		// A new port can't answer a request made on the old one. Failing them now
		// beats leaving each to time out a minute later.
		for (const [id, resolve] of waiting) {
			waiting.delete(id);
			resolve({ ok: false, error: 'the extension worker restarted mid-request' });
		}
		// A sync in progress is fed through this port — it is how the collector's
		// items reach the folder. Waiting for the next request to reopen it would
		// silently drop everything harvested in between.
		if (app.syncing) channel();
	});
	return port;
}

function ask(cmd, extra = {}) {
	const id = ++msgId;
	return new Promise((resolve) => {
		waiting.set(id, resolve);

		// The envelope goes last so nothing in `extra` can take its place. A
		// request that carried the post under `id` overwrote its own request id
		// with it; the worker answered at once, its reply named the post instead
		// of the request, nothing here was waiting under that key, and the ask
		// hung until the idle worker was stopped half a minute later — reported,
		// truthfully but uselessly, as a worker restart.
		const message = { ...extra, id, cmd };
		let err = post(message);
		// One retry on a fresh port: the disconnect may not have been delivered
		// yet, in which case the port looks alive right up until it is posted to.
		if (err) {
			port = null;
			err = post(message);
		}
		if (err) {
			waiting.delete(id);
			resolve({ ok: false, error: `could not reach the extension worker (${err})` });
			return;
		}

		setTimeout(() => {
			if (waiting.has(id)) {
				waiting.delete(id);
				resolve({ ok: false, error: 'timed out' });
			}
		}, 60000);
	});
}

/** Returns why it couldn't be sent, or null if it went. */
function post(message) {
	try {
		channel().postMessage(message);
		return null;
	} catch (e) {
		return String((e && e.message) || e);
	}
}

// Opened at load all the same, and not only when something is asked: this is
// also how the background knows there is an archive page for a generated
// viewer.html to reach. After an idle shutdown that registration is gone until
// the next request reopens it, which is what the error the viewer shows says.
channel();

// ---------------------------------------------------------------- logging

function log(msg, cls = '') {
	const el = $('log');
	el.classList.remove('hidden');
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

/**
 * The panel is on screen before there is anything to put in it, so it has a
 * state for that: dimmed, with every control that assumes `app.state` disabled.
 * The scan that produces one is thousands of directory entries and takes
 * seconds on a large folder — long enough that hiding the panel until it lands
 * left the page looking empty and broken.
 */
function setBusy(busy) {
	$('syncBody').classList.toggle('busy', busy);
	$('rescan').disabled = busy;
	$('writeViewer').disabled = busy;
	if (busy) {
		$('startSync').disabled = true;
		$('syncMode').disabled = true;
		$('fetchSongs').disabled = true;
	} else {
		// Rescanning mid-sync comes back through here. A run in progress has its own
		// claim on these buttons, so hand them back to it rather than enabling them.
		setSyncButtons(app.syncing || app.songs.running);
	}
}

/**
 * The progress notice over the dimmed panel. `null` takes it away — which is
 * separate from `setBusy` on purpose: a scan that failed leaves the controls
 * disabled, because there is still no state behind them, but must not leave a
 * bar sweeping away at a folder nobody is reading any more.
 */
function showScanning(msg) {
	$('loading').classList.toggle('hidden', msg === null);
	if (msg !== null) $('loadingMsg').textContent = msg;
}

/** What the scan says about itself while it runs. */
function scanningMsg(files) {
	return files
		? `Reading your archive folder — ${files.toLocaleString()} files so far…`
		: 'Reading your archive folder…';
}

async function afterFolderReady() {
	$('folderName').textContent = fs.rootName();
	$('grantFolder').classList.add('hidden');
	$('noFolder').classList.add('hidden');
	$('pickFolder').textContent = 'Change folder…';

	$('syncBody').classList.remove('hidden');
	setBusy(true);
	// Named, because it is now a step of its own with the folder scan behind it,
	// and on a large archive it is a second of its own too.
	showScanning('Reading archive.json…');

	log('Reading archive.json…');
	let counts;

	try {
		// archive.json first, and strictly before the scan rather than alongside it.
		//
		// The two look independent — the directory listing decides what still needs
		// downloading, archive.json carries the metadata the Library is drawn from —
		// and running them together to pay for the slower rather than the sum is the
		// obvious thing. It doesn't work: File System Access requests are served in
		// order, so opening one file behind an enumeration of several thousand
		// directory entries means the metadata arrives *after* the scan however
		// early it was asked for, and the grid stays empty for the whole of it.
		//
		// One file read is a fraction of that enumeration, so paying for it up front
		// costs a moment and puts the Library on screen before the slow part starts.
		app.state = await loadState();
		renderLibrary(app.state);

		log('Scanning folder…');
		showScanning(scanningMsg(0));
		counts = await scanDisk({
			onProgress: (files) => showScanning(scanningMsg(files)),
			onBatch: refreshPresence,
		});
	} catch (err) {
		// Left busy either way. Half the panel assumes app.state exists, and the
		// other half assumes the listing is complete — syncing without one would
		// re-download the entire folder. The log sits outside it, so this is still
		// readable.
		showScanning(null);
		log(`Could not read the folder: ${err.message || err}`, 'err');
		return;
	}

	showScanning(null);
	setBusy(false);

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
	log(summarise('Found', counts), 'ok');
	renderLibrary(app.state);
}

/**
 * The one line that spells out the relationship the cards can only imply: how
 * many likes, and how many files those likes came to.
 */
function summarise(verb, counts) {
	const posts = counts.videos + counts.photoSets;
	return (
		`${verb} ${posts.toLocaleString()} liked posts on disk — ` +
		`${counts.videos.toLocaleString()} videos, ` +
		`${counts.photoSets.toLocaleString()} photo posts made of ${counts.images.toLocaleString()} images` +
		`${counts.songs ? `, ${counts.songs.toLocaleString()} songs` : ''}.`
	);
}

/**
 * Posts, then the files they are made of.
 *
 * A liked post is one video file *or* one photo post's worth of images, so a
 * count of files is thousands higher than a count of likes on a real archive.
 * Both are worth showing; which is which has to be unmistakable.
 *
 * Counted off the directory listing rather than off each item's status, for the
 * reason state.js keeps the listing as the source of truth: a status can drift
 * when files are moved or deleted from outside, a file either exists or it
 * doesn't. `unavailable` is the exception — nothing on disk can say why a post
 * is missing, only the record can.
 */
function renderStats(counts) {
	const items = Object.values(app.state?.items || {});
	const unavailable = items.filter(
		(i) => i.status === STATUS.gone || i.status === STATUS.unavailable
	).length;

	$('statPosts').textContent = (counts.videos + counts.photoSets).toLocaleString();
	$('statVideos').textContent = counts.videos.toLocaleString();
	$('statImages').textContent = counts.images.toLocaleString();
	$('statUnavailable').textContent = unavailable.toLocaleString();
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
	if (!app.state) {
		log('Pick a folder first.', 'err');
		return;
	}
	// Same seconds-long scan as at load, and without this the button just sits
	// there looking like the click missed.
	setBusy(true);
	showScanning(scanningMsg(0));
	log('Rescanning folder…');
	try {
		// Not renderLibrary: nothing about the *items* has changed — they come from
		// archive.json, which this doesn't touch — so rebuilding the grid would only
		// throw away the scroll position and every Load more the reader had pressed.
		// What the scan changes is which tiles have files behind them, and that
		// lands through onBatch as it goes.
		const counts = await scanDisk({
			onProgress: (files) => showScanning(scanningMsg(files)),
			onBatch: refreshPresence,
		});
		renderStats(counts);
		log(summarise('Rescanned —', counts));
	} catch (err) {
		log(`Could not read the folder: ${err.message || err}`, 'err');
	} finally {
		showScanning(null);
		setBusy(false);
	}
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
		beginSync();
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

		// Before the merge below, which overwrites the status this reads.
		if (!app.full) app.settled = settledStreak(app.state, payload.items || [], app.settled);

		const toDownload = [];
		for (const rec of payload.items || []) {
			upsertItem(app.state, rec);
			// Arrival order is like order. The collector never sends an id twice in
			// a run, but a duplicate here would corrupt the sequence, so check.
			if (!app.seenIds.has(rec.id)) app.likeSeq.push(rec.id);
			app.seenIds.add(rec.id);
			// Here rather than in the queue: a photo post whose pictures are on disk
			// and whose payload carries no link to its song is missing nothing the
			// queue can fetch, so it never reaches the downloader to be written off.
			if (noteAbsentSongLink(app.state, rec)) app.noLink++;
			if (missingParts(rec).length) {
				toDownload.push(rec);
				app.newItems++;
			}
		}
		if (toDownload.length) app.queue.addMany(toDownload);
		saveState(app.state);
		updateCounters();

		// Only against a list we have read to the end at least once. Until then
		// there is no "already synced up to" — an archive converted by
		// tools/script.py, or one whose first run stopped somewhere in the middle,
		// can have a settled item anywhere in the list.
		if (!app.full && app.state.fullSyncAt && app.settled >= CAUGHT_UP_RUN) {
			log(
				`${app.settled} likes in a row were already archived — that's the end of the new ones, ` +
					'so the rest of the list is left alone. Use Full sync to read all of it.',
				'ok'
			);
			if (app.tabId) ask('stop-harvest', { tabId: app.tabId });
			finishSync('caught-up');
		}
	}
}

function setSyncButtons(running) {
	$('startSync').disabled = running;
	$('syncMode').disabled = running;
	$('fetchSongs').disabled = running;
	$('stopSync').disabled = !running;
	if (running) closeSyncMenu();
}

/**
 * The download queue both kinds of run share.
 *
 * `onHalt` is the only thing that differs between them, and only in what it has
 * to wind up: a sync is a harvest plus a queue, the song pass is a loop of its
 * own. Everything above it — the throttle both halves of a run keep each other
 * informed of, the grid catching up as files land — is the same work either way.
 */
function makeQueue({ onHalt } = {}) {
	return new DownloadQueue({
		concurrency: Math.max(1, Math.min(8, Number($('concurrency').value) || 4)),
		state: app.state,
		onProgress: () => {
			updateCounters();
			// An item that has just been written is in `disk` already — the downloader
			// adds to it as it writes — and the grid is the only thing that hasn't
			// heard. Same catching-up a scan's batches get, once per finished item, so
			// a tile lights up as its files land rather than at the end of the run.
			refreshPresence();
		},
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
			// Clears the parked items so the caller's `idle()` can resolve — a paused
			// queue never drains. Nothing is lost: none of them were marked, so the
			// next run finds them missing on disk and queues them again.
			app.queue.stop();
			onHalt?.(reason);
		},
	});
}

async function startSync({ full = false } = {}) {
	if (!app.state) {
		log('Pick a folder first.', 'err');
		return;
	}
	const uniqueId = $('username').value.trim().replace(/^@/, '');
	if (!uniqueId) {
		log('Enter your TikTok username first.', 'err');
		return;
	}

	app.syncing = true;
	app.seen = 0;
	app.newItems = 0;
	app.seenIds = new Set();
	app.likeSeq = [];
	app.full = full || !app.state.fullSyncAt;
	app.settled = 0;
	app.noLink = 0;

	if (full) {
		log('Full sync: reading the list to the end, retrying anything that failed before.');
	} else if (!app.state.fullSyncAt) {
		// Nothing on record says where the list ends, so this run has to find out.
		// Every later one can stop as soon as it recognises what it is reading.
		log('No complete sync on record yet — reading the whole list this once.');
	} else {
		log('Reading the newest likes, and stopping where the archive already catches up.');
	}

	// favorite/item_list doesn't report a total, so the bar is seeded from
	// whatever we last knew and corrected if a total ever does arrive.
	app.expectedTotal = Object.keys(app.state.items).length || 0;
	setSyncButtons(true);

	app.queue = makeQueue({ onHalt: () => finishSync('error') });

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

/** How the log describes a run that has just ended. */
const ENDED = {
	complete: 'reached the end of the list',
	'caught-up': 'caught up with the archive',
	stopped: 'stopped',
	error: 'error',
};

async function finishSync(reason) {
	if (!app.syncing) return;
	app.syncing = false;
	$('stopSync').disabled = true;

	if (app.queue) {
		log(`Harvest ${ENDED[reason] || reason}. Finishing ${app.queue.pending} queued downloads…`);
		await app.queue.idle();
		if (app.queue.failed.length) {
			log(
				`${app.queue.failed.length} item(s) failed — usually expired media URLs. Sync again to retry them; ` +
					'ones further down the list than this run went need a Full sync.',
				'err'
			);
		}
	}

	// Not an error and not a failure of the item: the pictures are archived and
	// only the song is absent. Reported because it is otherwise invisible — the
	// Library can only show a post with no player, which reads like a download
	// that hasn't run rather than a track TikTok will not part with.
	//
	// Outside the `app.queue` block above because only one of the two halves comes
	// from the queue; the other is counted off the harvested records.
	const refused = app.queue ? app.queue.noAudio.length : 0;
	if (refused || app.noLink) {
		const parts = [];
		if (app.noLink) parts.push(`${app.noLink} that TikTok named a song for but sent no link to`);
		if (refused) parts.push(`${refused} whose track was refused when asked for`);
		log(
			`${refused + app.noLink} photo post(s) kept their pictures but not their song: ${parts.join(', ')}. ` +
				'archive.json records which, and why, under "noAudio".'
		);
	}

	const counts = await scanDisk();

	// Only a run that reached the end of the list can distinguish "TikTok didn't
	// return it" from "we stopped scrolling early".
	if (reason === 'complete' && app.seenIds.size) {
		// Said on every complete run, not just a suspicious one. How deep the list
		// went is the one number that makes a truncation visible at all, and on an
		// archive carried over from another tool the second figure is the size of
		// the part your syncs can no longer reach — otherwise invisible, because
		// every one of those posts is sitting in the folder looking archived.
		const held = heldButUnseen(app.state, app.seenIds);
		const before = app.state.listLength;
		log(
			`Read ${app.seenIds.size.toLocaleString()} likes` +
				(before ? ` (the last complete run read ${before.toLocaleString()})` : '') +
				'.' +
				(held
					? ` ${held.toLocaleString()} post(s) this archive holds the media for were not in the list — ` +
						'unliked since, or no longer served.'
					: '')
		);
		if (looksTruncated(app.state, app.seenIds)) {
			// TikTok ended the list above where this archive has already been: the
			// deepest likes on record went missing together, in a block, which is
			// what being cut off looks like and not what unliking looks like. So
			// nothing here may act as though it were the end — no item is written
			// off as gone, and `fullSyncAt` is left where it was rather than being
			// stamped on a run that did not earn it.
			log(
				`The list ended ${trailingUnseen(app.state, app.seenIds).toLocaleString()} likes above the deepest ` +
					'this archive has reached before, all in one block. That is a truncated list, not the end of one.',
				'err'
			);
			log(
				'Nothing has been marked gone. Everything already downloaded is untouched — it only means the ' +
					'oldest part of your likes was not served this time. Try Full sync again later.'
			);
		} else {
			// The same thing makes it a baseline for the next run: from here on, a
			// stretch of already-settled items means the rest of the list has been
			// read before, so there is no need to read it again. The count comes with
			// it, so the next run has something to be measured against.
			app.state.fullSyncAt = Date.now();
			app.state.listLength = app.seenIds.size;
			const gone = markGone(app.state, app.seenIds);
			if (gone) {
				log(
					`${gone} previously-known item(s) are no longer in your likes — deleted, privated or unliked. Kept in archive.json.`
				);
			}
		}
	}

	// Unlike `gone`, this is worth doing after a run that stopped early: what it
	// did see is still the newest slice of the list, in order, and merging a
	// prefix leaves the rest of the order alone.
	if (app.likeSeq.length) {
		const known = recordLikeOrder(app.state, app.likeSeq);
		log(`Like order recorded for ${known.toLocaleString()} item(s).`);
	}

	renderStats(counts);
	// The bar is a fraction of the whole list, and an incremental run never
	// approaches that. Ending where it meant to is still finished.
	if (reason === 'complete' || reason === 'caught-up') $('bar').style.width = '100%';
	await saveState(app.state, { immediate: true });
	renderLibrary(app.state);
	log('Done. archive.json written.', 'ok');
	await writeViewerFile();
	setSyncButtons(false);
}

/**
 * Nothing awaits a sync — it is started by a click and reports itself through
 * the log. So a throw on the way in has nowhere to surface, and the page just
 * sits there with the button greyed out looking like it is working. Anything
 * that gets this far is a bug, but it is going to say so on screen.
 */
function beginSync(opts = {}) {
	startSync(opts).catch((err) => {
		log(`Sync could not start: ${(err && err.message) || err}`, 'err');
		finishSync('error');
	});
}

// ------------------------------------------------------------- song pass
//
// A photo post's song is the one part of the archive a sync can fail to fetch
// without failing anything: the pictures are the post, they are on disk, and the
// item is `saved`. `isSettled` excludes the song deliberately, so an incremental
// run steps over such a post forever, and a full sync only reaches it if TikTok
// serves the list that far — which is exactly what did not happen here. A run
// that came back short of the end left the deepest likes holding pictures
// collected before songs were fetched at all, and nothing since could get back
// to them.
//
// So this pass does not use the list. It opens each post's own page in the sync
// tab and reads the record TikTok rendered it from, which carries the
// `music.playUrl` the list payload either never had or never sent. That also
// answers the other half — the posts written off with "TikTok named the track
// but sent no link to it" — because the link missing from `item_list` is
// routinely present on the post itself.

/** Between posts. A page load each, so nothing here needs to be quick. */
const SONG_PAUSE_MS = 1500;

const pause = (ms) => new Promise((r) => setTimeout(r, Math.round(ms * (1 + Math.random() * 0.6))));

/** Where a post lives, so the tab can be pointed at it. */
function postUrl(item) {
	const uniqueId = item.author?.uniqueId || app.state.authors?.[item.author?.id]?.uniqueId;
	if (!uniqueId) return null;
	return `https://www.tiktok.com/@${uniqueId}/${item.type === 'photo' ? 'photo' : 'video'}/${item.id}`;
}

/** How long a navigated tab is given to arrive at the post. */
const POST_ARRIVE_MS = 30000;
/** And, once there, how long the record is given to turn up on it. */
const POST_RECORD_MS = 15000;
/** Posts whose step timings are logged, so a slow pass says where the time goes. */
const POST_TIMINGS_LOGGED = 3;

/**
 * Open one post in the sync tab and hand back the record it was rendered from.
 *
 * Driven from here in short steps rather than handed to the worker as one
 * request. Chromium stops the extension worker on its own schedule, and a
 * request still in flight when it does is lost: the port drops, and everything
 * waiting on it fails as "restarted mid-request". So every ask here is one the
 * worker answers at once — point the tab somewhere, ping it, read what the page
 * holds right now — and the waiting between asks happens on this page, whose
 * timers are its own. A worker restart between steps costs nothing; the next
 * ask reconnects.
 *
 * (The first version was one request to the worker, and every post in a pass
 * failed as a worker restart. So did this one, until the cause turned out to
 * be in `ask` — see the note on the envelope there — rather than anything the
 * worker was made to wait for. The shape stayed because it is the right one.)
 *
 * "Arrived at the post" is judged by the href the content script reports, not
 * by the tab reporting `complete`: the script runs at document_start and
 * answers as soon as the navigation has committed, while a post page holds its
 * load event back for a long while prefetching the posts it recommends. The old
 * page's script answers pings too, right up until it is torn down, which is why
 * the href is checked at all. A deleted post redirects, and is reported with
 * where the tab ended up.
 */
async function readPostPage(url, id) {
	const failed = (what, res) => ({ ok: false, error: `${what}: ${res.error || 'no answer'}` });
	const t0 = Date.now();
	const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
	const timings = [];

	const went = await ask('navigate-tab', { tabId: app.tabId, url });
	if (!went.ok) return failed('opening the page', went);
	timings.push(`navigated at ${since()}`);

	const onPost = (href) => (href || '').split(/[?#]/)[0].endsWith(`/${id}`);
	let lastHref = null;
	let arrived = false;
	const deadline = Date.now() + POST_ARRIVE_MS;
	while (Date.now() < deadline && !app.songs.stop) {
		await pause(500);
		const ping = await ask('ping-tab', { tabId: app.tabId });
		if (!ping.ok) continue;
		if (onPost(ping.href)) {
			arrived = true;
			break;
		}
		lastHref = ping.href;
	}
	if (!arrived) {
		return {
			ok: false,
			error: lastHref
				? `the tab never arrived at the post (it is on ${lastHref})`
				: 'the content script never came back after the navigation',
		};
	}
	timings.push(`arrived at ${since()}`);

	// The record follows the page by a beat — a photo page has to fetch it — so
	// the page is asked again every half second until it has it.
	let last = { ok: false, error: 'not asked' };
	const recordBy = Date.now() + POST_RECORD_MS;
	while (!app.songs.stop) {
		last = await ask('detail-tab', { tabId: app.tabId, postId: id });
		if (last.ok) break;
		if (Date.now() >= recordBy) break;
		await pause(500);
	}
	timings.push(`${last.ok ? 'record' : 'gave up'} at ${since()}`);
	if (app.seen <= POST_TIMINGS_LOGGED) log(`· ${id}: ${timings.join(', ')}`);
	return last.ok ? last : failed('reading the record', last);
}

async function fetchMissingSongs() {
	if (!app.state) {
		log('Pick a folder first.', 'err');
		return;
	}
	// `disk.audio` not holding an id means "not on disk" only once the listing is
	// complete. Run this against a half-read folder and every photo post in the
	// archive looks songless.
	if (!listingComplete()) {
		log('The folder is still being read — try again once the scan has finished.', 'err');
		return;
	}
	const uniqueId = $('username').value.trim().replace(/^@/, '');
	if (!uniqueId) {
		log('Enter your TikTok username first.', 'err');
		return;
	}

	const todo = songlessPhotoPosts(app.state);
	if (!todo.length) {
		log('Every photo post in the archive already has its song.', 'ok');
		return;
	}

	app.songs = { running: true, stop: false, uniqueId };
	// The counters are the sync's, and they read the same way here: one post
	// opened is one item seen, and the bar is the worklist rather than the list.
	app.seen = 0;
	app.newItems = 0;
	app.expectedTotal = todo.length;
	setSyncButtons(true);
	log(
		`${todo.length.toLocaleString()} photo post(s) have their pictures but no song. Opening each one ` +
			'to read the track off its own page — this takes a page load apiece, so it is slow. ' +
			`(extension ${ext.runtime.getManifest().version})`
	);

	app.queue = makeQueue({ onHalt: () => (app.songs.stop = true) });

	const res = await ask('ensure-profile', { uniqueId, background: true });
	if (!res.ok) {
		log(`Could not prepare the TikTok tab: ${res.error || 'unknown error'}`, 'err');
		await finishSongs({ found: 0, noLink: 0 });
		return;
	}
	app.tabId = res.tabId;

	let found = 0;
	let noLink = 0;
	for (const item of todo) {
		if (app.songs.stop) break;

		const url = postUrl(item);
		if (!url) {
			log(`· ${item.id}: no author on record, so there is no page to open.`);
			continue;
		}

		app.seen++;
		const got = await readPostPage(url, item.id);
		if (!got.ok) {
			// Never `unavailable`: the pictures are archived and this is one optional
			// extra. A post that has been deleted since simply has no page to read.
			log(`✗ ${item.id}: ${got.error || 'no record on the page'}`, 'err');
			updateCounters();
			await pause(SONG_PAUSE_MS);
			continue;
		}

		const rec = got.item;
		// Not `recordLikeOrder`'s business, and deliberately kept out of `likeSeq`:
		// this pass reads posts in archive order, not in like order, and feeding that
		// sequence in would rewrite the record of when things were liked.
		upsertItem(app.state, rec);
		if (missingParts(rec).length) {
			found++;
			app.newItems++;
			app.queue.add(rec);
		} else {
			// The page agrees with the list — TikTok names the track and links
			// nothing. Counted rather than logged one by one: on this archive it is
			// the answer for dozens of posts, and forty identical lines is not a log.
			noLink++;
			noteAbsentSongLink(app.state, rec);
		}

		if (app.seen % 10 === 0) log(`Opened ${app.seen} of ${todo.length}; ${found} song(s) queued.`);
		saveState(app.state);
		updateCounters();
		await pause(SONG_PAUSE_MS);
	}

	await finishSongs({ found, noLink });
}

async function finishSongs({ found, noLink }) {
	app.songs.running = false;
	$('stopSync').disabled = true;

	if (app.queue) {
		log(`Opened ${app.seen} post(s), ${found} with a track to fetch. Finishing ${app.queue.pending} download(s)…`);
		await app.queue.idle();
	}
	const refused = app.queue ? app.queue.noAudio.length : 0;
	if (noLink || refused) {
		const parts = [];
		if (noLink) parts.push(`${noLink} that TikTok's own page names a song for but links no audio to`);
		if (refused) parts.push(`${refused} whose track was linked but refused when asked for`);
		log(`${noLink + refused} post(s) still have no song: ${parts.join(', ')}. Recorded under "noAudio".`);
	}

	// Back to the profile, so the tab this pass has been driving is one the next
	// sync can reuse. A tab left on a post page is not a list, and a sync that
	// adopted it would sit there waiting for a request it never makes.
	if (app.tabId && app.songs.uniqueId) {
		await ask('navigate-tab', { tabId: app.tabId, url: `https://www.tiktok.com/@${app.songs.uniqueId}` });
	}

	const counts = await scanDisk();
	renderStats(counts);
	await saveState(app.state, { immediate: true });
	renderLibrary(app.state);
	log(
		`Song pass done — the archive now holds ${counts.songs.toLocaleString()} song(s). archive.json written.`,
		'ok'
	);
	await writeViewerFile();
	setSyncButtons(false);
}

$('fetchSongs').addEventListener('click', () => {
	fetchMissingSongs().catch((err) => {
		log(`The song pass could not run: ${(err && err.message) || err}`, 'err');
		app.songs.running = false;
		setSyncButtons(false);
	});
});

// ---------------------------------------------------------------- sync mode
//
// One button with a dropdown rather than two: which sync you want is a choice
// between two of the same thing, and the label then says which one the click
// is about to run.

/** What the next click on the sync button will do. */
let syncFull = false;

function closeSyncMenu() {
	$('syncMenu').classList.add('hidden');
	$('syncMode').setAttribute('aria-expanded', 'false');
}

function setSyncMode(full) {
	syncFull = full;
	$('startSync').textContent = full ? 'Full sync' : 'Sync likes';
	for (const item of $('syncMenu').querySelectorAll('.item')) {
		item.setAttribute('aria-checked', String(!!item.dataset.full === full));
	}
}

$('syncMode').addEventListener('click', (ev) => {
	ev.stopPropagation();
	const open = $('syncMenu').classList.toggle('hidden');
	$('syncMode').setAttribute('aria-expanded', String(!open));
});

$('syncMenu').addEventListener('click', (ev) => {
	const item = ev.target.closest('.item');
	if (!item) return;
	setSyncMode(!!item.dataset.full);
	closeSyncMenu();
	$('startSync').focus();
});

// A menu that only closes by choosing from it is a trap on a page with this
// much else on it.
document.addEventListener('click', (ev) => {
	if (!ev.target.closest('.split')) closeSyncMenu();
});
document.addEventListener('keydown', (ev) => {
	if (ev.key === 'Escape') closeSyncMenu();
});

$('startSync').addEventListener('click', () => beginSync({ full: syncFull }));

$('stopSync').addEventListener('click', async () => {
	// The song pass owns the button when it is the thing running. It stops between
	// posts rather than mid-page, so this only sets the flag its loop reads and
	// lets that loop wind itself up.
	if (app.songs.running) {
		app.songs.stop = true;
		app.queue?.stop();
		log('Stopping after this post.');
		return;
	}
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
	// The song pass spends most of its time between downloads, waiting on a page
	// load, so an idle queue says nothing about whether it is still running.
	if (app.syncing || app.songs.running || (app.queue && app.queue.pending > 0)) {
		e.preventDefault();
		e.returnValue = '';
	}
});
