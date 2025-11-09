import { app } from "../../../scripts/app.js";
import { importA1111 } from "../../../scripts/pnginfo.js";
import { ComfyWidgets } from "../../../scripts/widgets.js";

/* ======================================================================
   Globals and helpers
====================================================================== */

let isExporting = false;
let getDrawTextConfig = null;
let fileInput = null;

// Choose a solid background color from the current theme/canvas/body
function getCanvasBackgroundColor() {
	const canvasEl = app?.canvas?.canvas;
	const transparent = (c) => !c || c === "transparent" || c === "rgba(0, 0, 0, 0)";

	let c = canvasEl ? getComputedStyle(canvasEl).backgroundColor : "";
	if (transparent(c)) {
		const bodyC = getComputedStyle(document.body).backgroundColor;
		c = transparent(bodyC) ? c : bodyC;
	}
	if (transparent(c)) {
		const root = getComputedStyle(document.documentElement);
		const scheme = (root.getPropertyValue("color-scheme") || "").toLowerCase();
		c = scheme.includes("dark") ? "#111111" : "#ffffff";
	}
	return c;
}

// Convert a dataURL to a Blob (fallback when toBlob is null/throws)
function dataURLToBlob(dataURL) {
	const [header, data] = dataURL.split(",");
	const isBase64 = /;base64$/i.test(header);
	const mime = (header.match(/^data:([^;]+)/i) || [, "application/octet-stream"])[1];
	let bytes;
	if (isBase64) {
		bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
	} else {
		bytes = new TextEncoder().encode(decodeURIComponent(data));
	}
	return new Blob([bytes], { type: mime });
}

/* ======================================================================
   Debug logger
====================================================================== */

