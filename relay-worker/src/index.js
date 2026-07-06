import { GoogleGenAI } from "@google/genai";

const LIVE_MODEL = "gemini-3.5-live-translate-preview";
const WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
const WS_FETCH_URL = WS_URL.replace("wss://", "https://");

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
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

async function createLiveToken(apiKey, targetLanguageCode) {
  const now = Date.now();
  const expireTime = new Date(now + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(now + 60 * 1000).toISOString();
  const client = new GoogleGenAI({ apiKey });

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

// Durable Object pinned (via locationHint at creation) to North America so
// every Gemini call originates from a region Google supports, regardless of
// which edge colo the end user hit.
export class GeminiRelay {
  constructor(ctx) {
    this.ctx = ctx;
  }

  // Keep the isolate warm while the app is in active use; go back to sleep
  // after a day of inactivity so an abandoned deployment costs nothing.
  async alarm() {
    const lastUsed = (await this.ctx.storage.get("lastUsed")) || 0;
    if (Date.now() - lastUsed < 24 * 60 * 60 * 1000) {
      await this.ctx.storage.setAlarm(Date.now() + 4 * 60 * 1000);
    }
  }

  async fetch(request) {
    this.ctx.storage.put("lastUsed", Date.now()).catch(() => {});
    this.ctx.storage
      .getAlarm()
      .then((current) => {
        if (current === null) return this.ctx.storage.setAlarm(Date.now() + 4 * 60 * 1000);
        return null;
      })
      .catch(() => {});

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "Expected WebSocket upgrade." }, 426);
    }

    const apiKey = request.headers.get("X-Goog-Key") || "";
    if (!apiKey) return json({ error: "Missing upstream credentials." }, 500);

    const url = new URL(request.url);
    const targetLanguageCode = String(url.searchParams.get("targetLanguageCode") || "").trim();
    if (!targetLanguageCode) return json({ error: "Missing targetLanguageCode." }, 400);

    let token;
    try {
      token = await createLiveToken(apiKey, targetLanguageCode);
    } catch (error) {
      console.error("Relay token creation failed", error?.message || error);
      return json({ error: "Failed to create live translation token." }, 502);
    }

    let upstreamSocket;
    try {
      upstreamSocket = await connectUpstreamSocket(token);
    } catch (error) {
      console.error("Relay upstream connect failed", error?.message || error);
      return json({ error: "Failed to connect live translation channel." }, 502);
    }

    const pair = new WebSocketPair();
    const [clientSocket, serverSocket] = Object.values(pair);
    bridgeGeminiSocket(serverSocket, upstreamSocket, targetLanguageCode);

    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
    });
  }
}

export default {
  fetch() {
    return new Response("gemini-us-relay", { status: 200 });
  },
};
