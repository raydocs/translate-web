const elements = {
  authPanel: document.querySelector("#authPanel"),
  tokenInput: document.querySelector("#tokenInput"),
  saveTokenBtn: document.querySelector("#saveTokenBtn"),
  errorPanel: document.querySelector("#errorPanel"),
  dashboard: document.querySelector("#dashboard"),
  rangeSelect: document.querySelector("#rangeSelect"),
  refreshBtn: document.querySelector("#refreshBtn"),
  sessions24: document.querySelector("#sessions24"),
  sessionsRange: document.querySelector("#sessionsRange"),
  minutes24: document.querySelector("#minutes24"),
  minutesRange: document.querySelector("#minutesRange"),
  latency24: document.querySelector("#latency24"),
  errors24: document.querySelector("#errors24"),
  errorsRange: document.querySelector("#errorsRange"),
  updatedAt: document.querySelector("#updatedAt"),
  dailyChart: document.querySelector("#dailyChart"),
  languagePairs: document.querySelector("#languagePairs"),
  devices: document.querySelector("#devices"),
  browsers: document.querySelector("#browsers"),
  recentSessions: document.querySelector("#recentSessions"),
  recentErrors: document.querySelector("#recentErrors"),
  featureUsage: document.querySelector("#featureUsage"),
  closeReasons: document.querySelector("#closeReasons"),
};

const FEATURE_LABELS = {
  correction: "修正识别",
  typed_translate: "打字翻译",
  photo_translate: "拍照翻译",
  reconnect: "自动重连",
  session_rotate: "会话轮换",
  channel_closed: "通道关闭",
};

const TOKEN_KEY = "liveTranslate.adminToken";

function readInitialToken() {
  const urlToken = new URLSearchParams(window.location.search).get("token");
  if (urlToken) {
    localStorage.setItem(TOKEN_KEY, urlToken);
    window.history.replaceState({}, document.title, window.location.pathname);
    return urlToken;
  }
  return localStorage.getItem(TOKEN_KEY) || "";
}

let adminToken = readInitialToken();

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
}

function formatMinutes(ms) {
  const minutes = Math.round(Number(ms || 0) / 60000);
  if (minutes < 60) return `${formatNumber(minutes)}m`;
  return `${formatNumber(Math.round(minutes / 60))}h`;
}

function formatLatency(ms) {
  const value = Number(ms || 0);
  if (!value) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function setError(message) {
  elements.errorPanel.hidden = !message;
  elements.errorPanel.textContent = message || "";
}

function setAuthed(authed) {
  elements.authPanel.hidden = authed;
  elements.dashboard.hidden = !authed;
}

async function loadDashboard() {
  if (!adminToken) {
    setAuthed(false);
    return;
  }

  setError("");
  elements.refreshBtn.disabled = true;

  try {
    const days = elements.rangeSelect.value;
    const response = await fetch(`/api/metrics?days=${encodeURIComponent(days)}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      cache: "no-store",
    });

    if (response.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      adminToken = "";
      setAuthed(false);
      setError("后台密码不对。");
      return;
    }

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

    setAuthed(true);
    render(data);
  } catch (error) {
    setError(error.message || "加载失败");
  } finally {
    elements.refreshBtn.disabled = false;
  }
}

function render(data) {
  const last24h = data.last24h || {};
  const range = data.range || {};
  const days = data.days || Number(elements.rangeSelect.value);

  elements.sessions24.textContent = formatNumber(last24h.sessions);
  elements.sessionsRange.textContent = `${days}d ${formatNumber(range.sessions)}`;
  elements.minutes24.textContent = formatMinutes(last24h.duration_ms);
  elements.minutesRange.textContent = `${days}d ${formatMinutes(range.duration_ms)}`;
  elements.latency24.textContent = formatLatency(last24h.avg_first_audio_ms || range.avg_first_audio_ms);
  elements.errors24.textContent = formatNumber(last24h.errors);
  elements.errorsRange.textContent = `${days}d ${formatNumber(range.errors)}`;
  elements.updatedAt.textContent = `更新 ${formatTime(data.generatedAt)}`;

  renderDailyChart(data.daily || []);
  renderStack(elements.languagePairs, data.languagePairs || [], {
    label: (row) => `${row.source_language || "auto"} → ${row.target_language || "auto"}`,
    value: (row) => `${formatNumber(row.sessions)} 次 · ${formatLatency(row.avg_first_audio_ms)}`,
    count: (row) => Number(row.sessions || 0),
  });
  renderStack(elements.devices, data.devices || [], {
    label: (row) => row.device || "unknown",
    value: (row) => `${formatNumber(row.sessions)} 次`,
    count: (row) => Number(row.sessions || 0),
  });
  renderBrowsers(data.browsers || []);
  renderFeatureUsage(data.featureUsage || []);
  renderStack(elements.closeReasons, data.closeReasons || [], {
    label: (row) => row.reason || "(未知)",
    value: (row) => `${formatNumber(row.n)} 次`,
    count: (row) => Number(row.n || 0),
  });
  renderRecentSessions(data.recentSessions || []);
  renderRecentErrors(data.recentErrors || []);
}

function renderFeatureUsage(rows) {
  elements.featureUsage.replaceChildren();
  if (!rows.length) {
    elements.featureUsage.append(emptyNode("该时间范围内还没有功能使用记录"));
    return;
  }
  for (const row of rows) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = `${FEATURE_LABELS[row.event_type] || row.event_type} ${formatNumber(row.n)}`;
    elements.featureUsage.append(chip);
  }
}

function renderDailyChart(rows) {
  elements.dailyChart.replaceChildren();
  if (!rows.length) {
    elements.dailyChart.append(emptyNode("还没有趋势数据"));
    return;
  }

  const max = Math.max(1, ...rows.map((row) => Number(row.sessions || 0)));
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "bar-item";
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${Math.max(8, (Number(row.sessions || 0) / max) * 170)}px`;
    bar.dataset.value = formatNumber(row.sessions);
    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = String(row.day || "").slice(5);
    item.append(bar, label);
    elements.dailyChart.append(item);
  }
}

function renderStack(container, rows, config) {
  container.replaceChildren();
  if (!rows.length) {
    container.append(emptyNode("暂无数据"));
    return;
  }

  const max = Math.max(1, ...rows.map(config.count));
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "stack-row";

    const main = document.createElement("div");
    main.className = "stack-row-main";
    const label = document.createElement("strong");
    label.textContent = config.label(row);
    const value = document.createElement("span");
    value.textContent = config.value(row);
    main.append(label, value);

    const progress = document.createElement("div");
    progress.className = "progress";
    const fill = document.createElement("span");
    fill.style.width = `${Math.max(4, (config.count(row) / max) * 100)}%`;
    progress.append(fill);
    item.append(main, progress);
    container.append(item);
  }
}

function renderBrowsers(rows) {
  elements.browsers.replaceChildren();
  for (const row of rows) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = `${row.browser || "unknown"} ${formatNumber(row.sessions)}`;
    elements.browsers.append(chip);
  }
}

