import assert from "node:assert/strict";
import { test } from "node:test";
import { isDictationProvider } from "../src/core/dictation.ts";
import {
	FACTORY_SETTINGS, sanitizeUserSettings,
} from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";

test("isDictationProvider accepts only the two engines", () => {
	assert.equal(isDictationProvider("deepgram"), true);
	assert.equal(isDictationProvider("groq"), true);
	assert.equal(isDictationProvider("openai"), false);
	assert.equal(isDictationProvider(undefined), false);
	assert.equal(isDictationProvider(""), false);
});

test("the dictation settings parser accepts the provider field and rejects unknown engines", () => {
	assert.deepEqual(parseDictationSettingsBody({ language: "en", provider: "groq" }), { ok: true, settings: { language: "en", provider: "groq" } });
	assert.deepEqual(parseDictationSettingsBody({ provider: "deepgram" }), { ok: true, settings: { provider: "deepgram" } });
	assert.deepEqual(parseDictationSettingsBody({}), { ok: true, settings: {} });
	assert.equal(parseDictationSettingsBody({ provider: "openai" }).ok, false);
	assert.equal(parseDictationSettingsBody({ language: "xx-XX" }).ok, false);
	assert.equal(parseDictationSettingsBody(null).ok, false);
});

test("sanitize keeps a valid provider, drops an invalid one, and never invents one", () => {
	const kept = sanitizeUserSettings({ version: 1, dictation: { language: "it", provider: "groq" } });
	assert.deepEqual(kept?.dictation, { language: "it", provider: "groq" });
	const dropped = sanitizeUserSettings({ version: 1, dictation: { language: "it", provider: "elevenlabs" } });
	assert.deepEqual(dropped?.dictation, { language: "it" }, "unknown engine drops, language survives");
	const noLang = sanitizeUserSettings({ version: 1, dictation: { provider: "groq" } });
	assert.deepEqual(noLang?.dictation, {}, "provider without a valid language drops (the old gate stays)");
});

test("resolution falls back to the factory engine (deepgram) — existing records upgrade silently", () => {
	assert.equal(resolveSettings(null).dictation.provider, FACTORY_SETTINGS.dictation.provider);
	assert.equal(
		resolveSettings(sanitizeUserSettings({ version: 1, dictation: { language: "en" } })).dictation.provider,
		"deepgram",
	);
	assert.equal(
		resolveSettings(sanitizeUserSettings({ version: 1, dictation: { language: "en", provider: "groq" } })).dictation.provider,
		"groq",
	);
});
