/** Nova-3 monolingual language codes, including documented locale aliases.
 * Source: https://developers.deepgram.com/docs/models-languages-overview
 * Multilingual is a separate mode; its supported language set differs.
 */
const NOVA_3_LANGUAGES = [
	["Afrikaans", ["af", "af-ZA"]],
	["Arabic", ["ar", "ar-AE", "ar-SA", "ar-QA", "ar-KW", "ar-SY", "ar-LB", "ar-PS", "ar-JO", "ar-EG", "ar-SD", "ar-TD", "ar-MA", "ar-DZ", "ar-TN", "ar-IQ", "ar-IR"]],
	["Armenian", ["hy"]],
	["Assamese", ["as", "as-IN"]],
	["Belarusian", ["be"]],
	["Bengali", ["bn"]],
	["Bosnian", ["bs"]],
	["Bulgarian", ["bg"]],
	["Catalan", ["ca"]],
	["Chinese (Cantonese, Traditional)", ["zh-HK"]],
	["Chinese (Mandarin, Simplified)", ["zh", "zh-CN", "zh-Hans"]],
	["Chinese (Mandarin, Traditional)", ["zh-TW", "zh-Hant"]],
	["Croatian", ["hr"]],
	["Czech", ["cs", "cs-CZ"]],
	["Danish", ["da", "da-DK"]],
	["Dutch", ["nl"]],
	["English", ["en", "en-US", "en-AU", "en-GB", "en-IN", "en-NZ"]],
	["Estonian", ["et"]],
	["Finnish", ["fi"]],
	["Flemish", ["nl-BE"]],
	["French", ["fr", "fr-CA"]],
	["Georgian", ["ka", "ka-GE"]],
	["German", ["de"]],
	["German (Switzerland)", ["de-CH"]],
	["Greek", ["el"]],
	["Gujarati", ["gu", "gu-IN"]],
	["Hebrew", ["he"]],
	["Hindi", ["hi"]],
	["Hungarian", ["hu"]],
	["Indonesian", ["id"]],
	["Italian", ["it"]],
	["Japanese", ["ja"]],
	["Kannada", ["kn"]],
	["Kazakh", ["kk", "kk-KZ"]],
	["Korean", ["ko", "ko-KR"]],
	["Latvian", ["lv"]],
	["Lithuanian", ["lt"]],
	["Macedonian", ["mk"]],
	["Malay", ["ms"]],
	["Marathi", ["mr"]],
	["Mongolian", ["mn"]],
	["Nepali", ["ne"]],
	["Norwegian", ["no"]],
	["Pashto", ["ps", "ps-AF"]],
	["Persian", ["fa"]],
	["Polish", ["pl"]],
	["Portuguese", ["pt", "pt-BR", "pt-PT"]],
	["Punjabi", ["pa", "pa-IN"]],
	["Romanian", ["ro"]],
	["Russian", ["ru"]],
	["Serbian", ["sr"]],
	["Slovak", ["sk"]],
	["Slovenian", ["sl"]],
	["Spanish", ["es", "es-419"]],
	["Swedish", ["sv", "sv-SE"]],
	["Tagalog", ["tl"]],
	["Tamil", ["ta"]],
	["Telugu", ["te"]],
	["Thai", ["th", "th-TH"]],
	["Turkish", ["tr", "tr-TR"]],
	["Ukrainian", ["uk"]],
	["Urdu", ["ur"]],
	["Vietnamese", ["vi"]],
] as const;

export type DictationLanguage = "multi" | (typeof NOVA_3_LANGUAGES)[number][1][number];

/** The dictation engine. "deepgram" streams over its WebSocket; "groq"
 *  batches the whole run's audio through /api/stt/groq at stop (Groq has
 *  no streaming STT endpoint — and the deferred-transcript UX never
 *  needed one). */
export type DictationProvider = "deepgram" | "groq";

export const DICTATION_PROVIDERS = ["deepgram", "groq"] as const;

export function isDictationProvider(value: unknown): value is DictationProvider {
	return value === "deepgram" || value === "groq";
}

