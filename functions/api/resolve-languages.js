const TEXT_MODEL = "gemini-3.5-flash";

const SUPPORTED_LANGUAGES = [
  ["af", "Afrikaans"], ["ak", "Akan"], ["sq", "Albanian"], ["am", "Amharic"],
  ["ar", "Arabic"], ["hy", "Armenian"], ["az", "Azerbaijani"], ["eu", "Basque"],
  ["be", "Belarusian"], ["bn", "Bengali"], ["bg", "Bulgarian"], ["my", "Burmese"],
  ["ca", "Catalan"], ["zh-Hans", "Chinese Simplified / 简体中文"],
  ["zh-Hant", "Chinese Traditional / 繁體中文"], ["hr", "Croatian"], ["cs", "Czech"],
  ["da", "Danish"], ["nl", "Dutch"], ["en", "English"], ["et", "Estonian"],
  ["fil", "Filipino"], ["fi", "Finnish"], ["fr", "French"], ["gl", "Galician"],
  ["ka", "Georgian"], ["de", "German"], ["el", "Greek"], ["gu", "Gujarati"],
  ["ha", "Hausa"], ["he", "Hebrew"], ["hi", "Hindi"], ["hu", "Hungarian"],
  ["is", "Icelandic"], ["id", "Indonesian"], ["it", "Italian"], ["ja", "Japanese"],
  ["jv", "Javanese"], ["kn", "Kannada"], ["kk", "Kazakh"], ["km", "Khmer"],
  ["rw", "Kinyarwanda"], ["ko", "Korean"], ["lo", "Lao"], ["lv", "Latvian"],
  ["lt", "Lithuanian"], ["mk", "Macedonian"], ["ms", "Malay"], ["ml", "Malayalam"],
  ["mr", "Marathi"], ["mn", "Mongolian"], ["ne", "Nepali"], ["no", "Norwegian"],
  ["nb", "Norwegian Bokmål"], ["fa", "Persian"], ["pl", "Polish"],
  ["pt-BR", "Portuguese Brazil"], ["pt-PT", "Portuguese Portugal"], ["pa", "Punjabi"],
  ["ro", "Romanian"], ["ru", "Russian"], ["sr", "Serbian"], ["sd", "Sindhi"],
  ["si", "Sinhala"], ["sk", "Slovak"], ["sl", "Slovenian"], ["es", "Spanish"],
  ["su", "Sundanese"], ["sw", "Swahili"], ["sv", "Swedish"], ["ta", "Tamil"],
  ["te", "Telugu"], ["th", "Thai"], ["tr", "Turkish"], ["uk", "Ukrainian"],
  ["ur", "Urdu"], ["uz", "Uzbek"], ["vi", "Vietnamese"], ["zu", "Zulu"],
];

const SUPPORTED_CODES = new Set(SUPPORTED_LANGUAGES.map(([code]) => code));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function normalizeLanguages(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value
    .map((item) => ({
      code: String(item?.code || "").trim(),
      name: String(item?.name || "").trim(),
    }))
    .filter((item) => SUPPORTED_CODES.has(item.code))
    .filter((item) => {
      if (seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    })
    .slice(0, 2);
}

function buildPrompt(userText) {
  const supported = SUPPORTED_LANGUAGES.map(([code, name]) => `${code}: ${name}`).join("\n");
  return `You are a language setup parser for a real-time voice translator.

Task: infer exactly two spoken languages the two conversation participants want to use. The user may write in any language, for example "我说中文，对方说英文", "I'll speak Japanese and she speaks Korean", "translate between Spanish and Arabic".

Return only strict JSON with this shape:
{
  "languages": [{"code":"zh-Hans","name":"中文（简体）"},{"code":"en","name":"English"}],
  "question": "",
  "confidence": 0.0
}

Rules:
- Use only supported BCP-47 codes from the list below.
- Return exactly two distinct languages when the request is clear.
- Preserve the user's intended Chinese variant when explicit; default Chinese to zh-Hans.
- If fewer than two languages are clear, return {"languages":[],"question":"Ask a short clarification in the user's language","confidence":0}.
- Do not include markdown, comments, or extra keys.

Supported languages:
${supported}

User text: ${JSON.stringify(userText)}`;
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

  const text = String(body.text || "").trim().slice(0, 500);
  if (!text) return json({ error: "Missing text." }, 400);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(text) }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Gemini language resolver failed", response.status, errorText.slice(0, 300));
    return json({ error: "Failed to resolve languages." }, 502);
  }

  const data = await response.json();
  const textPart = data?.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text || "";

  let parsed;
  try {
    parsed = JSON.parse(textPart);
  } catch {
    return json({ error: "Language resolver returned invalid JSON." }, 502);
  }

  const languages = normalizeLanguages(parsed.languages);
  if (languages.length !== 2) {
    return json({
      languages: [],
      question: String(parsed.question || "请告诉我双方各自使用哪两种语言。"),
      confidence: 0,
    });
  }

  return json({
    languages,
    question: "",
    confidence: Number(parsed.confidence || 0.8),
  });
};

export const onRequest = () => json({ error: "Method not allowed." }, 405);
