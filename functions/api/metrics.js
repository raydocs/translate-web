const MAX_EVENTS_PER_POST = 25;
const MAX_DETAILS_CHARS = 4800;
const MAX_USER_AGENT_CHARS = 220;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function sanitizeString(value, max = 160) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sanitizeSessionId(value) {
  const sessionId = sanitizeString(value, 80);
  return /^[a-zA-Z0-9._:-]{8,80}$/.test(sessionId) ? sessionId : crypto.randomUUID();
}

function toInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number);
}

function getCountry(request) {
  return sanitizeString(request.cf?.country || request.headers.get("cf-ipcountry") || "", 8) || null;
}

function getUserAgent(request) {
  return sanitizeString(request.headers.get("user-agent"), MAX_USER_AGENT_CHARS);
}

function parseBrowser(userAgent) {
  const ua = userAgent || "";
  if (/MicroMessenger/i.test(ua)) return "WeChat";
  if (/FBAN|FBAV|Instagram|Line\//i.test(ua)) return "In-app";
  if (/Edg\//i.test(ua)) return "Edge";
  if (/CriOS|Chrome\//i.test(ua)) return "Chrome";
  if (/FxiOS|Firefox\//i.test(ua)) return "Firefox";
  if (/Version\/.*Safari/i.test(ua)) return "Safari";
  if (/Safari/i.test(ua)) return "Safari";
  return "Other";
}

function parseDevice(userAgent) {
  const ua = userAgent || "";
  if (/iPad|Tablet|Pad|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|Android/i.test(ua)) return "mobile";
  return "desktop";
}

function normalizeLanguage(value) {
  const code = sanitizeString(value, 16);
  return code || null;
}

function scrubDetails(value) {
  const blocked = new Set([
    "apiKey",
    "authorization",
    "base64Audio",
    "data",
    "jwt",
    "key",
    "password",
    "pcm",
    "secret",
    "text",
    "token",
    "transcript",
  ]);

  const visit = (item, depth = 0) => {
    if (depth > 4) return undefined;
    if (item === null || item === undefined) return item;
    if (["string", "number", "boolean"].includes(typeof item)) {
      return typeof item === "string" ? sanitizeString(item, 240) : item;
    }
    if (Array.isArray(item)) return item.slice(0, 16).map((child) => visit(child, depth + 1));
    if (typeof item !== "object") return undefined;

    const output = {};
    for (const [key, child] of Object.entries(item)) {
      if (blocked.has(key) || /token|secret|key|audio|text|transcript/i.test(key)) continue;
      const cleaned = visit(child, depth + 1);
      if (cleaned !== undefined) output[sanitizeString(key, 64)] = cleaned;
    }
    return output;
  };

  const jsonText = JSON.stringify(visit(value) || {});
  return jsonText.length > MAX_DETAILS_CHARS ? jsonText.slice(0, MAX_DETAILS_CHARS) : jsonText;
}

function normalizeEvent(rawEvent, request, now) {
  const event = rawEvent && typeof rawEvent === "object" ? rawEvent : {};
  const data = event.data && typeof event.data === "object" ? event.data : event;
  const userAgent = getUserAgent(request);

  return {
    createdAt: new Date(now).toISOString(),
    createdAtMs: now,
    sessionId: sanitizeSessionId(event.sessionId || data.sessionId),
    eventType: sanitizeString(event.type || data.type || "event", 64) || "event",
    sourceLanguage: normalizeLanguage(data.sourceLanguage || data.sourceLanguageCode || data.primaryLanguage || data.activeSourceCode),
    targetLanguage: normalizeLanguage(data.targetLanguage || data.targetLanguageCode || data.counterpartLanguage || data.activeTargetCode),
    durationMs: toInteger(data.durationMs),
    latencyMs: toInteger(data.latencyMs),
    inputEvents: toInteger(data.inputEvents),
    outputEvents: toInteger(data.outputEvents),
    audioMs: toInteger(data.audioMs || data.audioOutputMs),
    voiceChunks: toInteger(data.voiceChunks),
    errorMessage: sanitizeString(data.errorMessage || data.message || data.error, 260) || null,
    device: sanitizeString(data.device || parseDevice(userAgent), 32),
    browser: sanitizeString(data.browser || parseBrowser(userAgent), 32),
    country: getCountry(request),
    detailsJson: scrubDetails({ ...data, userAgent }),
  };
}

function getAdminToken(request) {
  const auth = request.headers.get("authorization") || "";
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return request.headers.get("x-admin-token") || new URL(request.url).searchParams.get("token") || "";
}

function isAdminRequest(request, env) {
  const configured = String(env.ADMIN_TOKEN || "");
  const provided = String(getAdminToken(request) || "");
  return Boolean(configured && provided && configured.length === provided.length && configured === provided);
}

function assertDatabase(env) {
  if (!env.METRICS_DB) throw new Error("METRICS_DB binding is not configured.");
  return env.METRICS_DB;
}

async function queryFirst(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

async function queryAll(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all();
  return result.results || [];
}

function normalizeMetricRow(row) {
  return Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [key, typeof value === "bigint" ? Number(value) : value]),
  );
}

export const onRequestPost = async ({ request, env }) => {
  let events;
  try {
    const body = await request.json();
    events = Array.isArray(body) ? body : Array.isArray(body.events) ? body.events : [body];
  } catch {
    return json({ error: "Expected JSON body." }, 400);
  }

  const db = env.METRICS_DB;
  if (!db) return json({ ok: true, stored: 0, disabled: true }, 202);

  const now = Date.now();
  const rows = events.slice(0, MAX_EVENTS_PER_POST).map((event) => normalizeEvent(event, request, now));
  if (!rows.length) return json({ ok: true, stored: 0 });

  try {
    await db.batch(
      rows.map((row) =>
        db
          .prepare(`
            INSERT INTO metric_events (
              created_at, created_at_ms, session_id, event_type, source_language, target_language,
              duration_ms, latency_ms, input_events, output_events, audio_ms, voice_chunks,
              error_message, device, browser, country, details_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            row.createdAt,
            row.createdAtMs,
            row.sessionId,
            row.eventType,
            row.sourceLanguage,
            row.targetLanguage,
            row.durationMs,
            row.latencyMs,
            row.inputEvents,
            row.outputEvents,
            row.audioMs,
            row.voiceChunks,
            row.errorMessage,
            row.device,
            row.browser,
            row.country,
            row.detailsJson,
          ),
      ),
    );
  } catch (error) {
    console.error("Metrics ingest failed", error?.message || error);
    return json({ error: "Metrics ingest failed." }, 500);
  }

  return json({ ok: true, stored: rows.length });
};

export const onRequestGet = async ({ request, env }) => {
  if (!env.ADMIN_TOKEN) return json({ error: "ADMIN_TOKEN is not configured." }, 503);
  if (!isAdminRequest(request, env)) return json({ error: "Unauthorized." }, 401);

  let db;
  try {
    db = assertDatabase(env);
  } catch (error) {
    return json({ error: error.message }, 503);
  }

  const url = new URL(request.url);
  const days = Math.max(1, Math.min(30, Number.parseInt(url.searchParams.get("days") || "7", 10) || 7));
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const rangeStart = now - days * 24 * 60 * 60 * 1000;
  const chartStart = now - 14 * 24 * 60 * 60 * 1000;

  try {
    const [last24h, range, daily, languagePairs, devices, browsers, recentErrors, recentSessions, featureUsage, closeReasons] = await Promise.all([
      queryFirst(
        db,
        `
          SELECT
            COUNT(DISTINCT CASE WHEN event_type = 'session_start' THEN session_id END) AS sessions,
            COUNT(DISTINCT session_id) AS unique_sessions,
            COALESCE(SUM(CASE WHEN event_type = 'session_end' THEN duration_ms ELSE 0 END), 0) AS duration_ms,
            COALESCE(SUM(CASE WHEN event_type = 'session_end' THEN input_events ELSE 0 END), 0) AS input_events,
            COALESCE(SUM(CASE WHEN event_type = 'session_end' THEN output_events ELSE 0 END), 0) AS output_events,
            COALESCE(SUM(CASE WHEN event_type = 'session_end' THEN audio_ms ELSE 0 END), 0) AS audio_ms,
            COALESCE(AVG(CASE WHEN event_type = 'first_audio' THEN latency_ms END), 0) AS avg_first_audio_ms,
            COUNT(CASE WHEN event_type = 'error' THEN 1 END) AS errors
          FROM metric_events
          WHERE created_at_ms >= ?
        `,
        dayAgo,
      ),
      queryFirst(
        db,
        `
          SELECT
            COUNT(DISTINCT CASE WHEN event_type = 'session_start' THEN session_id END) AS sessions,
            COUNT(DISTINCT session_id) AS unique_sessions,
            COALESCE(SUM(CASE WHEN event_type = 'session_end' THEN duration_ms ELSE 0 END), 0) AS duration_ms,
            COALESCE(SUM(CASE WHEN event_type = 'session_end' THEN input_events ELSE 0 END), 0) AS input_events,
            COALESCE(SUM(CASE WHEN event_type = 'session_end' THEN output_events ELSE 0 END), 0) AS output_events,
            COALESCE(SUM(CASE WHEN event_type = 'session_end' THEN audio_ms ELSE 0 END), 0) AS audio_ms,
            COALESCE(AVG(CASE WHEN event_type = 'first_audio' THEN latency_ms END), 0) AS avg_first_audio_ms,
            COUNT(CASE WHEN event_type = 'error' THEN 1 END) AS errors
          FROM metric_events
          WHERE created_at_ms >= ?
        `,
        rangeStart,
      ),
      queryAll(
        db,
        `
          SELECT
            substr(created_at, 1, 10) AS day,
            COUNT(DISTINCT CASE WHEN event_type = 'session_start' THEN session_id END) AS sessions,
            COALESCE(SUM(CASE WHEN event_type = 'session_end' THEN duration_ms ELSE 0 END), 0) AS duration_ms,
            COUNT(CASE WHEN event_type = 'error' THEN 1 END) AS errors
          FROM metric_events
          WHERE created_at_ms >= ? AND event_type IN ('session_start', 'session_end', 'error')
          GROUP BY day
          ORDER BY day ASC
        `,
        chartStart,
      ),
      queryAll(
        db,
        `
          SELECT
            COALESCE(source_language, 'auto') AS source_language,
            COALESCE(target_language, 'auto') AS target_language,
            COUNT(DISTINCT session_id) AS sessions,
            COALESCE(AVG(CASE WHEN event_type = 'first_audio' THEN latency_ms END), 0) AS avg_first_audio_ms
          FROM metric_events
          WHERE created_at_ms >= ? AND event_type IN ('session_start', 'session_end', 'first_audio')
          GROUP BY source_language, target_language
          ORDER BY sessions DESC
          LIMIT 12
        `,
        rangeStart,
      ),
      queryAll(
        db,
        `
          SELECT COALESCE(device, 'unknown') AS device, COUNT(DISTINCT session_id) AS sessions
          FROM metric_events
          WHERE created_at_ms >= ? AND event_type = 'session_start'
          GROUP BY device
          ORDER BY sessions DESC
        `,
        rangeStart,
      ),
      queryAll(
        db,
        `
          SELECT COALESCE(browser, 'unknown') AS browser, COUNT(DISTINCT session_id) AS sessions
          FROM metric_events
          WHERE created_at_ms >= ? AND event_type = 'session_start'
          GROUP BY browser
          ORDER BY sessions DESC
          LIMIT 8
        `,
        rangeStart,
      ),
      queryAll(
        db,
        `
          SELECT created_at, error_message, device, browser, country, source_language, target_language
          FROM metric_events
          WHERE event_type = 'error'
          ORDER BY created_at_ms DESC
          LIMIT 24
        `,
      ),
      queryAll(
        db,
        `
          SELECT created_at, session_id, source_language, target_language, duration_ms, input_events, output_events, audio_ms, voice_chunks, device, browser, country
          FROM metric_events
          WHERE event_type = 'session_end'
          ORDER BY created_at_ms DESC
          LIMIT 24
        `,
      ),
      queryAll(
        db,
        `
          SELECT event_type, COUNT(*) AS n
          FROM metric_events
          WHERE created_at_ms >= ? AND event_type IN ('correction', 'typed_translate', 'photo_translate', 'reconnect', 'session_rotate', 'channel_closed')
          GROUP BY event_type
          ORDER BY n DESC
        `,
        rangeStart,
      ),
      queryAll(
        db,
        `
          SELECT COALESCE(NULLIF(json_extract(details_json, '$.closeReason'), ''), '(网络中断/无原因)') AS reason, COUNT(*) AS n
          FROM metric_events
          WHERE event_type = 'channel_closed' AND created_at_ms >= ?
          GROUP BY reason
          ORDER BY n DESC
          LIMIT 8
        `,
        rangeStart,
      ),
    ]);

    return json({
      generatedAt: new Date(now).toISOString(),
      days,
      last24h: normalizeMetricRow(last24h),
      range: normalizeMetricRow(range),
      daily: daily.map(normalizeMetricRow),
      languagePairs: languagePairs.map(normalizeMetricRow),
      devices: devices.map(normalizeMetricRow),
      browsers: browsers.map(normalizeMetricRow),
      recentErrors: recentErrors.map(normalizeMetricRow),
      recentSessions: recentSessions.map(normalizeMetricRow),
      featureUsage: featureUsage.map(normalizeMetricRow),
      closeReasons: closeReasons.map(normalizeMetricRow),
    });
  } catch (error) {
    console.error("Metrics query failed", error?.message || error);
    return json({ error: "Metrics query failed." }, 500);
  }
};

export const onRequest = () => json({ error: "Method not allowed." }, 405);
