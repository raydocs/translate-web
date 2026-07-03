import { GoogleGenAI } from "@google/genai";

const LIVE_MODEL = "gemini-3.5-live-translate-preview";

const SUPPORTED_LANGUAGE_CODES = new Set([
  "af", "ak", "sq", "am", "ar", "hy", "az", "eu", "be", "bn", "bg", "my",
  "ca", "zh-Hans", "zh-Hant", "hr", "cs", "da", "nl", "en", "et", "fil",
  "fi", "fr", "gl", "ka", "de", "el", "gu", "ha", "he", "hi", "hu", "is",
  "id", "it", "ja", "jv", "kn", "kk", "km", "rw", "ko", "lo", "lv", "lt",
  "mk", "ms", "ml", "mr", "mn", "ne", "no", "nb", "fa", "pl", "pt-BR",
  "pt-PT", "pa", "ro", "ru", "sr", "sd", "si", "sk", "sl", "es", "su", "sw",
  "sv", "ta", "te", "th", "tr", "uk", "ur", "uz", "vi", "zu",
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export const onRequestPost = async ({ request, env }) => {
  if (!env.GEMINI_API_KEY) {
    return json({ error: "GEMINI_API_KEY secret is not configured." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected JSON body." }, 400);
  }

  const targetLanguageCode = String(body.targetLanguageCode || "").trim();
  const echoTargetLanguage = body.echoTargetLanguage === true;

  if (!SUPPORTED_LANGUAGE_CODES.has(targetLanguageCode)) {
    return json({ error: "Unsupported targetLanguageCode." }, 400);
  }

  const now = Date.now();
  const expireTime = new Date(now + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(now + 60 * 1000).toISOString();

  try {
    const client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime,
        newSessionExpireTime,
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: {
            responseModalities: ["AUDIO"],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            translationConfig: {
              targetLanguageCode,
              echoTargetLanguage,
            },
          },
        },
        httpOptions: {
          apiVersion: "v1alpha",
        },
      },
    });

    return json({
      token: token.name,
      expiresAt: expireTime,
      model: LIVE_MODEL,
      targetLanguageCode,
      echoTargetLanguage,
    });
  } catch (error) {
    console.error("Failed to create Gemini Live ephemeral token", error?.message || error);
    return json({ error: "Failed to create live translation token." }, 502);
  }
};

export const onRequest = () => json({ error: "Method not allowed." }, 405);