class DebugLogger {
	static logs = [];
	static log(message) {
		const timestamp = new Date().toISOString();
		const logEntry = `[${timestamp}] ${message}`;
		this.logs.push(logEntry);
		console.log(logEntry);
	}
	static async saveToFile() {
		try {
			const logContent = this.logs.join("\n");
			const blob = new Blob([logContent], { type: "text/plain" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = "workflow-debug.log";
			a.style.display = "none";
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		} catch (error) {
			console.error("Failed to save debug log:", error);
		}
	}
	static clear() {
		this.logs = [];
	}
}

/* ======================================================================
   Base class: WorkflowImage
====================================================================== */

class WorkflowImage {
	static accept = "";

	getBounds() {
		// Calculate the min/max bounds for nodes and groups
		let bounds = [99999, 99999, -99999, -99999];

		// Nodes
		if (app.graph._nodes) {
			DebugLogger.log("=== NODES FOUND ===");
			app.graph._nodes.forEach((n, i) => {
				const nodeBounds = n.getBounding();
				const r = n.pos[0] + nodeBounds[2];
				const b = n.pos[1] + nodeBounds[3];
				DebugLogger.log(
					`Node ${i}: ${n.type || "unknown"} at [${n.pos[0]}, ${n.pos[1]}] size [${nodeBounds[2]}, ${nodeBounds[3]}] bounds [${n.pos[0]}-${r}, ${n.pos[1]}-${b}]`
				);
			});

			bounds = app.graph._nodes.reduce((p, n) => {
				if (n.pos[0] < p[0]) p[0] = n.pos[0];
				if (n.pos[1] < p[1]) p[1] = n.pos[1];
				const nodeBounds = n.getBounding();
				const r = n.pos[0] + nodeBounds[2];
				const b = n.pos[1] + nodeBounds[3];
				if (r > p[2]) p[2] = r;
				if (b > p[3]) p[3] = b;
				return p;
			}, bounds);
		}

		// Groups
		if (app.graph._groups) {
			DebugLogger.log("=== GROUPS FOUND ===");
			app.graph._groups.forEach((g, i) => {
				const r = g.pos[0] + g.size[0];
				const b = g.pos[1] + g.size[1];
				DebugLogger.log(
					`Group ${i}: "${g.title}" at [${g.pos[0]}, ${g.pos[1]}] size [${g.size[0]}, ${g.size[1]}] bounds [${g.pos[0]}-${r}, ${g.pos[1]}-${b}]`
				);
			});

			bounds = app.graph._groups.reduce((p, g) => {
				if (g.pos[0] < p[0]) p[0] = g.pos[0];
				if (g.pos[1] < p[1]) p[1] = g.pos[1];
				const r = g.pos[0] + g.size[0];
				const b = g.pos[1] + g.size[1];
				if (r > p[2]) p[2] = r;
				if (b > p[3]) p[3] = b;
				return p;
			}, bounds);
		}

		// Padding
		bounds[0] -= 100;
		bounds[1] -= 100;
		bounds[2] += 100;
		bounds[3] += 100;

		DebugLogger.log("=== FINAL BOUNDS ===");
		DebugLogger.log(`Calculated bounds: [${bounds.join(", ")}]`);
		DebugLogger.log(`Canvas will be: ${bounds[2] - bounds[0]} x ${bounds[3] - bounds[1]}`);
		return bounds;
	}

	saveState() {
		const ctx = app.canvas.canvas.getContext("2d");
		this.state = {
			scale: app.canvas.ds.scale,
			width: app.canvas.canvas.width,
			height: app.canvas.canvas.height,
			style_width: app.canvas.canvas.style.width,
			style_height: app.canvas.canvas.style.height,
			offset: [...app.canvas.ds.offset],
			transform: ctx.getTransform(),
			clear_background: app.canvas.clear_background,
			clear_background_color: app.canvas.clear_background_color,
			ctx: app.canvas.ctx
		};
	}

	restoreState() {
		try {
			app.canvas.ds.scale = this.state.scale;
			app.canvas.canvas.width = this.state.width;
			app.canvas.canvas.height = this.state.height;
			app.canvas.canvas.style.width = this.state.style_width || "";
			app.canvas.canvas.style.height = this.state.style_height || "";
			app.canvas.ds.offset = [...this.state.offset];
			const ctx = app.canvas.canvas.getContext("2d");
			if (typeof ctx.resetTransform === "function") ctx.resetTransform();
			ctx.setTransform(this.state.transform);
			app.canvas.clear_background = this.state.clear_background;
			app.canvas.clear_background_color = this.state.clear_background_color;
			app.canvas.ctx = this.state.ctx;
		} catch (e) {
			console.error("Failed to restore canvas state:", e);
		}
	}

	getDrawTextConfig(_, widget) {
		// Draw in graph coordinates so transforms (offset/scale/DPR) place it correctly
		return {
			x: 10,
			y: widget.last_y + 10,
			resetTransform: false
		};
	}

	updateView(bounds) {
		// Render the whole graph at devicePixelRatio resolution (raster path)
		const dpr = Math.max(1, window.devicePixelRatio || 1);
		const width = bounds[2] - bounds[0];
		const height = bounds[3] - bounds[1];

		// Set CSS size to logical pixels
		app.canvas.canvas.style.width = `${width}px`;
		app.canvas.canvas.style.height = `${height}px`;

		// Backing store in physical pixels
		app.canvas.canvas.width = Math.round(width * dpr);
		app.canvas.canvas.height = Math.round(height * dpr);

		// Reset graph zoom/pan to 1 and pan to the top-left of bounds
		app.canvas.ds.scale = 1;
		app.canvas.ds.offset = [-bounds[0], -bounds[1]];

		// Set context transform to DPR so draws cover the full backing store
		const ctx = app.canvas.canvas.getContext("2d");
		if (typeof ctx.resetTransform === "function") ctx.resetTransform();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		DebugLogger.log(`updateView: dpr=${dpr}, css=${width}x${height}, backing=${app.canvas.canvas.width}x${app.canvas.canvas.height}, offset=[${app.canvas.ds.offset}]`);
	}

	async export(includeWorkflow) {
		DebugLogger.clear();
		this.saveState();

		let blob = null;
		isExporting = true;
		try {
			DebugLogger.log("=== STARTING EXPORT ===");
			const bounds = this.getBounds();
			this.updateView(bounds);

			// We draw our own full-size background (backing store coords)
			const bg = getCanvasBackgroundColor();
			const ctx = app.canvas.canvas.getContext("2d");
			ctx.save();
			if (typeof ctx.resetTransform === "function") ctx.resetTransform();
			ctx.clearRect(0, 0, app.canvas.canvas.width, app.canvas.canvas.height);
			ctx.fillStyle = bg;
			ctx.fillRect(0, 0, app.canvas.canvas.width, app.canvas.canvas.height);
			ctx.restore();

			// Disable engine background during export to prevent partial redraws
			const prevClear = app.canvas.clear_background;
			const prevClearColor = app.canvas.clear_background_color;
			app.canvas.clear_background = false;
			app.canvas.clear_background_color = bg;

			getDrawTextConfig = this.getDrawTextConfig;
			app.canvas.draw(true, true);
			getDrawTextConfig = null;

			// Restore those two flags immediately (full restore happens in finally)
			app.canvas.clear_background = prevClear;
			app.canvas.clear_background_color = prevClearColor;

			blob = await this.getBlob(includeWorkflow ? JSON.stringify(app.graph.serialize()) : undefined);
		} catch (e) {
			console.error("Export failed:", e);
			DebugLogger.log("Export failed: " + (e?.stack || e));
			try {
				await DebugLogger.saveToFile();
			} catch {}
			throw e;
		} finally {
			try {
				this.restoreState();
				app.canvas.draw(true, true);
			} catch (restoreErr) {
				console.error("Failed to restore canvas state:", restoreErr);
				DebugLogger.log("Restore failed: " + (restoreErr?.stack || restoreErr));
			}
			getDrawTextConfig = null;
			isExporting = false;
		}

		DebugLogger.log("=== EXPORT COMPLETED ===");
		this.download(blob);
	}

	download(blob) {
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		Object.assign(a, {
			href: url,
			download: "workflow." + this.extension,
			style: "display: " + "none"
		});
		document.body.append(a);
		a.click();
		setTimeout(function () {
			a.remove();
			window.URL.revokeObjectURL(url);
		}, 0);
	}

	static import() {
		if (!fileInput) {
			fileInput = document.createElement("input");
			Object.assign(fileInput, {
				type: "file",
				style: "display: " + "none",
				onchange: () => {
					app.handleFile(fileInput.files[0]);
				}
			});
			document.body.append(fileInput);
		}
		fileInput.accept = WorkflowImage.accept;
		fileInput.click();
	}
}

/* ======================================================================
   PNG exporter
====================================================================== */

class PngWorkflowImage extends WorkflowImage {
	static accept = ".png,image/png";
	extension = "png";

	n2b(n) {
		return new Uint8Array([(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
	}

	joinArrayBuffer(...bufs) {
		const result = new Uint8Array(bufs.reduce((totalSize, buf) => totalSize + buf.byteLength, 0));
		bufs.reduce((offset, buf) => {
			result.set(buf, offset);
			return offset + buf.byteLength;
		}, 0);
		return result;
	}

	crc32(data) {
		const crcTable =
			PngWorkflowImage.crcTable ||
			(PngWorkflowImage.crcTable = (() => {
				let c;
				const crcTable = [];
				for (let n = 0; n < 256; n++) {
					c = n;
					for (let k = 0; k < 8; k++) {
						c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
					}
					crcTable[n] = c;
				}
				return crcTable;
			})());
		let crc = 0 ^ -1;
		for (let i = 0; i < data.byteLength; i++) {
			crc = (crc >>> 8) ^ crcTable[(crc ^ data[i]) & 0xff];
		}
		return (crc ^ -1) >>> 0;
	}

	async getBlob(workflow) {
		return new Promise((resolve, reject) => {
			const canvasEl = app.canvas?.canvas;
			if (!canvasEl) {
				const err = new Error("ComfyUI canvas not found");
				DebugLogger.log(err.message);
				return reject(err);
			}

			try {
				canvasEl.toBlob(async (blob) => {
					try {
						if (!blob) {
							// Some engines return null for tainted canvas
							DebugLogger.log("canvas.toBlob returned null; attempting dataURL fallback…");
							const dataURL = canvasEl.toDataURL("image/png"); // may throw if tainted
							blob = dataURLToBlob(dataURL);
						}

						if (workflow) {
							try {
								const buffer = await blob.arrayBuffer();
								const typedArr = new Uint8Array(buffer);
								const view = new DataView(buffer);

								const enc = new TextEncoder();
								const type = enc.encode("tEXt");
								const keyword = enc.encode("workflow");
								const nullSep = new Uint8Array([0]);
								const text = enc.encode(workflow);

								// PNG tEXt: [len][type][keyword(<=79)][0x00][text][crc(type+data)]
								const data = this.joinArrayBuffer(keyword, nullSep, text);
								const lenBytes = this.n2b(data.byteLength);
								const crcBytes = this.n2b(this.crc32(this.joinArrayBuffer(type, data)));
								const chunk = this.joinArrayBuffer(lenBytes, type, data, crcBytes);

								// Insert right after IHDR
								const ihdrDataLen = view.getUint32(8, false);
								const insertAt = 8 + 12 + ihdrDataLen;

								const result = this.joinArrayBuffer(
									typedArr.subarray(0, insertAt),
									chunk,
									typedArr.subarray(insertAt)
								);
								blob = new Blob([result], { type: "image/png" });
							} catch (embedErr) {
								DebugLogger.log("PNG embed failed: " + (embedErr?.stack || embedErr));
								// continue with non-embedded blob
							}
						}

						resolve(blob);
					} catch (callbackErr) {
						DebugLogger.log("toBlob callback failed: " + (callbackErr?.stack || callbackErr));
						reject(callbackErr);
					}
				}, "image/png");
			} catch (e) {
				// Fallback if toBlob throws
				DebugLogger.log("canvas.toBlob threw: " + (e?.stack || e));
				try {
					const dataURL = canvasEl.toDataURL("image/png");
					resolve(dataURLToBlob(dataURL));
				} catch (e2) {
					DebugLogger.log("dataURL fallback failed: " + (e2?.stack || e2));
					reject(e2);
				}
			}
		});
	}
}

/* ======================================================================
   JPEG/EXIF helpers (for SVG import + A1111 compatible import)
====================================================================== */

class DataReader {
	view;
	littleEndian;
	offset = 0;
	constructor(view) {
		this.view = view;
	}
	read(size, signed = false, littleEndian = undefined) {
		const v = this.peek(size, signed, littleEndian);
		this.offset += size;
		return v;
	}
	peek(size, signed = false, littleEndian = undefined) {
		this.view.getBigInt64; // ensure presence in older engines
		let m = "";
		if (size === 8) m += "Big";
		m += signed ? "Int" : "Uint";
		m += size * 8;
		m = "get" + m;
		if (!this.view[m]) {
			throw new Error("Method not found: " + m);
		}
		return this.view[m](this.offset, littleEndian == null ? this.littleEndian : littleEndian);
	}
	seek(pos, relative = true) {
		if (relative) {
			this.offset += pos;
		} else {
			this.offset = pos;
		}
	}
}

class Tiff {
	#reader;
	#start;

	readExif(reader) {
		const TIFF_MARKER = 0x2a;
		const EXIF_IFD = 0x8769;

		this.#reader = reader;
		this.#start = this.#reader.offset;
		this.#readEndianness();

		if (this.#reader.read(2) !== TIFF_MARKER) {
			throw new Error("Invalid TIFF: Marker not found.");
		}

		const dirOffset = this.#reader.read(4);
		this.#reader.seek(this.#start + dirOffset, false);

		for (const t of this.#readTags()) {
			if (t.id === EXIF_IFD) {
				return this.#readExifTag(t);
			}
		}
		throw new Error("No EXIF: TIFF Exif IFD tag not found");
	}

	#readUserComment(tag) {
		this.#reader.seek(this.#start + tag.offset, false);
		const encoding = this.#reader.read(8);
		if (encoding !== 0x45444f43494e55n) {
			throw new Error("Unable to read non-Unicode data");
		}
		const decoder = new TextDecoder("utf-16be");
		return decoder.decode(new DataView(this.#reader.view.buffer, this.#reader.offset, tag.count - 8));
	}

	#readExifTag(exifTag) {
		const EXIF_USER_COMMENT = 0x9286;

		this.#reader.seek(this.#start + exifTag.offset, false);
		for (const t of this.#readTags()) {
			if (t.id === EXIF_USER_COMMENT) {
				return this.#readUserComment(t);
			}
		}
		throw new Error("No embedded data: UserComment Exif tag not found");
	}

	*#readTags() {
		const count = this.#reader.read(2);
		for (let i = 0; i < count; i++) {
			yield {
				id: this.#reader.read(2),
				type: this.#reader.read(2),
				count: this.#reader.read(4),
				offset: this.#reader.read(4)
			};
		}
	}

	#readEndianness() {
		const II = 0x4949;
		const MM = 0x4d4d;
		const endianness = this.#reader.read(2);
		if (endianness === II) {
			this.#reader.littleEndian = true;
		} else if (endianness === MM) {
			this.#reader.littleEndian = false;
		} else {
			throw new Error("Invalid JPEG: Endianness marker not found.");
		}
	}
}

class Jpeg {
	#reader;

	readExif(buffer) {
		const JPEG_MARKER = 0xffd8;
		const EXIF_SIG = 0x45786966;

		this.#reader = new DataReader(new DataView(buffer));
		if (this.#reader.read(2) !== JPEG_MARKER) {
			throw new Error("Invalid JPEG: SOI not found.");
		}

		const app0 = this.#readAppMarkerId();
		if (app0 !== 0) {
			throw new Error(`Invalid JPEG: APP0 not found [found: ${app0}].`);
		}

		this.#consumeAppSegment();
		const app1 = this.#readAppMarkerId();
		if (app1 !== 1) {
			throw new Error(`No EXIF: APP1 not found [found: ${app0}].`);
		}

		// Skip APP1 size
		this.#reader.seek(2);

		if (this.#reader.read(4) !== EXIF_SIG) {
			throw new Error(`No EXIF: Invalid EXIF header signature.`);
		}
		if (this.#reader.read(2) !== 0) {
			throw new Error(`No EXIF: Invalid EXIF header.`);
		}

		return new Tiff().readExif(this.#reader);
	}

	#readAppMarkerId() {
		const APP0_MARKER = 0xffe0;
		return this.#reader.read(2) - APP0_MARKER;
	}

	#consumeAppSegment() {
		this.#reader.seek(this.#reader.read(2) - 2);
	}
}

/* ======================================================================
   SVG exporter
====================================================================== */

class SvgWorkflowImage extends WorkflowImage {
	static accept = ".svg,image/svg+xml";
	extension = "svg";

	static init() {
		// Override file handling to allow drag & drop of SVG and EXIF JPEG
		const handleFile = app.handleFile;
		app.handleFile = async function (file) {
			if (file && (file.type === "image/svg+xml" || file.name?.endsWith(".svg"))) {
				const reader = new FileReader();
				reader.onload = () => {
					// Extract embedded workflow from <desc>
					const descEnd = reader.result.lastIndexOf("</desc>");
					if (descEnd !== -1) {
						const descStart = reader.result.lastIndexOf("<desc>", descEnd);
						if (descStart !== -1) {
							const json = reader.result.substring(descStart + 6, descEnd);
							this.loadGraphData(JSON.parse(SvgWorkflowImage.unescapeXml(json)));
						}
					}
				};
				reader.readAsText(file);
				return;
			} else if (file && (file.type === "image/jpeg" || file.name?.endsWith(".jpg") || file.name?.endsWith(".jpeg"))) {
				if (
					await new Promise((resolve) => {
						try {
							const reader = new FileReader();
							reader.onload = async () => {
								try {
									const value = new Jpeg().readExif(reader.result);
									importA1111(app.graph, value);
									resolve(true);
								} catch (error) {
									resolve(false);
								}
							};
							reader.onerror = () => resolve(false);
							reader.readAsArrayBuffer(file);
						} catch (error) {
							resolve(false);
						}
					})
				) {
					return;
				}
			}
			return handleFile.apply(this, arguments);
		};
	}

	static escapeXml(unsafe) {
		return unsafe.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	}
	static unescapeXml(safe) {
		return safe.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
	}

	getDrawTextConfig(_, widget) {
		// IMPORTANT: draw in graph coordinates (like PNG), not DOM coords
		return {
			x: 10,
			y: widget.last_y + 10,
			resetTransform: false
		};
	}

	saveState() {
		super.saveState();
		this.state.ctx = app.canvas.ctx;
	}
	restoreState() {
		super.restoreState();
		app.canvas.ctx = this.state.ctx;
	}

	updateView(bounds) {
		// Reuse parent’s DS/offset prep (raster dpr settings don't affect svgCtx)
		super.updateView(bounds);
		this.createSvgCtx(bounds);
	}

	createSvgCtx(bounds) {
		const width = bounds[2] - bounds[0];
		const height = bounds[3] - bounds[1];
		const dpr = Math.max(1, window.devicePixelRatio || 1);

		// Create SVG at DPR-sized backing store, then scale content by DPR.
		const svgCtx = (this.svgCtx = new C2S(Math.round(width * dpr), Math.round(height * dpr)));
		svgCtx.canvas.getBoundingClientRect = function () {
			return { width: svgCtx.width, height: svgCtx.height };
		};

		// Match PNG export pipeline: scale by DPR so engine drawing lands correctly
		if (typeof svgCtx.scale === "function") {
			svgCtx.scale(dpr, dpr);
		} else if (typeof svgCtx.transform === "function") {
			svgCtx.transform(dpr, 0, 0, dpr, 0, 0);
		}

		// Full-size background AFTER scale so width/height are logical units
		const bg = getCanvasBackgroundColor();
		svgCtx.save?.();
		svgCtx.fillStyle = bg;
		svgCtx.fillRect(0, 0, width, height);
		svgCtx.restore?.();

		// Provide minimal canvas API compatibility
		const prevCtx = this.state.ctx;

		// Proxy getTransform/resetTransform to previous 2D context if needed
		svgCtx.getTransform = function () {
			return prevCtx.getTransform();
		};
		svgCtx.resetTransform = function () {
			return prevCtx.resetTransform();
		};

		// Ensure roundRect exists
		svgCtx.roundRect = svgCtx.rect;

		// Override drawImage to embed external IMG as bitmap
		const drawImage = svgCtx.drawImage;
		svgCtx.drawImage = function (...args) {
			const image = args[0];
			if (image?.nodeName === "IMG" && !image.src.startsWith("data:image/")) {
				const canvas = document.createElement("canvas");
				canvas.width = image.width;
				canvas.height = image.height;
				const imgCtx = canvas.getContext("2d");
				imgCtx.drawImage(image, 0, 0);
				args[0] = canvas;
			}
			return drawImage.apply(this, args);
		};

		// Swap ctx so LGraphCanvas draws into our SVG
		app.canvas.ctx = svgCtx;
	}

	getBlob(workflow) {
		// Keep a style background as well (harmless redundancy)
		let svg = this.svgCtx
			.getSerializedSvg(true)
			.replace("<svg ", `<svg style="background: ${app.canvas.clear_background_color}" `);

		if (workflow) {
			svg = svg.replace("</svg>", `<desc>${SvgWorkflowImage.escapeXml(workflow)}</desc></svg>`);
		}

		return new Blob([svg], { type: "image/svg+xml" });
	}
}

/* ======================================================================
   Extension registration
====================================================================== */

app.registerExtension({
	name: "pysssss.WorkflowImage",
	init() {
		// https://codepen.io/peterhry/pen/nbMaYg
		function wrapText(context, text, x, y, maxWidth, lineHeight) {
			var words = text.split(" "),
				line = "",
				i,
				test,
				metrics;

			for (i = 0; i < words.length; i++) {
				test = words[i];
				metrics = context.measureText(test);
				while (metrics.width > maxWidth) {
					// Determine how much of the word will fit
					test = test.substring(0, test.length - 1);
					metrics = context.measureText(test);
				}
				if (words[i] != test) {
					words.splice(i + 1, 0, words[i].substr(test.length));
					words[i] = test;
				}

				test = line + words[i] + " ";
				metrics = context.measureText(test);

				if (metrics.width > maxWidth && i > 0) {
					context.fillText(line, x, y);
					line = words[i] + " ";
					y += lineHeight;
				} else {
					line = test;
				}
			}
			context.fillText(line, x, y);
		}

		// Override multiline string widgets to draw only during export
		const stringWidget = ComfyWidgets.STRING;
		ComfyWidgets.STRING = function () {
			const w = stringWidget.apply(this, arguments);
			if (w.widget && w.widget.type === "customtext") {
				const baseDraw = w.widget.draw;
				w.widget.draw = function (ctx) {
					// Normal widget draw
					baseDraw.apply(this, arguments);

					// Only draw overlay during an export
					if (!isExporting) return;
					if (!getDrawTextConfig) return;
					if (!this.inputEl || this.inputEl.hidden) return;

					const config = getDrawTextConfig(ctx, this);
					ctx.save();
					if (config.resetTransform && typeof ctx.resetTransform === "function") {
						ctx.resetTransform();
					}

					const style = getComputedStyle(this.inputEl);
					const x = Number.isFinite(config.x) ? config.x : 10;
					const y = Number.isFinite(config.y) ? config.y : (this.last_y || 0) + 10;

					const domWrapper = this.inputEl.closest(".dom-widget") ?? this.inputEl;
					let widthPx = parseInt(domWrapper.style.width, 10);
					if (!widthPx || Number.isNaN(widthPx)) {
						widthPx = this.node?.size?.[0] ? this.node.size[0] - 20 : 300;
					}
					const heightPx = parseInt(domWrapper.style.height, 10) || 0;

					// Draw BG only if non-zero alpha
					const bg = style.getPropertyValue("background-color");
					const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)$/.exec(bg);
					const alpha = m ? (m[4] == null ? 1 : parseFloat(m[4])) : 1;
					if (alpha > 0.01) {
						ctx.fillStyle = bg;
						ctx.fillRect(x, y, widthPx, heightPx);
					}

					ctx.fillStyle = style.getPropertyValue("color") || "#fff";
					ctx.font = style.getPropertyValue("font");

					const rawLineHeight = parseInt(style.getPropertyValue("line-height"), 10);
					const lineHeight = Number.isFinite(rawLineHeight) ? rawLineHeight : 14;

					const lines = (this.inputEl.value || "").split("\n");
					let cursorY = y + lineHeight;
					for (const line of lines) {
						wrapText(ctx, line, x + 4, cursorY, widthPx, lineHeight);
						cursorY += lineHeight;
					}

					ctx.restore();
				};
			}
			return w;
		};

		console.log("[WorkflowImage] init ok");
	},
	setup() {
		function registerMenus() {
			// Add PNG always; add SVG if canvas2svg is available
			const formats = [];
			if (typeof window.C2S !== "undefined") formats.push(SvgWorkflowImage);
			formats.push(PngWorkflowImage);

			WorkflowImage.accept = formats.map((f) => f.accept).join(",");

			// Add canvas menu options
			const orig = LGraphCanvas.prototype.getCanvasMenuOptions;
			LGraphCanvas.prototype.getCanvasMenuOptions = function () {
				const options = orig.apply(this, arguments);

				options.push(null, {
					content: "Workflow Image",
					submenu: {
						options: [
							{
								content: "Import",
								callback: () => WorkflowImage.import()
							},
							{
								content: "Export",
								submenu: {
									options: formats.flatMap((f) => [
										{
											content: f.name.replace("WorkflowImage", "").toLocaleLowerCase(),
											callback: () => new f().export(true)
										},
										{
											content: f.name.replace("WorkflowImage", "").toLocaleLowerCase() + " (no embedded workflow)",
											callback: () => new f().export()
										}
									])
								}
							}
						]
					}
				});
				return options;
			};

			// Call init() hooks after menus are created
			formats.forEach((f) => f.init?.call());

			console.log("[WorkflowImage] menu registered; formats:", formats.map((f) => f.name));
		}

		// Load canvas2svg.js; register menus regardless (PNG-only if it fails)
		const script = document.createElement("script");
		script.onload = function () {
			registerMenus();
		};
		script.onerror = function () {
			console.warn("[WorkflowImage] Failed to load canvas2svg.js; SVG export will be unavailable. PNG export is enabled.");
			registerMenus(); // PNG-only
		};
		script.src = new URL(`assets/canvas2svg.js`, import.meta.url);
		document.body.append(script);
	}
});