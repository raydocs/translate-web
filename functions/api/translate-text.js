const TEXT_MODEL = "gemini-3.5-flash";

const SUPPORTED_TARGETS = new Map([
  ["zh-Hans", "Simplified Chinese (简体中文)"],
  ["zh-Hant", "Traditional Chinese (繁體中文)"],
  ["en", "English"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt-BR", "Brazilian Portuguese"],
  ["ru", "Russian"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["th", "Thai"],
  ["vi", "Vietnamese"],
  ["id", "Indonesian"],
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

function buildPrompt(text, targetName) {
  return `You are a professional translator. Translate the user text into ${targetName}.

Return only strict JSON:
{"translation":"...","sourceLanguageCode":"BCP-47 code of the detected source language"}

Rules:
- Preserve meaning, tone and register; keep numbers, names and formatting.
- If the text is already in the target language, return it unchanged as the translation.
- No markdown, no comments, no extra keys.

User text: ${JSON.stringify(text)}`;
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

  const text = String(body.text || "").trim().slice(0, 2000);
  const targetLanguageCode = String(body.targetLanguageCode || "").trim();
  if (!text) return json({ error: "Missing text." }, 400);
  if (!SUPPORTED_TARGETS.has(targetLanguageCode)) {
    return json({ error: "Unsupported targetLanguageCode." }, 400);
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(text, SUPPORTED_TARGETS.get(targetLanguageCode)) }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Gemini text translation failed", response.status, errorText.slice(0, 300));
    return json({ error: "Translation failed." }, 502);
  }

  const data = await response.json();
  const textPart = data?.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text || "";

  let parsed;
  try {
    parsed = JSON.parse(textPart);
  } catch {
    return json({ error: "Translator returned invalid JSON." }, 502);
  }

  const translation = String(parsed.translation || "").trim();
  if (!translation) return json({ error: "Empty translation." }, 502);

  return json({
    translation,
    sourceLanguageCode: String(parsed.sourceLanguageCode || "").trim(),
    targetLanguageCode,
  });
};

export const onRequest = () => json({ error: "Method not allowed." }, 405);
