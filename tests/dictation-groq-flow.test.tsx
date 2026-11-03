import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { useDictation, type Dictation, DICTATION_GROQ_KEYLESS } from "../components/dictation.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { useDictationLanguage } from "../components/dictation-preference.ts";
import { useDictationActive } from "../components/dictation-state.ts";
import type { UserSettings } from "../src/core/index.ts";

/** The Groq batch engine's lifecycle: record → accumulate → stop → one
 *  POST → the same deferred flush as streaming finals. No socket may ever
 *  open on the Groq engine, and a failed run must resolve finish() FALSE
 *  so a submit path never sends a message missing its dictated tail. */

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

class Socket {
	static all: Socket[] = [];
	constructor() { Socket.all.push(this); }
}

class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}

/** Forwards `emit()` into the component's onmessage handler. Posts Int16Array
 *  VIEWS — exactly what the real worklet posts (`postMessage({buffer:
 *  this.frame}, [this.frame.buffer])`) — so tests exercise the byte-shape
 *  the browser path really produces (the view-vs-ArrayBuffer mixup that
 *  caused the live "Invalid or oversized dictation audio" 400). */
class Worklet {
	static last: Worklet | undefined;
	port: { onmessage?: (e: { data: { type: string; buffer?: Int16Array | ArrayBuffer; rms?: number } }) => void } = {};
	constructor() { Worklet.last = this; }
	connect() {} disconnect() {}
	emit(samples: Int16Array | ArrayBuffer) { this.port.onmessage?.({ data: { type: "audio", buffer: samples } }); }
}

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

async function fixture(provider: "deepgram" | "groq") {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = {
		record: { version: 1, dictation: { language: "pl", provider } } as UserSettings,
		readFails: false,
		captures: 0,
		stops: 0,
		appends: [] as string[],
		groqKey: true,
		nextGroq: undefined as Promise<Response> | undefined,
		groqPosts: [] as { contentType: string | null; size: number }[],
	};
	Socket.all = [];
	Worklet.last = undefined;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => {
			state.captures++;
			return { getTracks: () => [{ stop() { state.stops++; } }] };
		} } },
		WebSocket: Socket, AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: clearTimeout,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/stt/token") return Response.json({ token: "test-token" });
			if (url === "/api/stt/groq" && (!init || !init.method || init.method === "GET")) {
				return Response.json({ present: state.groqKey });
			}
			if (url === "/api/stt/groq") {
				state.groqPosts.push({
					contentType: (init!.headers as Record<string, string>)["Content-Type"] ?? null,
					size: (init!.body as Blob).size,
				});
				if (state.nextGroq) { const next = state.nextGroq; state.nextGroq = undefined; return next; }
				return Response.json({ text: "Cześć świecie" });
			}
			if (url === "/api/settings") {
				return state.readFails ? Response.json({}, { status: 500 }) : Response.json({ settings: state.record });
			}
			assert.equal(url, "/api/settings/dictation");
			assert.equal(init?.method, "PUT");
			state.record = { ...state.record, dictation: JSON.parse(init!.body as string) };
			return Response.json({ settings: state.record });
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	const { createRoot } = await import("react-dom/client");
	let latest!: Dictation;
	let setting!: ReturnType<typeof useDictationLanguage>;
	function Harness() {
		latest = useDictation({ append: (text) => state.appends.push(text) });
		setting = useDictationLanguage();
		useDictationActive();
		return null;
	}
	let root = createRoot(document.getElementById("root")!);
	await act(async () => { root.render(<Harness />); });
	// Invalidate any prior fixture's window-lifetime preference cache.
	await act(async () => { notifySettingsSaved("dictation"); });
	dispose = async () => { await act(async () => { root.unmount(); }); };
	return {
		state,
		get dictation() { return latest; },
		get setting() { return setting; },
		get worklet() { return Worklet.last; },
		mount: async () => {}, // the harness renders at fixture time (each test mounts exactly once)
		unmount: () => dispose!(),
	};
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("the batch run accumulates worklet frames and POSTs them once at stop — no socket ever opens", async () => {
	const f = await fixture("groq");
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.dictation.active, true);
	assert.equal(Socket.all.length, 0, "the Groq engine never opens a Deepgram socket");
	assert.ok(f.worklet, "the capture graph is live");

	f.worklet!.emit(new Int16Array(2048)); // a real worklet frame: an Int16Array VIEW
	f.worklet!.emit(new Int16Array(2048));
	const finish = f.dictation.finish();
	// The stop-time POST resolves inside this act — the mock settles in
	// microtasks. The extra toggle mimics a stale-closure double-stop
	// (the pill disables, but a captured click/shortcut can re-enter):
	// the batch latch must swallow it, never teardown the live upload.
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "idle");
	assert.deepEqual(f.state.appends, ["Cześć świecie"], "the transcript flushes through the deferred buffer");
	assert.equal(f.state.groqPosts.length, 1, "exactly one upload — the latch absorbed the re-entry");
	assert.equal(f.state.groqPosts[0]!.contentType, "audio/wav");
	assert.equal(f.state.groqPosts[0]!.size, 44 + 2048 * 2 * 2, "WAV header + the two PCM frames");
	assert.equal(f.state.stops, 1, "the mic died exactly once");
	assert.equal(await finish, true, "a successful batch run lets the submit proceed");
});

test("a keyless Groq selection fails at the click with the deep-linkable line", async () => {
	const f = await fixture("groq");
	f.state.groqKey = false;
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, DICTATION_GROQ_KEYLESS);
	assert.equal(f.state.groqPosts.length, 0, "no audio ever leaves");
	assert.equal(Socket.all.length, 0);
	assert.deepEqual(f.state.appends, []);
	assert.equal(f.state.stops, 1, "the parallel mic acquisition is released");
});

test("a failed transcription surfaces the route's line and resolves finish() FALSE", async () => {
	const f = await fixture("groq");
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	f.worklet!.emit(new Int16Array(2048));
	f.state.nextGroq = Promise.resolve(Response.json({ message: "Dictation needs a Groq key." }, { status: 503 }));
	const finish = f.dictation.finish(); // a submit path awaiting this must NOT proceed
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, "Dictation needs a Groq key.");
	assert.deepEqual(f.state.appends, [], "nothing flushes on failure");
	assert.equal(await finish, false, "the submit is blocked — nothing gets lost");
});

test("cancelling a batch run discards the frames without uploading", async () => {
	const f = await fixture("groq");
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	f.worklet!.emit(new Int16Array(2048));
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.groqPosts.length, 0, "cancel never uploads");
	assert.deepEqual(f.state.appends, []);
});

test("a submit-path finish cancelled mid-upload resolves FALSE and lands nothing", async () => {
	const f = await fixture("groq");
	await f.mount();
	await act(async () => { f.dictation.toggle(); });
	f.worklet!.emit(new Int16Array(2048));
	const finish = f.dictation.finish(); // stop fires; the upload is in flight
	await act(async () => { f.dictation.cancel(); }); // the learner hits Esc anyway
	assert.equal(f.dictation.phase, "idle");
	assert.deepEqual(f.state.appends, [], "the discarded upload's text never lands");
	assert.equal(await finish, false, "the submit is blocked — nothing gets lost");
});
