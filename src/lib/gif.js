/**
 * Stickers as GIFs.
 *
 * A comment sticker comes off TikTok's CDN as WebP, animated more often than
 * not, and a GIF is what goes into a chat without a second thought — so that is
 * what the archive keeps. A sticker with a single frame is written as a PNG
 * instead, which keeps its colours and its edges.
 *
 * Nothing here talks to TikTok. The browser decodes the WebP (`ImageDecoder`,
 * which hands back every frame already composited), and the GIF is built here
 * from those frames. Where `ImageDecoder` doesn't exist, `stickerFile` answers
 * null and the caller keeps TikTok's own file, which the Library plays all the
 * same.
 *
 * The encoding follows the script this replaced, which made its GIFs with
 * ffmpeg's `palettegen=reserve_transparent=1:stats_mode=diff` and
 * `paletteuse=dither=bayer:bayer_scale=5:alpha_threshold=128`:
 *
 *   - one palette for the whole clip, 255 colours plus one slot for "nothing
 *     here", so a cut-out sticker stays cut out
 *   - the palette is chosen from what changes between frames, so a still
 *     background doesn't take the colours a moving subject needs
 *   - no dithering: `bayer_scale=5` moves a channel by at most one step, which
 *     is no pattern at all, and a plain nearest colour compresses better
 *   - alpha below 128 is transparent and anything above it opaque, since GIF
 *     has nothing in between
 */

/** The palette slot kept for transparency. */
const CLEAR = 255;
const ALPHA_CUTOFF = 128;
/** What a frame with no duration of its own is shown for, as the script did. */
const DEFAULT_FRAME_MS = 100;
/**
 * The shortest delay a browser honours. 0 and 1 hundredths are read as "the
 * file didn't say" and played at a tenth of a second, which would slow a fast
 * clip down rather than speed it up.
 */
const MIN_DELAY_CS = 2;

// ------------------------------------------------------------------ decoding

/** What a file is, from its first bytes. The CDN's Content-Type is not always one a decoder accepts. */
export function sniffImageType(head) {
	const at = (i, ...bytes) => bytes.every((b, n) => head[i + n] === b);
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
	if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
	if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
	if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
	if (at(4, 0x66, 0x74, 0x79, 0x70)) {
		const brand = String.fromCharCode(head[8], head[9], head[10], head[11]);
		if (brand === 'avif' || brand === 'avis') return 'image/avif';
		return 'image/heic';
	}
	return null;
}

/**
 * Every frame of an image, one at a time, as RGBA.
 *
 * Read on demand rather than all at once: a sticker cut from a video is 720×720
 * and can run to a hundred frames, which is two hundred megabytes held as
 * pixels. The encoder reads the clip twice instead — once to choose its colours
 * and once to write them — and keeps at most two frames in hand.
 *
 * Resolves to null where this browser can't decode the file.
 */
