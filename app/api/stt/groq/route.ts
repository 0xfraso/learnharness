/**
 * Groq batch dictation route — the thin seam (see src/server/groq-dictation.ts
 * for the trust shape). GET is the presence probe: the client checks key
 * availability BEFORE a run so a keyless Groq selection fails on the click,
 * not after the user has dictated a paragraph. It exposes only presence —
 * no key material, no masked tail.
 */
import { effectiveSettings, keyValue, transcribeGroqDictation } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(
		{ present: keyValue("GROQ_API_KEY") !== undefined },
		{ headers: { "Cache-Control": "no-store" } },
	);
}

export async function POST(request: Request) {
	return transcribeGroqDictation(request, {
		apiKey: keyValue("GROQ_API_KEY"),
		enabled: effectiveSettings().dictation.provider === "groq",
		language: effectiveSettings().dictation.language,
	});
}
