import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DICTATION_SAMPLE_RATE, MAX_DICTATION_WAV_BYTES, WAV_HEADER_BYTES,
	pcm16Wav, whisperLanguageParam,
} from "../src/core/dictation.ts";
import { transcribeGroqDictation } from "../src/server/groq-dictation.ts";

/** A minimal valid capture WAV (one 16-bit sample — the header is what the
 *  validator reads). */
function sampleWav(): Blob {
	return pcm16Wav([new Int16Array([0]).buffer]);
}

function deps(overrides: Partial<Parameters<typeof transcribeGroqDictation>[1]> = {}) {
	return {
		apiKey: "gsk_test",
		enabled: true,
		language: "multi" as const,
		...overrides,
	};
}

const wavRequest = () => new Request("http://local/api/stt/groq", { method: "POST", body: sampleWav(), headers: { "Content-Type": "audio/wav" }, duplex: "half" } as RequestInit);

test("pcm16Wav emits a valid PCM WAV header at the capture rate", async () => {
	const frames = [new Int16Array([1, -1, 32767, -32768]).buffer, new Int16Array([5]).buffer];
	const blob = pcm16Wav(frames);
	const view = new DataView(await blob.arrayBuffer());
	const ascii = (offset: number, text: string) => [...text].every((char, i) => view.getUint8(offset + i) === char.charCodeAt(0));
	assert.equal(blob.type, "audio/wav");
	assert.equal(view.byteLength, WAV_HEADER_BYTES + 10);
	assert.ok(ascii(0, "RIFF") && ascii(8, "WAVE") && ascii(36, "data"));
	assert.equal(view.getUint32(4, true), view.byteLength - 8);
	assert.equal(view.getUint16(22, true), 1, "mono");
	assert.equal(view.getUint32(24, true), DICTATION_SAMPLE_RATE);
	assert.equal(view.getUint32(40, true), 10, "data chunk length");
	assert.equal(blob.size, WAV_HEADER_BYTES + 10);
});

test("pcm16Wav rejects empty, odd-length, and oversized captures", () => {
	assert.throws(() => pcm16Wav([]));
	assert.throws(() => pcm16Wav([new Uint8Array(3).buffer]));
	const huge = Math.ceil((MAX_DICTATION_WAV_BYTES - WAV_HEADER_BYTES + 1) / 2);
	assert.throws(() => pcm16Wav([new Uint8Array(huge * 2).buffer]));
});

test("pcm16Wav encodes the worklet's Int16Array VIEWS at full width — the live 400 regression", async () => {
	// The worklet posts Int16Array views (postMessage({buffer: this.frame},
	// [this.frame.buffer])), not ArrayBuffers. `new Uint8Array(view)` would
	// mint one byte per ELEMENT (half the audio, garbage values) and the
	// header would stop matching the body — the route's validWav rejects
	// exactly that ("Invalid or oversized dictation audio", 2026-11-02).
	const frames = [new Int16Array(2048), new Int16Array(2048)];
	const blob = pcm16Wav(frames);
	assert.equal(blob.size, WAV_HEADER_BYTES + 2048 * 2 * 2, "two full views → header + 8192 bytes");
	const view = new DataView(await blob.arrayBuffer());
	assert.equal(view.getUint32(4, true), blob.size - 8, "RIFF size matches the REAL body size");
	assert.equal(view.getUint32(40, true), 2048 * 2 * 2, "data chunk length matches the REAL body size");
});

test("a view-encoded WAV passes the route's validator and reaches Groq intact", async () => {
	let uploaded: File | null = null;
	const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
		uploaded = (init!.body as FormData).get("file") as File;
		return Response.json({ text: "view bytes" });
	};
	const wav = pcm16Wav([new Int16Array([0, 1, -1, 32767])]);
	const res = await transcribeGroqDictation(
		new Request("http://x", { method: "POST", body: wav, headers: { "Content-Type": "audio/wav" } }),
		deps({ fetchFn }),
	);
	assert.equal(res.status, 200, "validWav accepts the view-encoded WAV");
	assert.equal(uploaded!.size, WAV_HEADER_BYTES + 8);
});

test("whisperLanguageParam maps locales to ISO-639-1 and omits auto-detect", () => {
	assert.equal(whisperLanguageParam("multi"), undefined);
	assert.equal(whisperLanguageParam("en"), "en");
	assert.equal(whisperLanguageParam("en-US"), "en");
	assert.equal(whisperLanguageParam("pt-BR"), "pt");
	assert.equal(whisperLanguageParam("zh-Hans"), "zh");
});