export async function openFrames(blob) {
	if (typeof ImageDecoder === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
	const data = new Uint8Array(await blob.arrayBuffer());
	const type = sniffImageType(data);
	if (!type) return null;
	try {
		if (!(await ImageDecoder.isTypeSupported(type))) return null;
	} catch (_) {
		return null;
	}

	const decoder = new ImageDecoder({ data, type });
	let count;
	try {
		await decoder.tracks.ready;
		await decoder.completed;
		count = decoder.tracks.selectedTrack?.frameCount || 0;
	} catch (_) {
		decoder.close();
		return null;
	}
	if (!count) {
		decoder.close();
		return null;
	}

	let canvas = null;
	let ctx = null;
	const source = {
		type,
		count,
		width: 0,
		height: 0,
		async frame(i) {
			const { image } = await decoder.decode({ frameIndex: i });
			try {
				if (!canvas) {
					source.width = image.displayWidth;
					source.height = image.displayHeight;
					canvas = new OffscreenCanvas(source.width, source.height);
					ctx = canvas.getContext('2d', { willReadFrequently: true });
				}
				ctx.clearRect(0, 0, source.width, source.height);
				ctx.drawImage(image, 0, 0, source.width, source.height);
				// VideoFrame durations are in microseconds, and absent on a still.
				const ms = image.duration ? Math.round(image.duration / 1000) : 0;
				return { rgba: ctx.getImageData(0, 0, source.width, source.height).data, ms };
			} finally {
				image.close();
			}
		},
		close() {
			decoder.close();
		},
	};
	// The size is only known once a frame has been decoded.
	await source.frame(0);
	return source;
}

/**
 * The file to keep for a sticker: a GIF when it moves, a PNG when it doesn't.
 *
 * @returns {Promise<{ blob: Blob, ext: string, width: number, height: number, frames: number, ms: number } | null>}
 *   null when this browser can't decode the original, which is then the file to keep.
 */
export async function stickerFile(blob) {
	const source = await openFrames(blob);
	if (!source) return null;
	try {
		const { width, height, count } = source;
		if (count === 1) {
			const { rgba } = await source.frame(0);
			const canvas = new OffscreenCanvas(width, height);
			canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
			const png = await canvas.convertToBlob({ type: 'image/png' });
			return { blob: png, ext: 'png', width, height, frames: 1, ms: 0 };
		}
		const { bytes, frames, ms } = await encodeGif(source);
		return { blob: new Blob([bytes], { type: 'image/gif' }), ext: 'gif', width, height, frames, ms };
	} finally {
		source.close();
	}
}

// ------------------------------------------------------------------ palette

/** Six bits a channel: fine enough to choose colours from, small enough to count in an array. */
const BIN_BITS = 6;
const BIN_SHIFT = 8 - BIN_BITS;
const BINS = 1 << (BIN_BITS * 3);

const binOf = (r, g, b) => ((r >> BIN_SHIFT) << (BIN_BITS * 2)) | ((g >> BIN_SHIFT) << BIN_BITS) | (b >> BIN_SHIFT);

class Histogram {
	constructor() {
		this.count = new Float64Array(BINS);
		/**
		 * Per bin, the exact colours that fell in it, summed — so a palette entry is
		 * a real average and not a bin's corner.
		 */
		this.sum = new Float64Array(BINS * 3);
	}

	/**
	 * Count a frame's opaque pixels — only the ones that changed since the frame
	 * before it, when there is one. That is `stats_mode=diff`: a background that
	 * sits still for the whole clip is counted once, not once a frame.
	 */
	add(rgba, prev) {
		for (let p = 0; p < rgba.length; p += 4) {
			if (rgba[p + 3] < ALPHA_CUTOFF) continue;
			if (
				prev &&
				prev[p + 3] >= ALPHA_CUTOFF &&
				prev[p] === rgba[p] &&
				prev[p + 1] === rgba[p + 1] &&
				prev[p + 2] === rgba[p + 2]
			)
				continue;
			const bin = binOf(rgba[p], rgba[p + 1], rgba[p + 2]);
			this.count[bin]++;
			this.sum[bin * 3] += rgba[p];
			this.sum[bin * 3 + 1] += rgba[p + 1];
			this.sum[bin * 3 + 2] += rgba[p + 2];
		}
	}
}

/**
 * Median cut over the histogram: start with one box holding every colour, and
 * keep splitting the box whose colours are furthest from its own average, at
 * the weighted median of the channel they spread along most, until there are
 * `max` boxes. Each box's average is a palette entry.
 */
function medianCut(hist, max) {
	const bins = [];
	for (let b = 0; b < BINS; b++) if (hist.count[b]) bins.push(b);
	if (!bins.length) return [[0, 0, 0]];

	const n = bins.length;
	const w = new Float64Array(n);
	const chan = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
	bins.forEach((b, i) => {
		w[i] = hist.count[b];
		for (let c = 0; c < 3; c++) chan[c][i] = hist.sum[b * 3 + c] / hist.count[b];
	});
	const order = new Int32Array(n);
	for (let i = 0; i < n; i++) order[i] = i;

	const box = (start, end) => {
		let total = 0;
		const s = [0, 0, 0];
		const sq = [0, 0, 0];
		for (let k = start; k < end; k++) {
			const i = order[k];
			total += w[i];
			for (let c = 0; c < 3; c++) {
				s[c] += w[i] * chan[c][i];
				sq[c] += w[i] * chan[c][i] * chan[c][i];
			}
		}
		const err = sq.map((v, c) => v - (s[c] * s[c]) / total);
		const axis = err.indexOf(Math.max(...err));
		return {
			start,
			end,
			total,
			mean: s.map((v) => v / total),
			score: end - start > 1 ? err[0] + err[1] + err[2] : -1,
			axis,
		};
	};

	const boxes = [box(0, n)];
	while (boxes.length < max) {
		let pick = -1;
		for (let i = 0; i < boxes.length; i++) {
			if (boxes[i].score > 0 && (pick < 0 || boxes[i].score > boxes[pick].score)) pick = i;
		}
		if (pick < 0) break;
		const { start, end, total, axis } = boxes[pick];
		const values = chan[axis];
		order.subarray(start, end).sort((a, b) => values[a] - values[b]);
		let cut = start;
		for (let acc = 0; cut < end - 1; cut++) {
			acc += w[order[cut]];
			if (acc >= total / 2) break;
		}
		cut = Math.min(end - 1, Math.max(start + 1, cut + 1));
		boxes.splice(pick, 1, box(start, cut), box(cut, end));
	}
	return boxes.map((b) => b.mean.map((v) => Math.round(v)));
}

/**
 * Nearest palette entry for a colour, remembered per seven-bit cell — a GIF's
 * pixel count is in the tens of millions, its distinct colours a small fraction
 * of that. Searched outward from the colour's place in the palette sorted by
 * green, stopping once green alone is further than the best match so far.
 */
class Nearest {
	constructor(palette) {
		this.byGreen = palette.map((rgb, index) => ({ r: rgb[0], g: rgb[1], b: rgb[2], index })).sort((a, b) => a.g - b.g);
		this.cache = new Int16Array(1 << 21);
	}

	find(r, g, b) {
		const key = ((r >> 1) << 14) | ((g >> 1) << 7) | (b >> 1);
		const hit = this.cache[key];
		if (hit) return hit - 1;

		const list = this.byGreen;
		let lo = 0;
		let hi = list.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (list[mid].g < g) lo = mid + 1;
			else hi = mid;
		}
		let best = -1;
		let bestD = Infinity;
		for (let i = lo, j = lo - 1; i < list.length || j >= 0; i++, j--) {
			let live = false;
			for (const at of [i, j]) {
				if (at < 0 || at >= list.length) continue;
				const e = list[at];
				const dg = e.g - g;
				if (dg * dg >= bestD) continue;
				live = true;
				const d = (e.r - r) ** 2 + dg * dg + (e.b - b) ** 2;
				if (d < bestD) {
					bestD = d;
					best = e.index;
				}
			}
			if (!live && best >= 0) break;
		}
		this.cache[key] = best + 1;
		return best;
	}
}