function renderRecentSessions(rows) {
  elements.recentSessions.replaceChildren();
  if (!rows.length) {
    elements.recentSessions.append(emptyNode("还没有结束的会话"));
    return;
  }

  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "table-row";
    const main = document.createElement("div");
    main.className = "table-main";
    const pair = document.createElement("strong");
    pair.textContent = `${row.source_language || "auto"} → ${row.target_language || "auto"}`;
    const duration = document.createElement("span");
    duration.textContent = formatMinutes(row.duration_ms);
    main.append(pair, duration);
    const meta = document.createElement("div");
    meta.className = "row-meta";
    meta.append(
      textSpan(formatTime(row.created_at)),
      textSpan(`${formatNumber(row.output_events)} 译文`),
      textSpan(`${row.device || "unknown"}/${row.browser || "unknown"}`),
      textSpan(row.country || "--"),
    );
    item.append(main, meta);
    elements.recentSessions.append(item);
  }
}

function renderRecentErrors(rows) {
  elements.recentErrors.replaceChildren();
  if (!rows.length) {
    elements.recentErrors.append(emptyNode("暂无错误"));
    return;
  }

  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "table-row";
    const main = document.createElement("div");
    main.className = "table-main";
    const message = document.createElement("strong");
    message.textContent = row.error_message || "Unknown error";
    main.append(message);
    const meta = document.createElement("div");
    meta.className = "row-meta";
    meta.append(
      textSpan(formatTime(row.created_at)),
      textSpan(`${row.source_language || "auto"} → ${row.target_language || "auto"}`),
      textSpan(`${row.device || "unknown"}/${row.browser || "unknown"}`),
      textSpan(row.country || "--"),
    );
    item.append(main, meta);
    elements.recentErrors.append(item);
  }
}

function textSpan(value) {
  const span = document.createElement("span");
  span.textContent = value;
  return span;
}

function emptyNode(text) {
  const node = document.createElement("div");
  node.className = "empty";
  node.textContent = text;
  return node;
}

elements.saveTokenBtn.addEventListener("click", () => {
  adminToken = elements.tokenInput.value.trim();
  if (!adminToken) return;
  localStorage.setItem(TOKEN_KEY, adminToken);
  loadDashboard();
});

elements.tokenInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") elements.saveTokenBtn.click();
});

elements.refreshBtn.addEventListener("click", loadDashboard);
elements.rangeSelect.addEventListener("change", loadDashboard);

if (adminToken) {
  elements.tokenInput.value = adminToken;
  loadDashboard();
} else {
  setAuthed(false);
}
