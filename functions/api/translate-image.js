const TEXT_MODEL = "gemini-3.5-flash";
const MAX_IMAGE_BASE64 = 3_500_000; // ~2.6MB binary, plenty after client resize

const LANGUAGE_NAMES = new Map([
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
  ["ms", "Malay"],
  ["tr", "Turkish"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
  ["sv", "Swedish"],
  ["uk", "Ukrainian"],
  ["el", "Greek"],
  ["cs", "Czech"],
  ["ro", "Romanian"],
  ["hu", "Hungarian"],
  ["da", "Danish"],
  ["fi", "Finnish"],
  ["no", "Norwegian"],
  ["he", "Hebrew"],
  ["fil", "Filipino"],
  ["km", "Khmer"],
]);

// The flash model occasionally sheds load with 503/429; one short retry
// absorbs most transient spikes.
async function fetchWithRetry(url, init) {
  const first = await fetch(url, init);
  if (first.status !== 503 && first.status !== 429) return first;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return fetch(url, init);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function buildPrompt(primaryName, counterpartName) {
  return `You are a translator looking at a photo (menu, sign, document, screen, etc.).

1. Extract the meaningful text from the image, in reading order. Ignore watermarks and decorative fragments.
2. If the extracted text is mostly in ${primaryName}, translate it into ${counterpartName}. Otherwise translate it into ${primaryName}.

Return only strict JSON:
{"originalText":"...","translation":"...","sourceLanguageCode":"BCP-47","targetLanguageCode":"BCP-47"}

Rules:
- Keep line breaks between distinct items (menu dishes, sign lines).
- Keep numbers, prices and units exactly as written.
- If there is no readable text, return {"originalText":"","translation":"","sourceLanguageCode":"","targetLanguageCode":""}.
- No markdown, no extra keys.`;
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

  const imageBase64 = String(body.imageBase64 || "");
  const mimeType = String(body.mimeType || "image/jpeg");
  const primaryCode = String(body.primaryLanguageCode || "zh-Hans");
  const counterpartCode = String(body.counterpartLanguageCode || "en");

  if (!imageBase64) return json({ error: "Missing imageBase64." }, 400);
  if (imageBase64.length > MAX_IMAGE_BASE64) return json({ error: "Image too large." }, 413);

  const primaryName = LANGUAGE_NAMES.get(primaryCode) || "Simplified Chinese (简体中文)";
  const counterpartName = LANGUAGE_NAMES.get(counterpartCode) || "English";

  const response = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mimeType, data: imageBase64 } },
              { text: buildPrompt(primaryName, counterpartName) },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Gemini image translation failed", response.status, errorText.slice(0, 300));
    return json({ error: "Image translation failed." }, 502);
  }

  const data = await response.json();
  const textPart = data?.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text || "";

  let parsed;
  try {
    parsed = JSON.parse(textPart);
  } catch {
    return json({ error: "Translator returned invalid JSON." }, 502);
  }

  return json({
    originalText: String(parsed.originalText || "").trim(),
    translation: String(parsed.translation || "").trim(),
    sourceLanguageCode: String(parsed.sourceLanguageCode || "").trim(),
    targetLanguageCode: String(parsed.targetLanguageCode || "").trim(),
  });
};

export const onRequest = () => json({ error: "Method not allowed." }, 405);