// -------------------------------------------------------------------- frames

/** A frame as palette indices, transparent pixels as CLEAR. */
function toIndices(rgba, nearest) {
	const out = new Uint8Array(rgba.length >> 2);
	for (let p = 0, i = 0; p < rgba.length; p += 4, i++) {
		out[i] = rgba[p + 3] < ALPHA_CUTOFF ? CLEAR : nearest.find(rgba[p], rgba[p + 1], rgba[p + 2]);
	}
	return out;
}

function sameIndices(a, b) {
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Whether anything drawn in `a` is gone in `b` — which painting over `a` can never show. */
function opensHole(a, b) {
	for (let i = 0; i < a.length; i++) if (a[i] !== CLEAR && b[i] === CLEAR) return true;
	return false;
}

/** The smallest rectangle holding every pixel `keep` accepts; a 1×1 one at the origin when none does. */
function bounds(width, height, keep) {
	let x0 = width;
	let y0 = height;
	let x1 = -1;
	let y1 = -1;
	for (let y = 0, i = 0; y < height; y++) {
		for (let x = 0; x < width; x++, i++) {
			if (!keep(i)) continue;
			if (x < x0) x0 = x;
			if (x > x1) x1 = x;
			if (y < y0) y0 = y;
			if (y > y1) y1 = y;
		}
	}
	if (x1 < 0) return { x: 0, y: 0, w: 1, h: 1 };
	return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function crop(indices, width, rect, pick) {
	const out = new Uint8Array(rect.w * rect.h);
	for (let y = 0, o = 0; y < rect.h; y++) {
		for (let x = 0, i = (rect.y + y) * width + rect.x; x < rect.w; x++, i++, o++) out[o] = pick(i);
	}
	return out;
}

// -------------------------------------------------------------------- output

class Bytes {
	constructor(size = 1 << 16) {
		this.buf = new Uint8Array(size);
		this.length = 0;
	}

	room(n) {
		if (this.length + n <= this.buf.length) return;
		let size = this.buf.length * 2;
		while (size < this.length + n) size *= 2;
		const next = new Uint8Array(size);
		next.set(this.buf.subarray(0, this.length));
		this.buf = next;
	}

	byte(b) {
		this.room(1);
		this.buf[this.length++] = b;
	}

	u16(n) {
		this.byte(n & 0xff);
		this.byte((n >> 8) & 0xff);
	}

	ascii(text) {
		for (const ch of text) this.byte(ch.charCodeAt(0));
	}

	bytes(arr) {
		this.room(arr.length);
		this.buf.set(arr, this.length);
		this.length += arr.length;
	}

	done() {
		return this.buf.slice(0, this.length);
	}
}

/**
 * LZW's string table, shared across calls and never cleared: each run, and each
 * reset inside one, takes a new generation, and an entry from an older one reads
 * as absent. Clearing a million-entry table on every reset would be most of the
 * encoder's time.
 */
let stamp = null;
let codes = null;
let generation = 0;

/** One frame's pixels, LZW-compressed into GIF data sub-blocks. Codes are 8-bit, since the palette is 256. */
function writePixels(out, pixels) {
	if (!stamp) {
		stamp = new Int32Array(1 << 20);
		codes = new Uint16Array(1 << 20);
	}
	const MIN = 8;
	const clear = 1 << MIN;
	const end = clear + 1;
	let next = end + 1;
	let size = MIN + 1;
	let acc = 0;
	let bits = 0;
	const raw = new Bytes(pixels.length + 64);
	const emit = (code) => {
		acc |= code << bits;
		bits += size;
		while (bits >= 8) {
			raw.byte(acc & 0xff);
			acc >>>= 8;
			bits -= 8;
		}
	};

	generation++;
	emit(clear);
	let prefix = pixels[0];
	for (let i = 1; i < pixels.length; i++) {
		const k = pixels[i];
		const key = (prefix << 8) | k;
		if (stamp[key] === generation) {
			prefix = codes[key];
			continue;
		}
		emit(prefix);
		if (next === 4096) {
			// The table is full: start a new one, and say so in the stream.
			emit(clear);
			next = end + 1;
			size = MIN + 1;
			generation++;
		} else {
			if (next >= 1 << size) size++;
			stamp[key] = generation;
			codes[key] = next++;
		}
		prefix = k;
	}
	emit(prefix);
	emit(end);
	if (bits > 0) raw.byte(acc & 0xff);

	out.byte(MIN);
	const data = raw.done();
	for (let at = 0; at < data.length; at += 255) {
		const block = data.subarray(at, at + 255);
		out.byte(block.length);
		out.bytes(block);
	}
	out.byte(0);
}

/**
 * Encode every frame of `source` as a looping GIF.
 *
 * `source` is what `openFrames` returns: `{ count, width, height, frame(i) }`,
 * with `frame(i)` resolving to `{ rgba, ms }`. Anything shaped like that will do,
 * which is how src/dev/gif.html feeds it frames of its own.
 *
 * Frames are written as small as they can be without changing what is seen.
 * One that only adds to the last is just the rectangle that changed, with
 * the unchanged pixels inside it left transparent so they show through. One
 * that takes something away can't be drawn over the last at all — GIF has no
 * way to paint a pixel back to transparent — so the frame before it is told to
 * clear itself once shown, and both of them are written whole. Identical frames
 * in a row become one frame shown for as long as all of them.
 */
export async function encodeGif(source) {
	const { count } = source;
	const durations = [];

	// First pass: what colours the clip is made of.
	const hist = new Histogram();
	let prev = null;
	for (let i = 0; i < count; i++) {
		const { rgba, ms } = await source.frame(i);
		durations.push(ms > 0 ? ms : DEFAULT_FRAME_MS);
		hist.add(rgba, prev);
		prev = rgba;
	}
	prev = null;
	const { width, height } = source;
	const palette = medianCut(hist, CLEAR);
	const nearest = new Nearest(palette);

	// Second pass: each frame in those colours, with repeats folded into the one
	// before them. Read one ahead, since how a frame is written depends on the
	// frame that follows it.
	let read = 0;
	let pending = null;
	const nextFrame = async () => {
		while (read < count) {
			const i = read++;
			const indices = toIndices((await source.frame(i)).rgba, nearest);
			if (pending && sameIndices(pending.indices, indices)) {
				pending.ms += durations[i];
				continue;
			}
			const done = pending;
			pending = { indices, ms: durations[i] };
			if (done) return done;
		}
		const last = pending;
		pending = null;
		return last;
	};

	const out = new Bytes(1 << 20);
	out.ascii('GIF89a');
	out.u16(width);
	out.u16(height);
	out.byte(0xf7); // a global colour table of 256 entries, 8 bits a channel
	out.byte(CLEAR);
	out.byte(0);
	for (let i = 0; i < 256; i++) {
		const rgb = palette[i] || [0, 0, 0];
		out.byte(rgb[0]);
		out.byte(rgb[1]);
		out.byte(rgb[2]);
	}
	// NETSCAPE2.0: loop for ever.
	out.bytes([0x21, 0xff, 0x0b]);
	out.ascii('NETSCAPE2.0');
	out.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);

	const first = await nextFrame();
	let frame = first;
	let after = await nextFrame();
	/** What the canvas shows before `frame` is drawn: the last frame, or nothing at all. */
	let canvas = null;
	let elapsedMs = 0;
	let shownCs = 0;
	let frames = 0;

	while (frame) {
		// After the last frame comes the first again, and a frame that leaves
		// nothing to draw over has to know that too.
		const clearAfter = opensHole(frame.indices, (after || first).indices);
		const whole = canvas === null || clearAfter;

		const cur = frame.indices;
		const was = canvas;
		const rect = whole
			? bounds(width, height, (i) => cur[i] !== CLEAR)
			: bounds(width, height, (i) => cur[i] !== was[i]);
		const pixels = whole
			? crop(cur, width, rect, (i) => cur[i])
			: crop(cur, width, rect, (i) => (cur[i] === was[i] ? CLEAR : cur[i]));

		// Rounded against the running total, not frame by frame, so a clip of 33ms
		// frames doesn't drift a whole second behind the original over a minute.
		elapsedMs += frame.ms;
		const delay = Math.max(MIN_DELAY_CS, Math.round(elapsedMs / 10) - shownCs);
		shownCs += delay;

		out.bytes([0x21, 0xf9, 0x04, ((clearAfter ? 2 : 1) << 2) | 1]);
		out.u16(delay);
		out.bytes([CLEAR, 0x00]);
		out.byte(0x2c);
		out.u16(rect.x);
		out.u16(rect.y);
		out.u16(rect.w);
		out.u16(rect.h);
		out.byte(0);
		writePixels(out, pixels);
		frames++;

		canvas = clearAfter ? null : cur;
		frame = after;
		after = after ? await nextFrame() : null;
	}
	out.byte(0x3b);
	return { bytes: out.done(), frames, ms: shownCs * 10, palette };
}
