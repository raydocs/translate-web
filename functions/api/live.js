import { GoogleGenAI } from "@google/genai";

const LIVE_MODEL = "gemini-3.5-live-translate-preview";
const WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
const WS_FETCH_URL = WS_URL.replace("wss://", "https://");

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

async function createLiveToken(env, targetLanguageCode) {
  const now = Date.now();
  const expireTime = new Date(now + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(now + 60 * 1000).toISOString();
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
            echoTargetLanguage: false,
          },
        },
      },
      httpOptions: {
        apiVersion: "v1alpha",
      },
    },
  });

  return token.name;
}

function safeClose(socket, code = 1011, reason = "closed") {
  try {
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason.slice(0, 80));
    }
  } catch {
    // Ignore close races.
  }
}

function sendJson(socket, data) {
  try {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
  } catch {
    // Ignore send races.
  }
}

async function connectUpstreamSocket(token) {
  const response = await fetch(`${WS_FETCH_URL}?access_token=${encodeURIComponent(token)}`, {
    headers: {
      Upgrade: "websocket",
    },
  });

  if (!response.webSocket) {
    throw new Error(`Gemini websocket rejected: ${response.status}`);
  }

  response.webSocket.accept({ allowHalfOpen: true });
  return response.webSocket;
}

function bridgeGeminiSocket(clientSocket, upstreamSocket, targetLanguageCode) {
  clientSocket.accept({ allowHalfOpen: true });

  const closeBoth = (code = 1011, reason = "live closed") => {
    safeClose(clientSocket, code, reason);
    safeClose(upstreamSocket, code, reason);
  };

  clientSocket.addEventListener("message", (event) => {
    try {
      upstreamSocket.send(event.data);
    } catch {
      sendJson(clientSocket, { error: { message: `${targetLanguageCode} 通道连接错误` } });
      closeBoth(1011, "upstream send error");
    }
  });

  clientSocket.addEventListener("close", () => safeClose(upstreamSocket, 1000, "client closed"));
  clientSocket.addEventListener("error", () => safeClose(upstreamSocket, 1011, "client error"));

  upstreamSocket.addEventListener("message", async (event) => {
    try {
      let data = event.data;
      if (data instanceof Blob) data = await data.text();
      if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
      if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(data);
    } catch {
      safeClose(upstreamSocket, 1011, "client send error");
    }
  });

  upstreamSocket.addEventListener("close", (event) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(event.code || 1011, event.reason || "gemini closed");
    }
  });

  upstreamSocket.addEventListener("error", () => {
    sendJson(clientSocket, { error: { message: `${targetLanguageCode} 通道连接错误` } });
    closeBoth(1011, "upstream error");
  });
}

export const onRequest = async ({ request, env }) => {
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);

  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade.", {
      status: 426,
      headers: { Upgrade: "websocket" },
    });
  }

  if (!env.GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY secret is not configured." }, 500);

  const url = new URL(request.url);
  const targetLanguageCode = String(url.searchParams.get("targetLanguageCode") || "").trim();
  if (!SUPPORTED_LANGUAGE_CODES.has(targetLanguageCode)) {
    return json({ error: "Unsupported targetLanguageCode." }, 400);
  }

  // Route Gemini traffic through a Durable Object pinned to North America:
  // Google rejects API calls originating from unsupported regions (e.g. the
  // Hong Kong colo that serves mainland-China visitors), so the upstream hop
  // must happen from a supported location regardless of the user's colo.
  if (env.GEMINI_RELAY) {
    try {
      const id = env.GEMINI_RELAY.idFromName("us-relay-v1");
      const stub = env.GEMINI_RELAY.get(id, { locationHint: "wnam" });
      const relayRequest = new Request(request.url, {
        headers: {
          Upgrade: "websocket",
          "X-Goog-Key": env.GEMINI_API_KEY,
        },
      });
      return await stub.fetch(relayRequest);
    } catch (error) {
      console.error("US relay failed, falling back to direct connect", error?.message || error);
    }
  }

  let token;
  try {
    token = await createLiveToken(env, targetLanguageCode);
  } catch (error) {
    console.error("Failed to create Gemini Live proxy token", error?.message || error);
    return json({ error: "Failed to create live translation token." }, 502);
  }

  let upstreamSocket;
  try {
    upstreamSocket = await connectUpstreamSocket(token);
  } catch (error) {
    console.error("Failed to connect Gemini Live upstream websocket", error?.message || error);
    return json({ error: "Failed to connect live translation channel." }, 502);
  }

  const pair = new WebSocketPair();
  const [clientSocket, serverSocket] = Object.values(pair);
  bridgeGeminiSocket(serverSocket, upstreamSocket, targetLanguageCode);

  return new Response(null, {
    status: 101,
    webSocket: clientSocket,
  });
};