test("the route refuses non-selected, keyless, and malformed uploads without reaching Groq", async () => {
	let upstreamCalls = 0;
	const fetchFn = async () => { upstreamCalls++; return Response.json({ text: "never" }); };
	assert.equal((await transcribeGroqDictation(wavRequest(), deps({ enabled: false, fetchFn }))).status, 403);
	assert.equal((await transcribeGroqDictation(wavRequest(), deps({ apiKey: undefined, fetchFn }))).status, 503);
	assert.equal(
		(await transcribeGroqDictation(new Request("http://x", { method: "POST", body: "not wav", headers: { "Content-Type": "text/plain" } }), deps({ fetchFn }))).status,
		415,
	);
	assert.equal(
		(await transcribeGroqDictation(new Request("http://x", { method: "POST", body: new Uint8Array(64).buffer, headers: { "Content-Type": "audio/wav" } }), deps({ fetchFn }))).status,
		400,
		"random bytes are not our WAV",
	);
	assert.equal(upstreamCalls, 0, "no request may leave for Groq");
});

test("the happy path uploads the WAV with model and language hint, returning sanitized text", async () => {
	let seen: { url: string; init: RequestInit } | undefined;
	const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
		seen = { url: String(url), init: init! };
		return Response.json({ text: "  Cześć świecie  " });
	};
	const res = await transcribeGroqDictation(wavRequest(), deps({ language: "pl", fetchFn }));
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { text: "  Cześć świecie  " }, "text passes through untrimmed — the client joins it");
	assert.equal(seen!.url, "https://api.groq.com/openai/v1/audio/transcriptions");
	const form = seen!.init.body as FormData;
	assert.equal(form.get("model"), "whisper-large-v3-turbo");
	assert.equal(form.get("language"), "pl");
	assert.equal((form.get("response_format") as string), "json");
	const file = form.get("file") as File;
	assert.equal(file.type, "audio/wav");
	assert.equal(file.size, sampleWav().size);
	const auth = (seen!.init.headers as Record<string, string>).Authorization;
	assert.equal(auth, "Bearer gsk_test");
});

test("the language hint is omitted on multi so Whisper auto-detects", async () => {
	let form: FormData | undefined;
	const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
		form = init!.body as FormData;
		return Response.json({ text: "hello" });
	};
	await transcribeGroqDictation(wavRequest(), deps({ language: "multi", fetchFn }));
	assert.equal(form!.get("language"), null);
});

test("a locale language collapses to its primary subtag", async () => {
	let form: FormData | undefined;
	const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
		form = init!.body as FormData;
		return Response.json({ text: "hello" });
	};
	await transcribeGroqDictation(wavRequest(), deps({ language: "pt-BR", fetchFn }));
	assert.equal(form!.get("language"), "pt");
});

test("upstream failures and malformed responses become owner-authored 502 lines", async () => {
	const res1 = await transcribeGroqDictation(wavRequest(), deps({ fetchFn: async () => Response.json({ error: "secret internal http://10.0.0.1 x" }, { status: 500 }) }));
	assert.equal(res1.status, 502);
	const body1 = await res1.json() as { message: string };
	assert.match(body1.message, /^Groq transcription failed \(500\)\.$/);
	assert.ok(!body1.message.includes("10.0.0.1"), "upstream bodies never leak");

	const res2 = await transcribeGroqDictation(wavRequest(), deps({ fetchFn: async () => Response.json({ unexpected: true }) }));
	assert.equal(res2.status, 502);
	assert.match((await res2.json() as { message: string }).message, /invalid transcription/);

	const res3 = await transcribeGroqDictation(wavRequest(), deps({ fetchFn: async () => { throw new Error("boom"); } }));
	assert.equal(res3.status, 502);
	assert.match((await res3.json() as { message: string }).message, /could not be completed/);
});

test("an oversized upload is rejected by the streaming read cap before parsing", async () => {
	const huge = new Uint8Array(MAX_DICTATION_WAV_BYTES + 1);
	const res = await transcribeGroqDictation(
		new Request("http://x", { method: "POST", body: huge, headers: { "Content-Type": "audio/wav" } }),
		deps({ fetchFn: async () => Response.json({ text: "never" }) }),
	);
	assert.equal(res.status, 400);
});