export const DICTATION_LANGUAGES: readonly { code: DictationLanguage; label: string }[] = [
	{ code: "multi", label: "Multilingual" },
	...NOVA_3_LANGUAGES.flatMap(([name, codes]) =>
		codes.map((code, i) => ({ code, label: i === 0 ? name : `${name} (${code})` })),
	).sort((a, b) => a.label.localeCompare(b.label, "en")),
];

export function isDictationLanguage(value: unknown): value is DictationLanguage {
	return DICTATION_LANGUAGES.some(({ code }) => code === value);
}

/** Map a UI language preference onto Whisper's `language` form field
 *  (ISO-639-1 — Groq docs). "multi" means auto-detect: the field is
 *  OMITTED (passing an empty string is an upstream error). Locale codes
 *  collapse to their primary subtag ("en-US" → "en", "zh-Hans" → "zh")
 *  — Whisper has no locale concept. Unknown shapes drop the field.
 *  Auto-detect misfires on short clips (groq-stt CLI experience), so a
 *  concrete hint beats omission whenever we have one. */
export function whisperLanguageParam(language: DictationLanguage): string | undefined {
	if (language === "multi") return undefined;
	const primary = (language.split("-")[0] ?? "").toLowerCase();
	return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

/** WAV wire format for the batch engines: mono signed PCM16 at the
 *  capture rate — exactly what public/worklets/pcm-capture.js emits.
 *  24 MB of WAV ≈ 25 min at 16 kHz; the cap sits under the strictest
 *  provider upload limit (Groq free tier 25 MB). */
export const DICTATION_SAMPLE_RATE = 16_000;
export const WAV_HEADER_BYTES = 44;
export const MAX_DICTATION_WAV_BYTES = 24_000_000;
/** Accumulation ceiling for raw PCM frames: the WAV cap minus header,
 *  minus slack for the trailing partial frame flushed after stop. */
export const MAX_DICTATION_PCM_BYTES = MAX_DICTATION_WAV_BYTES - WAV_HEADER_BYTES - 320_000;

/** One captured PCM chunk. The worklet posts Int16Array VIEWS (its
 *  `this.frame`, buffer transferred); tests and future callers may hand raw
 *  ArrayBuffers. Both are accepted — see pcm16Wav. */
export type PcmFrame = ArrayBuffer | ArrayBufferView<ArrayBuffer>;

/** Encode accumulated mono PCM16 capture chunks as a WAV Blob without
 *  touching disk. Accepts the worklet's Int16Array views OR raw ArrayBuffers
 *  — a view is copied via (buffer, byteOffset, byteLength), NEVER via
 *  `new Uint8Array(view)` (that array-like constructor mints one byte per
 *  ELEMENT, halving the audio and desynchronizing the header — the live
 *  "Invalid or oversized dictation audio" bug, 2026-11-02). Throws on
 *  empty/odd/oversized input — callers surface the message verbatim. */
export function pcm16Wav(frames: readonly PcmFrame[]): Blob {
	const dataBytes = frames.reduce((size, frame) => size + frame.byteLength, 0);
	if (dataBytes === 0 || dataBytes % 2 !== 0 || dataBytes + WAV_HEADER_BYTES > MAX_DICTATION_WAV_BYTES) {
		throw new Error("Invalid or oversized dictation audio");
	}
	const header = new ArrayBuffer(WAV_HEADER_BYTES);
	const view = new DataView(header);
	const write = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	write(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); write(8, "WAVE");
	write(12, "fmt "); view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, DICTATION_SAMPLE_RATE, true);
	view.setUint32(28, DICTATION_SAMPLE_RATE * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	write(36, "data"); view.setUint32(40, dataBytes, true);
	return new Blob(
		[header, ...frames.map((frame) =>
			frame instanceof ArrayBuffer
				? new Uint8Array(frame)
				: new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
		)],
		{ type: "audio/wav" },
	);
}

/** Only language varies. Keep the owner's tuned streaming parameters. */
export function deepgramListenUrl(language: DictationLanguage): string {
	return "wss://api.deepgram.com/v1/listen" +
		"?model=nova-3&encoding=linear16&sample_rate=16000&channels=1" +
		"&smart_format=true&punctuate=true&endpointing=300" +
		`&language=${encodeURIComponent(language)}`;
}
