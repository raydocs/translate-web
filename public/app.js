const LIVE_MODEL = "gemini-3.5-live-translate-preview";
const MIC_SAMPLE_RATE = 16000;

// The mic echo gate exists ONLY to break the iOS Safari self-translation
// loop (WebKit's AEC does not cover Web Audio playback). On desktop, Android
// and with headphones, the browser's echo cancellation already handles it, so
// gating there just starves the model of audio and makes translation stutter.
// Enable the gate on iOS only.
const IS_IOS =
  /iPhone|iPad|iPod/.test(navigator.userAgent || "") ||
  (/Mac/.test(navigator.userAgent || "") && (navigator.maxTouchPoints || 0) > 1);
// WeChat / in-app webviews ship their own audio stacks whose echo
// cancellation, like iOS WebKit's, does not cover Web Audio playback -
// without the gate two sessions end up translating each other's TTS.
const IS_INAPP_WEBVIEW = /MicroMessenger|FBAN|FBAV|Instagram|Line\//i.test(navigator.userAgent || "");
const ECHO_GATE_ENABLED = IS_IOS || IS_INAPP_WEBVIEW;

const APP_BUILD = ((document.querySelector('script[src*="app.js"]') || {}).src || "").split("v=")[1] || "dev";

// Rolling client-side diagnostic trace, flushed to the backend every 15s
// while running and on notable events. Compact one-line entries with
// ms-precision timestamps let a whole playback incident be reconstructed.
const diag = {
  lines: [],
  lastFlushAt: 0,
  sec: { sum: 0, max: 0, frames: 0, gatedMs: 0, boundary: 0, arrivals: 0 },
  log(tag, extra = "") {
    const stamp = new Date().toISOString().slice(14, 23);
    this.lines.push(extra ? `${stamp} ${tag} ${extra}` : `${stamp} ${tag}`);
    if (this.lines.length > 400) this.lines.splice(0, this.lines.length - 400);
  },
  frame(rms, gated, playing) {
    const now = Date.now();
    const sec = this.sec;
    sec.sum += rms;
    sec.max = Math.max(sec.max, rms);
    sec.frames += 1;
    if (gated) sec.gatedMs += 40;
    if (!sec.boundary) sec.boundary = now;
    if (now - sec.boundary >= 1000) {
      const q = state.player?.holdQueue?.length ?? 0;
      const talkAgo = now - (state.mic?.lastTalkAt || 0);
      this.log(
        "s",
        `rms=${(sec.sum / Math.max(1, sec.frames)).toFixed(3)}/${sec.max.toFixed(3)} gated=${sec.gatedMs} q=${q} arr=${sec.arrivals} p=${playing ? 1 : 0} talk=${Math.min(talkAgo, 99999)}`,
      );
      sec.sum = 0;
      sec.max = 0;
      sec.frames = 0;
      sec.gatedMs = 0;
      sec.arrivals = 0;
      sec.boundary = now;
    }
    if (now - this.lastFlushAt > 15000) {
      this.lastFlushAt = now;
      this.flush("periodic");
    }
  },
  flush(reason) {
    if (!this.lines.length) return;
    const trace = this.lines.join("\n");
    this.lines = [];
    postMetric("audio_trace", { build: APP_BUILD, reason, trace });
  },
};

function getLiveSocketUrl(targetLanguageCode) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL("/api/live", `${protocol}//${window.location.host}`);
  url.searchParams.set("targetLanguageCode", targetLanguageCode);
  return url.toString();
}

function getAudioContextConstructor() {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) throw new Error("浏览器不支持实时音频");
  return AudioContextConstructor;
}

function createAudioContext(options) {
  const AudioContextConstructor = getAudioContextConstructor();
  try {
    return new AudioContextConstructor(options);
  } catch {
    return new AudioContextConstructor();
  }
}

const elements = {
  translateSurface: document.querySelector(".translate-surface"),
  sourceBlock: document.querySelector(".source-block"),
  translationBlock: document.querySelector(".translation-block"),
  languagePrompt: document.querySelector("#languagePrompt"),
  voiceSetupBtn: document.querySelector("#voiceSetupBtn"),
  resolveBtn: document.querySelector("#resolveBtn"),
  setupStatus: document.querySelector("#setupStatus"),
  languagePair: document.querySelector("#languagePair"),
  connectionStatus: document.querySelector("#connectionStatus"),
  sourceLanguageBtn: document.querySelector("#sourceLanguageBtn"),
  targetLanguageBtn: document.querySelector("#targetLanguageBtn"),
  swapBtn: document.querySelector("#swapBtn"),
  bottomStatus: document.querySelector("#bottomStatus"),
  modeTitle: document.querySelector("#modeTitle"),
  modeSubtitle: document.querySelector("#modeSubtitle"),
  startBtn: document.querySelector("#startBtn"),
  muteBtn: document.querySelector("#muteBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  volume: document.querySelector("#volume"),
  detectedLanguage: document.querySelector("#detectedLanguage"),
  noiseStatus: document.querySelector("#noiseStatus"),
  sourceLabel: document.querySelector("#sourceLabel"),
  sourceCaption: document.querySelector("#sourceCaption"),
  translationLabel: document.querySelector("#translationLabel"),
  translationCaption: document.querySelector("#translationCaption"),
  transcriptLog: document.querySelector("#transcriptLog"),
  sessionStats: document.querySelector("#sessionStats"),
  modeConversationBtn: document.querySelector("#modeConversationBtn"),
  modeTextBtn: document.querySelector("#modeTextBtn"),
  modeChooser: document.querySelector("#modeChooser"),
  chooseConversation: document.querySelector("#chooseConversation"),
  chooseText: document.querySelector("#chooseText"),
  flipBtn: document.querySelector("#flipBtn"),
  historyBtn: document.querySelector("#historyBtn"),
  historyPanel: document.querySelector("#historyPanel"),
  historyCloseBtn: document.querySelector("#historyCloseBtn"),
  historyTitle: document.querySelector("#historyTitle"),
  historyList: document.querySelector("#historyList"),
  historyDetail: document.querySelector("#historyDetail"),
  historyEntries: document.querySelector("#historyEntries"),
  historyCopyBtn: document.querySelector("#historyCopyBtn"),
  historyShareBtn: document.querySelector("#historyShareBtn"),
  historyDownloadBtn: document.querySelector("#historyDownloadBtn"),
  historyDeleteBtn: document.querySelector("#historyDeleteBtn"),
  photoBtn: document.querySelector("#photoBtn"),
  photoInput: document.querySelector("#photoInput"),
  transSheet: document.querySelector("#transSheet"),
  transSheetText: document.querySelector("#transSheetText"),
  transSheetBack: document.querySelector("#transSheetBack"),
  transSheetClose: document.querySelector("#transSheetClose"),
  transSheetReplay: document.querySelector("#transSheetReplay"),
  transSheetBackBtn: document.querySelector("#transSheetBackBtn"),
  typeConsole: document.querySelector("#typeConsole"),
  typeInput: document.querySelector("#typeInput"),
  typeSendBtn: document.querySelector("#typeSendBtn"),
  editSheet: document.querySelector("#editSheet"),
  editSheetInput: document.querySelector("#editSheetInput"),
  editSheetCancel: document.querySelector("#editSheetCancel"),
  editSheetConfirm: document.querySelector("#editSheetConfirm"),
};

const languageAliases = [
  ["zh-Hans", "中文（简体）", ["中文", "汉语", "普通话", "简体中文", "mandarin", "chinese"]],
  ["zh-Hant", "中文（繁體）", ["繁体中文", "繁體中文", "粤语", "粵語", "traditional chinese", "cantonese"]],
  ["en", "English", ["英文", "英语", "英語", "english"]],
  ["ja", "日本語", ["日语", "日語", "日本語", "japanese"]],
  ["ko", "한국어", ["韩语", "韓語", "韩国语", "korean", "한국어"]],
  ["es", "Español", ["西班牙语", "西班牙語", "spanish", "español"]],
  ["fr", "Français", ["法语", "法語", "french", "français"]],
  ["de", "Deutsch", ["德语", "德語", "german", "deutsch"]],
  ["it", "Italiano", ["意大利语", "義大利語", "italian", "italiano"]],
  ["pt-BR", "Português", ["葡萄牙语", "葡萄牙語", "portuguese", "português"]],
  ["ru", "Русский", ["俄语", "俄語", "russian", "русский"]],
  ["ar", "العربية", ["阿拉伯语", "阿拉伯語", "arabic", "العربية"]],
  ["hi", "हिन्दी", ["印地语", "印地語", "hindi", "हिन्दी"]],
  ["th", "ไทย", ["泰语", "泰語", "thai", "ไทย"]],
  ["vi", "Tiếng Việt", ["越南语", "越南語", "vietnamese", "tiếng việt"]],
  ["id", "Bahasa Indonesia", ["印尼语", "印尼語", "indonesian", "bahasa indonesia"]],
  ["ms", "Bahasa Melayu", ["马来语", "馬來語", "malay", "bahasa melayu"]],
  ["tr", "Türkçe", ["土耳其语", "土耳其語", "turkish", "türkçe"]],
  ["pl", "Polski", ["波兰语", "波蘭語", "polish", "polski"]],
  ["nl", "Nederlands", ["荷兰语", "荷蘭語", "dutch", "nederlands"]],
  ["sv", "Svenska", ["瑞典语", "瑞典語", "swedish", "svenska"]],
  ["uk", "Українська", ["乌克兰语", "烏克蘭語", "ukrainian", "українська"]],
];

const SETTINGS_KEYS = {
  chineseScript: "liveTranslate.chineseScript",
  counterpartLanguage: "liveTranslate.counterpartLanguage",
  mode: "liveTranslate.mode",
};

const chineseScriptOptions = [
  { code: "zh-Hans", name: "简体中文" },
  { code: "zh-Hant", name: "繁體中文" },
];

const counterpartLanguages = [
  { code: "en", name: "English" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "it", name: "Italiano" },
  { code: "pt-BR", name: "Português" },
  { code: "ru", name: "Русский" },
  { code: "ar", name: "العربية" },
  { code: "hi", name: "हिन्दी" },
  { code: "th", name: "ไทย" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "id", name: "Bahasa Indonesia" },
  { code: "ms", name: "Bahasa Melayu" },
  { code: "tr", name: "Türkçe" },
  { code: "nl", name: "Nederlands" },
  { code: "pl", name: "Polski" },
  { code: "sv", name: "Svenska" },
  { code: "uk", name: "Українська" },
  { code: "el", name: "Ελληνικά" },
  { code: "cs", name: "Čeština" },
  { code: "ro", name: "Română" },
  { code: "hu", name: "Magyar" },
  { code: "da", name: "Dansk" },
  { code: "fi", name: "Suomi" },
  { code: "no", name: "Norsk" },
  { code: "he", name: "עברית" },
  { code: "fil", name: "Filipino" },
  { code: "km", name: "ខ្មែរ" },
];

// Languages the model may auto-switch the direction to when it detects them.
// Deliberately narrower than the selectable list: scripts that are easily
// confused with Mandarin (vi, th, ...) must never hijack the direction; the
// user-selected counterpart is always allowed regardless.
const AUTO_SWITCH_CODES = new Set(["en", "ja", "ko", "es", "fr", "de", "it", "ru", "pt-BR"]);

function canAutoSwitchTo(code) {
  const normalized = normalizeLanguageCode(code);
  return AUTO_SWITCH_CODES.has(normalized) || sameTargetLanguage(normalized, state.counterpartLanguage.code);
}

const majorLanguages = [
  ...counterpartLanguages,
  ...chineseScriptOptions,
];

const autoLanguageMap = new Map([
  ["ar", { code: "ar", name: "العربية" }],
  ["de", { code: "de", name: "Deutsch" }],
  ["en", counterpartLanguages[0]],
  ["es", counterpartLanguages[3]],
  ["fr", counterpartLanguages[4]],
  ["hi", { code: "hi", name: "हिन्दी" }],
  ["id", { code: "id", name: "Bahasa Indonesia" }],
  ["it", { code: "it", name: "Italiano" }],
  ["ja", counterpartLanguages[1]],
  ["ko", { code: "ko", name: "한국어" }],
  ["ms", { code: "ms", name: "Bahasa Melayu" }],
  ["nl", { code: "nl", name: "Nederlands" }],
  ["pl", { code: "pl", name: "Polski" }],
  ["pt", { code: "pt-BR", name: "Português" }],
  ["ru", { code: "ru", name: "Русский" }],
  ["sv", { code: "sv", name: "Svenska" }],
  ["th", { code: "th", name: "ไทย" }],
  ["tr", { code: "tr", name: "Türkçe" }],
  ["uk", { code: "uk", name: "Українська" }],
  ["vi", { code: "vi", name: "Tiếng Việt" }],
  ["zh", chineseScriptOptions[0]],
]);

function uniqueLanguages(languages) {
  const seen = new Set();
  return languages.filter((language) => {
    if (seen.has(language.code)) return false;
    seen.add(language.code);
    return true;
  });
}

function getBrowserLanguage() {
  const locales = navigator.languages?.length ? navigator.languages : [navigator.language || "zh-CN"];
  const normalized = locales.map((locale) => String(locale || "").toLowerCase());
  const zhLocale = normalized.find((locale) => locale.startsWith("zh"));

  if (zhLocale) {
    const traditional = /hant|tw|hk|mo/.test(zhLocale);
    return traditional ? chineseScriptOptions[1] : chineseScriptOptions[0];
  }

  const locale = normalized.find(Boolean) || "zh";
  const base = locale.split("-")[0];
  return autoLanguageMap.get(base) || counterpartLanguages[0];
}

function getFallbackLanguage(primary) {
  return primary.code === "en" ? chineseScriptOptions[0] : counterpartLanguages[0];
}

function readSavedLanguage(key, options, fallback) {
  try {
    const code = localStorage.getItem(key);
    return options.find((language) => normalizeLanguageCode(language.code) === normalizeLanguageCode(code)) || fallback;
  } catch {
    return fallback;
  }
}

function saveLanguagePreference(key, code) {
  try {
    localStorage.setItem(key, normalizeLanguageCode(code));
  } catch {
    // Ignore private-mode or blocked storage.
  }
}

function normalizeLanguageCode(code) {
  const value = String(code || "").trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("zh") || value.startsWith("cmn") || value.startsWith("yue")) {
    return /hant|tw|hk|mo|yue/.test(value) ? "zh-Hant" : "zh-Hans";
  }
  const base = value.split("-")[0];
  return autoLanguageMap.get(base)?.code || base;
}

function sameLanguage(left, right) {
  const a = normalizeLanguageCode(left);
  const b = normalizeLanguageCode(right);
  if (!a || !b) return false;
  if (a.startsWith("zh") && b.startsWith("zh")) return true;
  return a === b;
}

function sameTargetLanguage(left, right) {
  const a = normalizeLanguageCode(left);
  const b = normalizeLanguageCode(right);
  return Boolean(a && b && a === b);
}

function getLanguageName(code) {
  const normalized = normalizeLanguageCode(code);
  const languages = uniqueLanguages([...majorLanguages, ...autoLanguageMap.values(), autoConfig.primary, autoConfig.fallback]);
  const exact = languages.find((item) => sameTargetLanguage(item.code, normalized));
  if (exact) return exact.name;

  const language = languages.find((item) =>
    sameLanguage(item.code, normalized),
  );
  return language?.name || code || "Auto";
}

function getLanguageForCode(code) {
  const normalized = normalizeLanguageCode(code);
  if (!normalized) return null;
  return { code: normalized, name: getLanguageName(normalized) };
}

const traditionalToSimplified = new Map(Object.entries({
  萬: "万", 與: "与", 東: "东", 絲: "丝", 丟: "丢", 兩: "两", 嚴: "严", 喪: "丧", 個: "个", 豐: "丰",
  臨: "临", 為: "为", 麼: "么", 麗: "丽", 舉: "举", 義: "义", 烏: "乌", 樂: "乐", 喬: "乔", 習: "习",
  鄉: "乡", 書: "书", 買: "买", 亂: "乱", 爭: "争", 於: "于", 虧: "亏", 雲: "云", 亞: "亚", 產: "产",
  親: "亲", 褻: "亵", 億: "亿", 僅: "仅", 從: "从", 倉: "仓", 儀: "仪", 價: "价", 眾: "众", 優: "优",
  會: "会", 傘: "伞", 偉: "伟", 傳: "传", 傷: "伤", 倫: "伦", 偽: "伪", 體: "体", 餘: "余", 佛: "佛",
  傭: "佣", 佔: "占", 何: "何", 併: "并", 來: "来", 侖: "仑", 侶: "侣", 俁: "俣", 係: "系", 俠: "侠",
  倀: "伥", 倆: "俩", 倖: "幸", 倣: "仿", 倫: "伦", 側: "侧", 偵: "侦", 偶: "偶", 偷: "偷", 備: "备",
  傢: "家", 傑: "杰", 傖: "伧", 傘: "伞", 債: "债", 傾: "倾", 僂: "偻", 僅: "仅", 僉: "佥", 僑: "侨",
  僕: "仆", 僥: "侥", 僨: "偾", 億: "亿", 儈: "侩", 儉: "俭", 儐: "傧", 償: "偿", 優: "优", 儲: "储",
  兒: "儿", 兌: "兑", 內: "内", 兩: "两", 冊: "册", 冪: "幂", 凈: "净", 凍: "冻", 凜: "凛", 凱: "凯",
  別: "别", 剎: "刹", 則: "则", 剋: "克", 創: "创", 剛: "刚", 剝: "剥", 剩: "剩", 劇: "剧", 劉: "刘",
  劍: "剑", 劑: "剂", 勁: "劲", 動: "动", 務: "务", 勛: "勋", 勝: "胜", 勞: "劳", 勢: "势", 勳: "勋",
  匯: "汇", 區: "区", 協: "协", 卻: "却", 厭: "厌", 厲: "厉", 參: "参", 雙: "双", 發: "发", 變: "变",
  叢: "丛", 只: "只", 台: "台", 叶: "叶", 吃: "吃", 吊: "吊", 同: "同", 後: "后", 向: "向", 嚇: "吓",
  呂: "吕", 嗎: "吗", 吶: "呐", 吳: "吴", 呈: "呈", 告: "告", 员: "员", 唄: "呗", 唸: "念", 問: "问",
  啟: "启", 啞: "哑", 啟: "启", 喚: "唤", 喪: "丧", 單: "单", 喲: "哟", 嗆: "呛", 嗇: "啬", 嗎: "吗",
  嗚: "呜", 嗩: "唢", 嗶: "哔", 嘆: "叹", 嘍: "喽", 嘔: "呕", 嘖: "啧", 嘗: "尝", 嘜: "唛", 嘩: "哗",
  嘮: "唠", 嘯: "啸", 嘰: "叽", 嘵: "哓", 嘸: "呒", 噓: "嘘", 噴: "喷", 噸: "吨", 嚀: "咛", 嚇: "吓",
  嚐: "尝", 嚕: "噜", 嚙: "啮", 嚥: "咽", 嚦: "呖", 嚨: "咙", 嚮: "向", 嚲: "亸", 囑: "嘱", 囂: "嚣",
  園: "园", 圓: "圆", 圖: "图", 團: "团", 國: "国", 圍: "围", 園: "园", 聖: "圣", 場: "场", 塊: "块",
  塗: "涂", 塵: "尘", 塹: "堑", 墊: "垫", 墜: "坠", 墮: "堕", 墳: "坟", 墻: "墙", 壇: "坛", 壓: "压",
  壘: "垒", 壙: "圹", 壞: "坏", 壟: "垄", 壢: "坜", 壩: "坝", 壯: "壮", 壺: "壶", 壹: "壹", 壽: "寿",
  夠: "够", 夢: "梦", 夥: "伙", 夾: "夹", 奐: "奂", 奧: "奥", 奩: "奁", 奪: "夺", 奮: "奋", 奼: "姹",
  妝: "妆", 姍: "姗", 姦: "奸", 娛: "娱", 婁: "娄", 婦: "妇", 婭: "娅", 媧: "娲", 媯: "妫", 媼: "媪",
  媽: "妈", 嫗: "妪", 嫵: "妩", 嬈: "娆", 嬋: "婵", 嬌: "娇", 嬙: "嫱", 嬡: "嫒", 嬤: "嬷", 孫: "孙",
  學: "学", 孿: "孪", 寧: "宁", 寶: "宝", 實: "实", 寵: "宠", 審: "审", 寫: "写", 寬: "宽", 將: "将",
  專: "专", 尋: "寻", 對: "对", 導: "导", 尷: "尴", 屆: "届", 屍: "尸", 屢: "屡", 層: "层", 屬: "属",
  岡: "冈", 島: "岛", 峽: "峡", 崗: "岗", 崢: "峥", 嶄: "崭", 嶇: "岖", 嶔: "嵚", 嶗: "崂", 嶠: "峤",
  嶢: "峣", 嶧: "峄", 嶮: "崄", 嶴: "岙", 巋: "岿", 巒: "峦", 巔: "巅", 巰: "巯", 巹: "卺", 帥: "帅",
  師: "师", 帳: "帐", 帶: "带", 幀: "帧", 幃: "帏", 幗: "帼", 幘: "帻", 幟: "帜", 幣: "币", 幫: "帮",
  幹: "干", 幾: "几", 庫: "库", 廁: "厕", 廂: "厢", 廄: "厩", 廈: "厦", 廚: "厨", 廟: "庙", 廠: "厂",
  廡: "庑", 廢: "废", 廣: "广", 廩: "廪", 廬: "庐", 廳: "厅", 弒: "弑", 張: "张", 強: "强", 彈: "弹",
  彌: "弥", 彎: "弯", 彙: "汇", 彞: "彝", 彥: "彦", 徑: "径", 從: "从", 徠: "徕", 復: "复", 徵: "征",
  德: "德", 徹: "彻", 恆: "恒", 恥: "耻", 悅: "悦", 悞: "误", 悵: "怅", 悶: "闷", 惡: "恶", 惱: "恼",
  惲: "恽", 愛: "爱", 愜: "惬", 愴: "怆", 愷: "恺", 愾: "忾", 慄: "栗", 態: "态", 慘: "惨", 慚: "惭",
  慟: "恸", 慣: "惯", 慫: "怂", 慮: "虑", 慳: "悭", 慶: "庆", 憂: "忧", 憊: "惫", 憐: "怜", 憑: "凭",
  憚: "惮", 憤: "愤", 憫: "悯", 憮: "怃", 憲: "宪", 憶: "忆", 懇: "恳", 應: "应", 懌: "怿", 懍: "懔",
  懟: "怼", 懣: "懑", 懲: "惩", 懶: "懒", 懷: "怀", 懸: "悬", 懺: "忏", 懼: "惧", 戀: "恋", 戇: "戆",
  戔: "戋", 戧: "戗", 戰: "战", 戲: "戏", 戶: "户", 才: "才", 扎: "扎", 扔: "扔", 托: "托", 扣: "扣",
  執: "执", 擴: "扩", 掃: "扫", 揚: "扬", 換: "换", 揮: "挥", 損: "损", 搖: "摇", 搗: "捣", 搶: "抢",
  摑: "掴", 摜: "掼", 摟: "搂", 摯: "挚", 摳: "抠", 摶: "抟", 摺: "折", 摻: "掺", 撈: "捞", 撐: "撑",
  撓: "挠", 撥: "拨", 撫: "抚", 撲: "扑", 撳: "揿", 撻: "挞", 撾: "挝", 撿: "捡", 擁: "拥", 擄: "掳",
  擇: "择", 擊: "击", 擋: "挡", 擓: "㧟", 擔: "担", 據: "据", 擠: "挤", 擬: "拟", 擯: "摈", 擰: "拧",
  擱: "搁", 擲: "掷", 擴: "扩", 擷: "撷", 擺: "摆", 擻: "擞", 擼: "撸", 擾: "扰", 攄: "摅", 攆: "撵",
  攏: "拢", 攔: "拦", 攖: "撄", 攙: "搀", 攜: "携", 攝: "摄", 攢: "攒", 攣: "挛", 攤: "摊", 攪: "搅",
  敗: "败", 敘: "叙", 敵: "敌", 數: "数", 斂: "敛", 斃: "毙", 斕: "斓", 斬: "斩", 斷: "断", 於: "于",
  時: "时", 晉: "晋", 晝: "昼", 暈: "晕", 暉: "晖", 暘: "旸", 暢: "畅", 暫: "暂", 曄: "晔", 曆: "历",
  曇: "昙", 曉: "晓", 曏: "向", 曖: "暧", 曠: "旷", 曨: "昽", 曬: "晒", 書: "书", 會: "会", 朧: "胧",
  東: "东", 杴: "锨", 果: "果", 柵: "栅", 桿: "杆", 梔: "栀", 條: "条", 梟: "枭", 棄: "弃", 棖: "枨",
  棗: "枣", 棟: "栋", 棧: "栈", 棲: "栖", 棶: "梾", 椏: "桠", 楊: "杨", 楓: "枫", 楨: "桢", 業: "业",
  極: "极", 榪: "杩", 榮: "荣", 榲: "榅", 榿: "桤", 構: "构", 槍: "枪", 槓: "杠", 槳: "桨", 樁: "桩",
  樂: "乐", 樅: "枞", 樑: "梁", 樓: "楼", 標: "标", 樞: "枢", 樣: "样", 樸: "朴", 樹: "树", 橋: "桥",
  機: "机", 橢: "椭", 橫: "横", 檁: "檩", 檔: "档", 檢: "检", 檣: "樯", 檯: "台", 檳: "槟", 檸: "柠",
  檻: "槛", 櫃: "柜", 櫓: "橹", 櫚: "榈", 櫛: "栉", 櫥: "橱", 櫧: "槠", 櫨: "栌", 櫪: "枥", 櫳: "栊",
  櫸: "榉", 櫻: "樱", 欄: "栏", 權: "权", 欏: "椤", 欒: "栾", 欖: "榄", 欞: "棂", 次: "次", 歐: "欧",
  歟: "欤", 歡: "欢", 歲: "岁", 歷: "历", 歸: "归", 歿: "殁", 殘: "残", 殞: "殒", 殤: "殇", 殨: "㱮",
  殫: "殚", 殮: "殓", 殯: "殡", 殲: "歼", 殺: "杀", 殻: "壳", 毀: "毁", 毆: "殴", 毿: "毵", 氂: "牦",
  氈: "毡", 氣: "气", 氫: "氢", 氬: "氩", 氳: "氲", 汙: "污", 決: "决", 沒: "没", 沖: "冲", 況: "况",
  洩: "泄", 洶: "汹", 浹: "浃", 涇: "泾", 涼: "凉", 淒: "凄", 淚: "泪", 淥: "渌", 淨: "净", 淪: "沦",
  淵: "渊", 淶: "涞", 淺: "浅", 渙: "涣", 減: "减", 渦: "涡", 測: "测", 渾: "浑", 湊: "凑", 湞: "浈",
  湯: "汤", 溈: "沩", 準: "准", 溝: "沟", 溫: "温", 滄: "沧", 滅: "灭", 滌: "涤", 滎: "荥", 滬: "沪",
  滯: "滞", 滲: "渗", 滷: "卤", 滸: "浒", 滻: "浐", 滾: "滚", 滿: "满", 漁: "渔", 漚: "沤", 漢: "汉",
  漣: "涟", 漬: "渍", 漲: "涨", 漵: "溆", 漸: "渐", 漿: "浆", 潁: "颍", 潑: "泼", 潔: "洁", 潛: "潜",
  潤: "润", 潯: "浔", 潰: "溃", 潷: "滗", 潿: "涠", 澀: "涩", 澆: "浇", 澇: "涝", 澗: "涧", 澠: "渑",
  澤: "泽", 澦: "滪", 澩: "泶", 澮: "浍", 澱: "淀", 澾: "挞", 濁: "浊", 濃: "浓", 濕: "湿", 濘: "泞",
  濛: "蒙", 濟: "济", 濤: "涛", 濫: "滥", 濰: "潍", 濱: "滨", 濺: "溅", 濼: "泺", 濾: "滤", 瀅: "滢",
  瀆: "渎", 瀉: "泻", 瀋: "沈", 瀏: "浏", 瀕: "濒", 瀘: "泸", 瀝: "沥", 瀟: "潇", 瀠: "潆", 瀦: "潴",
  瀧: "泷", 瀨: "濑", 瀰: "弥", 瀲: "潋", 瀾: "澜", 灃: "沣", 灄: "滠", 灑: "洒", 灕: "漓", 灘: "滩",
  灝: "灏", 灣: "湾", 灤: "滦", 灧: "滟", 火: "火", 燈: "灯", 靈: "灵", 災: "灾", 燦: "灿", 爐: "炉",
  為: "为", 烏: "乌", 烴: "烃", 無: "无", 煉: "炼", 煒: "炜", 煙: "烟", 煢: "茕", 煥: "焕", 煩: "烦",
  煬: "炀", 熒: "荧", 熗: "炝", 熱: "热", 熲: "颎", 熾: "炽", 燁: "烨", 燈: "灯", 燉: "炖", 燒: "烧",
  燙: "烫", 燜: "焖", 營: "营", 燦: "灿", 燬: "毁", 燭: "烛", 燴: "烩", 燴: "烩", 燼: "烬", 爍: "烁",
  爐: "炉", 爛: "烂", 爭: "争", 爺: "爷", 爾: "尔", 牆: "墙", 牘: "牍", 牽: "牵", 犖: "荦", 犢: "犊",
  犧: "牺", 狀: "状", 狹: "狭", 狽: "狈", 猙: "狰", 猶: "犹", 猻: "狲", 獁: "犸", 獃: "呆", 獄: "狱",
  獅: "狮", 獎: "奖", 獨: "独", 獪: "狯", 獫: "猃", 獮: "狝", 獰: "狞", 獲: "获", 獵: "猎", 獷: "犷",
  獸: "兽", 獺: "獭", 獻: "献", 獼: "猕", 玀: "猡", 現: "现", 琺: "珐", 琿: "珲", 瑋: "玮", 瑣: "琐",
  瑤: "瑶", 瑩: "莹", 瑪: "玛", 瑲: "玱", 璉: "琏", 環: "环", 璽: "玺", 瓊: "琼", 瓏: "珑", 瓔: "璎",
  瓚: "瓒", 甌: "瓯", 產: "产", 甦: "苏", 甯: "宁", 電: "电", 畫: "画", 異: "异", 當: "当", 疇: "畴",
  疊: "叠", 痙: "痉", 痾: "疴", 瘂: "痖", 瘋: "疯", 瘍: "疡", 瘓: "痪", 瘞: "瘗", 瘡: "疮", 瘧: "疟",
  瘮: "瘆", 瘲: "疭", 瘺: "瘘", 療: "疗", 癆: "痨", 癇: "痫", 癉: "瘅", 癘: "疠", 癟: "瘪", 癡: "痴",
  癢: "痒", 癤: "疖", 癥: "症", 癧: "疬", 癩: "癞", 癬: "癣", 癭: "瘿", 癮: "瘾", 癰: "痈", 癱: "瘫",
  癲: "癫", 發: "发", 皚: "皑", 皺: "皱", 盃: "杯", 盜: "盗", 盞: "盏", 盡: "尽", 監: "监", 盤: "盘",
  盧: "卢", 盪: "荡", 眥: "眦", 眾: "众", 睏: "困", 睜: "睁", 睞: "睐", 瞘: "眍", 瞜: "䁖", 瞞: "瞒",
  瞭: "了", 瞶: "瞆", 瞼: "睑", 矇: "蒙", 矓: "眬", 矚: "瞩", 矯: "矫", 硃: "朱", 硜: "硁", 硤: "硖",
  硨: "砗", 碭: "砀", 碸: "砜", 確: "确", 碼: "码", 磑: "硙", 磚: "砖", 磣: "碜", 磧: "碛", 磯: "矶",
  磽: "硗", 礄: "硚", 礎: "础", 礙: "碍", 礦: "矿", 礪: "砺", 礫: "砾", 礬: "矾", 礱: "砻", 祿: "禄",
  禍: "祸", 禎: "祯", 禕: "祎", 禡: "祃", 禦: "御", 禪: "禅", 禮: "礼", 禰: "祢", 禱: "祷", 禿: "秃",
  秈: "籼", 稅: "税", 稈: "秆", 稜: "棱", 稟: "禀", 種: "种", 稱: "称", 穀: "谷", 穌: "稣", 積: "积",
  穎: "颖", 穠: "秾", 穡: "穑", 穢: "秽", 穩: "稳", 穫: "获", 窩: "窝", 窪: "洼", 窮: "穷", 窯: "窑",
  窵: "窎", 窶: "窭", 窺: "窥", 竄: "窜", 竅: "窍", 竇: "窦", 竊: "窃", 競: "竞", 筆: "笔", 筍: "笋",
  筧: "笕", 筴: "䇲", 箋: "笺", 箏: "筝", 節: "节", 範: "范", 築: "筑", 篋: "箧", 篔: "筼", 篤: "笃",
  篩: "筛", 篳: "筚", 簀: "箦", 簍: "篓", 簞: "箪", 簡: "简", 簣: "篑", 簫: "箫", 簷: "檐", 簽: "签",
  簾: "帘", 籃: "篮", 籌: "筹", 籙: "箓", 籜: "箨", 籟: "籁", 籠: "笼", 籤: "签", 籩: "笾", 籪: "簖",
  籬: "篱", 籮: "箩", 籲: "吁", 粵: "粤", 糝: "糁", 糞: "粪", 糧: "粮", 糰: "团", 糲: "粝", 糴: "籴",
  糶: "粜", 糾: "纠", 紀: "纪", 紂: "纣", 約: "约", 紅: "红", 紆: "纡", 紇: "纥", 紈: "纨", 紉: "纫",
  紋: "纹", 納: "纳", 紐: "纽", 紓: "纾", 純: "纯", 紕: "纰", 紗: "纱", 紙: "纸", 級: "级", 紛: "纷",
  紜: "纭", 紝: "纴", 紡: "纺", 紬: "䌷", 紮: "扎", 細: "细", 紱: "绂", 紲: "绁", 紳: "绅", 紵: "纻",
  紹: "绍", 紺: "绀", 紼: "绋", 絀: "绌", 終: "终", 組: "组", 絆: "绊", 絎: "绗", 結: "结", 絕: "绝",
  絛: "绦", 絝: "绔", 絞: "绞", 絡: "络", 絢: "绚", 給: "给", 絨: "绒", 絰: "绖", 統: "统", 絲: "丝",
  絳: "绛", 絶: "绝", 絹: "绢", 綁: "绑", 綃: "绡", 綆: "绠", 綈: "绨", 綉: "绣", 綏: "绥", 經: "经",
  綜: "综", 綞: "缍", 綠: "绿", 綢: "绸", 綣: "绻", 綫: "线", 綬: "绶", 維: "维", 綰: "绾", 綱: "纲",
  網: "网", 綴: "缀", 綵: "彩", 綸: "纶", 綹: "绺", 綺: "绮", 綻: "绽", 綽: "绰", 綾: "绫", 綿: "绵",
  緄: "绲", 緇: "缁", 緊: "紧", 緋: "绯", 緒: "绪", 緔: "绱", 緗: "缃", 緘: "缄", 緙: "缂", 線: "线",
  緝: "缉", 緞: "缎", 締: "缔", 緡: "缗", 緣: "缘", 緦: "缌", 編: "编", 緩: "缓", 緬: "缅", 緯: "纬",
  緱: "缑", 緲: "缈", 練: "练", 緶: "缏", 緹: "缇", 緻: "致", 縈: "萦", 縉: "缙", 縊: "缢", 縋: "缒",
  縐: "绉", 縑: "缣", 縛: "缚", 縝: "缜", 縞: "缟", 縟: "缛", 縣: "县", 縫: "缝", 縭: "缡", 縮: "缩",
  縱: "纵", 縲: "缧", 縴: "纤", 縵: "缦", 縶: "絷", 縷: "缕", 縹: "缥", 總: "总", 績: "绩", 繃: "绷",
  繅: "缫", 繆: "缪", 繒: "缯", 織: "织", 繕: "缮", 繚: "缭", 繞: "绕", 繡: "绣", 繢: "缋", 繩: "绳",
  繪: "绘", 繫: "系", 繭: "茧", 繮: "缰", 繯: "缳", 繰: "缲", 繳: "缴", 繹: "绎", 繼: "继", 繽: "缤",
  纈: "缬", 纊: "纩", 續: "续", 纍: "累", 纏: "缠", 纓: "缨", 纔: "才", 纖: "纤", 纘: "缵", 纜: "缆",
  缽: "钵", 罈: "坛", 羅: "罗", 羆: "罴", 羈: "羁", 羋: "芈", 羥: "羟", 羨: "羡", 義: "义", 習: "习",
  翹: "翘", 耬: "耧", 聖: "圣", 聞: "闻", 聯: "联", 聰: "聪", 聲: "声", 聳: "耸", 聵: "聩", 聶: "聂",
  職: "职", 聹: "聍", 聽: "听", 聾: "聋", 肅: "肃", 脅: "胁", 脈: "脉", 脛: "胫", 脫: "脱", 脹: "胀",
  腎: "肾", 腖: "胨", 腡: "脶", 腦: "脑", 腫: "肿", 腳: "脚", 腸: "肠", 膃: "腽", 膚: "肤", 膠: "胶",
  膩: "腻", 膽: "胆", 膾: "脍", 膿: "脓", 臉: "脸", 臍: "脐", 臏: "膑", 臘: "腊", 臚: "胪", 臟: "脏",
  臠: "脔", 臢: "臜", 臥: "卧", 臨: "临", 臺: "台", 與: "与", 興: "兴", 舉: "举", 舊: "旧", 艙: "舱",
  艤: "舣", 艦: "舰", 艫: "舻", 艱: "艰", 艷: "艳", 藝: "艺", 芻: "刍", 苧: "苎", 茲: "兹", 荊: "荆",
  莊: "庄", 莖: "茎", 莢: "荚", 莧: "苋", 華: "华", 萇: "苌", 萊: "莱", 萬: "万", 萵: "莴", 葉: "叶",
  葒: "荭", 著: "着", 葷: "荤", 蒓: "莼", 蒔: "莳", 蒞: "莅", 蒼: "苍", 蓀: "荪", 蓋: "盖", 蓮: "莲",
  蓯: "苁", 蓴: "莼", 蔔: "卜", 蔞: "蒌", 蔣: "蒋", 蔥: "葱", 蔦: "茑", 蔭: "荫", 蕁: "荨", 蕆: "蒇",
  蕎: "荞", 蕒: "荬", 蕓: "芸", 蕕: "莸", 蕘: "荛", 蕢: "蒉", 蕩: "荡", 蕪: "芜", 蕭: "萧", 蕷: "蓣",
  薈: "荟", 薊: "蓟", 薌: "芗", 薑: "姜", 薔: "蔷", 薘: "荙", 薟: "莶", 薦: "荐", 薩: "萨", 薺: "荠",
  藍: "蓝", 藎: "荩", 藝: "艺", 藥: "药", 藪: "薮", 藶: "苈", 藹: "蔼", 藺: "蔺", 蘄: "蕲", 蘆: "芦",
  蘇: "苏", 蘊: "蕴", 蘋: "苹", 蘚: "藓", 蘞: "蔹", 蘢: "茏", 蘭: "兰", 蘺: "蓠", 蘿: "萝", 處: "处",
  虛: "虚", 虜: "虏", 號: "号", 虧: "亏", 蟲: "虫", 蛺: "蛱", 蛻: "蜕", 蜆: "蚬", 蜜: "蜜", 蝕: "蚀",
  蝟: "猬", 蝦: "虾", 蝸: "蜗", 螄: "蛳", 螞: "蚂", 螢: "萤", 螻: "蝼", 蟄: "蛰", 蟈: "蝈", 蟎: "螨",
  蟣: "虮", 蟬: "蝉", 蟯: "蛲", 蟲: "虫", 蟶: "蛏", 蟻: "蚁", 蠅: "蝇", 蠆: "虿", 蠍: "蝎", 蠐: "蛴",
  蠑: "蝾", 蠔: "蚝", 蠟: "蜡", 蠣: "蛎", 蠨: "蟏", 蠱: "蛊", 蠶: "蚕", 蠻: "蛮", 衆: "众", 衊: "蔑",
  術: "术", 衕: "同", 衚: "胡", 衛: "卫", 衝: "冲", 袞: "衮", 袞: "衮", 裊: "袅", 裏: "里", 補: "补",
  裝: "装", 裡: "里", 製: "制", 複: "复", 褲: "裤", 褳: "裢", 褸: "褛", 褻: "亵", 襆: "幞", 襇: "裥",
  襏: "袯", 襖: "袄", 襝: "裣", 襠: "裆", 襤: "褴", 襪: "袜", 襯: "衬", 襲: "袭", 見: "见", 覎: "觃",
  規: "规", 覓: "觅", 視: "视", 覘: "觇", 覡: "觋", 覦: "觎", 親: "亲", 覬: "觊", 覯: "觏", 覲: "觐",
  覺: "觉", 覽: "览", 覿: "觌", 觀: "观", 觴: "觞", 觶: "觯", 觸: "触", 訂: "订", 訃: "讣", 計: "计",
  訊: "讯", 訌: "讧", 討: "讨", 訐: "讦", 訓: "训", 訕: "讪", 訖: "讫", 託: "托", 記: "记", 訛: "讹",
  訝: "讶", 訟: "讼", 訣: "诀", 訥: "讷", 設: "设", 許: "许", 訴: "诉", 訶: "诃", 診: "诊", 註: "注",
  詁: "诂", 詆: "诋", 詎: "讵", 詐: "诈", 詒: "诒", 詔: "诏", 評: "评", 詖: "诐", 詗: "诇", 詘: "诎",
  詛: "诅", 詞: "词", 詠: "咏", 詡: "诩", 詢: "询", 詣: "诣", 試: "试", 詩: "诗", 詫: "诧", 詬: "诟",
  詭: "诡", 詮: "诠", 詰: "诘", 話: "话", 該: "该", 詳: "详", 詵: "诜", 詼: "诙", 詿: "诖", 誄: "诔",
  誅: "诛", 誆: "诓", 誇: "夸", 誌: "志", 認: "认", 誑: "诳", 誒: "诶", 誕: "诞", 誘: "诱", 誚: "诮",
  語: "语", 誠: "诚", 誡: "诫", 誣: "诬", 誤: "误", 誥: "诰", 誦: "诵", 誨: "诲", 說: "说", 誰: "谁",
  課: "课", 誶: "谇", 誹: "诽", 誼: "谊", 調: "调", 諂: "谄", 諄: "谆", 談: "谈", 諉: "诿", 請: "请",
  諍: "诤", 諏: "诹", 諑: "诼", 諒: "谅", 論: "论", 諗: "谂", 諛: "谀", 諜: "谍", 諞: "谝", 諢: "诨",
  諤: "谔", 諦: "谛", 諧: "谐", 諫: "谏", 諭: "谕", 諮: "咨", 諱: "讳", 諳: "谙", 諶: "谌", 諷: "讽",
  諸: "诸", 諺: "谚", 諼: "谖", 諾: "诺", 謀: "谋", 謁: "谒", 謂: "谓", 謄: "誊", 謅: "诌", 謊: "谎",
  謎: "谜", 謐: "谧", 謔: "谑", 謖: "谡", 謗: "谤", 謙: "谦", 謚: "谥", 講: "讲", 謝: "谢", 謠: "谣",
  謡: "谣", 謨: "谟", 謫: "谪", 謬: "谬", 謳: "讴", 謹: "谨", 謾: "谩", 譁: "哗", 證: "证", 譎: "谲",
  譏: "讥", 譖: "谮", 識: "识", 譙: "谯", 譚: "谭", 譜: "谱", 譟: "噪", 警: "警", 譯: "译", 議: "议",
  譴: "谴", 護: "护", 譽: "誉", 讀: "读", 變: "变", 讎: "仇", 讒: "谗", 讓: "让", 讕: "谰", 讖: "谶",
  讚: "赞", 讞: "谳", 豈: "岂", 豎: "竖", 豐: "丰", 豬: "猪", 豶: "豮", 貓: "猫", 貝: "贝", 貞: "贞",
  負: "负", 財: "财", 貢: "贡", 貧: "贫", 貨: "货", 販: "贩", 貪: "贪", 貫: "贯", 責: "责", 貯: "贮",
  貰: "贳", 貲: "赀", 貳: "贰", 貴: "贵", 貶: "贬", 買: "买", 貸: "贷", 貺: "贶", 費: "费", 貼: "贴",
  貽: "贻", 貿: "贸", 賀: "贺", 賁: "贲", 賂: "赂", 賃: "赁", 賄: "贿", 賅: "赅", 資: "资", 賈: "贾",
  賊: "贼", 賑: "赈", 賒: "赊", 賓: "宾", 賕: "赇", 賙: "赒", 賚: "赉", 賜: "赐", 賞: "赏", 賠: "赔",
  賡: "赓", 賢: "贤", 賣: "卖", 賤: "贱", 賦: "赋", 賧: "赕", 質: "质", 賫: "赍", 賬: "账", 賭: "赌",
  賴: "赖", 賵: "赗", 賺: "赚", 賻: "赙", 購: "购", 賽: "赛", 贄: "贽", 贅: "赘", 贇: "赟", 贈: "赠",
  贊: "赞", 贋: "赝", 贍: "赡", 贏: "赢", 贐: "赆", 贓: "赃", 贖: "赎", 贗: "赝", 贛: "赣", 趕: "赶",
  趙: "赵", 趨: "趋", 趲: "趱", 跡: "迹", 跼: "局", 踐: "践", 踴: "踊", 蹌: "跄", 蹕: "跸", 蹟: "迹",
  蹣: "蹒", 蹤: "踪", 蹺: "跷", 躂: "跶", 躉: "趸", 躊: "踌", 躋: "跻", 躍: "跃", 躑: "踯", 躒: "跞",
  躓: "踬", 躕: "蹰", 躚: "跹", 躡: "蹑", 躥: "蹿", 躦: "躜", 躪: "躏", 軀: "躯", 車: "车", 軋: "轧",
  軌: "轨", 軍: "军", 軑: "轪", 軒: "轩", 軔: "轫", 軛: "轭", 軟: "软", 軤: "轷", 軫: "轸", 軲: "轱",
  軸: "轴", 軹: "轵", 軺: "轺", 軻: "轲", 軼: "轶", 軾: "轼", 較: "较", 輅: "辂", 輇: "辁", 載: "载",
  輊: "轾", 輒: "辄", 輓: "挽", 輔: "辅", 輕: "轻", 輛: "辆", 輜: "辎", 輝: "辉", 輞: "辋", 輟: "辍",
  輥: "辊", 輦: "辇", 輩: "辈", 輪: "轮", 輬: "辌", 輯: "辑", 輳: "辏", 輸: "输", 輻: "辐", 輾: "辗",
  輿: "舆", 轀: "辒", 轂: "毂", 轄: "辖", 轅: "辕", 轆: "辘", 轉: "转", 轍: "辙", 轎: "轿", 轔: "辚",
  轟: "轰", 轡: "辔", 轢: "轹", 轤: "轳", 辦: "办", 辭: "辞", 辮: "辫", 辯: "辩", 農: "农", 迴: "回",
  逕: "径", 這: "这", 連: "连", 週: "周", 進: "进", 遊: "游", 運: "运", 過: "过", 達: "达", 違: "违",
  遙: "遥", 遜: "逊", 遞: "递", 遠: "远", 適: "适", 遲: "迟", 遷: "迁", 選: "选", 遺: "遗", 遼: "辽",
  邁: "迈", 還: "还", 邇: "迩", 邊: "边", 邏: "逻", 郟: "郏", 郵: "邮", 鄆: "郓", 鄉: "乡", 鄒: "邹",
  鄔: "邬", 鄖: "郧", 鄧: "邓", 鄭: "郑", 鄰: "邻", 鄲: "郸", 鄴: "邺", 鄶: "郐", 鄺: "邝", 酇: "酂",
  酈: "郦", 醞: "酝", 醬: "酱", 醱: "酦", 醫: "医", 醬: "酱", 釀: "酿", 釁: "衅", 釃: "酾", 釅: "酽",
  釋: "释", 釐: "厘", 針: "针", 釣: "钓", 釧: "钏", 釵: "钗", 釷: "钍", 釹: "钕", 鈀: "钯", 鈁: "钫",
  鈃: "钘", 鈄: "钭", 鈈: "钚", 鈉: "钠", 鈍: "钝", 鈐: "钤", 鈑: "钣", 鈔: "钞", 鈕: "钮", 鈞: "钧",
  鈣: "钙", 鈥: "钬", 鈦: "钛", 鈧: "钪", 鈮: "铌", 鈰: "铈", 鈳: "钶", 鈴: "铃", 鈷: "钴", 鈸: "钹",
  鈹: "铍", 鈺: "钰", 鈽: "钸", 鈾: "铀", 鈿: "钿", 鉀: "钾", 鉅: "钜", 鉈: "铊", 鉉: "铉", 鉋: "刨",
  鉍: "铋", 鉑: "铂", 鉕: "钷", 鉗: "钳", 鉚: "铆", 鉛: "铅", 鉞: "钺", 鉤: "钩", 鉦: "钲", 鉬: "钼",
  鉭: "钽", 鉶: "铏", 鉸: "铰", 鉺: "铒", 鉻: "铬", 鉿: "铪", 銀: "银", 銃: "铳", 銅: "铜", 銍: "铚",
  銑: "铣", 銓: "铨", 銖: "铢", 銘: "铭", 銚: "铫", 銛: "铦", 銜: "衔", 銠: "铑", 銣: "铷", 銥: "铱",
  銦: "铟", 銨: "铵", 銩: "铥", 銪: "铕", 銫: "铯", 銬: "铐", 銭: "钱", 銱: "铞", 銳: "锐", 銷: "销",
  銹: "锈", 銻: "锑", 銼: "锉", 鋁: "铝", 鋃: "锒", 鋅: "锌", 鋇: "钡", 鋌: "铤", 鋏: "铗", 鋒: "锋",
  鋙: "铻", 鋝: "锊", 鋟: "锓", 鋣: "铘", 鋤: "锄", 鋥: "锃", 鋦: "锔", 鋨: "锇", 鋩: "铓", 鋪: "铺",
  鋭: "锐", 鋮: "铖", 鋯: "锆", 鋰: "锂", 鋱: "铽", 鋶: "锍", 鋸: "锯", 鋼: "钢", 錁: "锞", 錄: "录",
  錆: "锖", 錇: "锫", 錈: "锩", 錐: "锥", 錒: "锕", 錕: "锟", 錘: "锤", 錙: "锱", 錚: "铮", 錛: "锛",
  錟: "锬", 錠: "锭", 錡: "锜", 錢: "钱", 錦: "锦", 錨: "锚", 錫: "锡", 錮: "锢", 錯: "错", 録: "录",
  錳: "锰", 錶: "表", 錸: "铼", 鍀: "锝", 鍁: "锨", 鍃: "锪", 鍆: "钔", 鍇: "锴", 鍈: "锳", 鍋: "锅",
  鍍: "镀", 鍔: "锷", 鍘: "铡", 鍚: "钖", 鍛: "锻", 鍠: "锽", 鍤: "锸", 鍥: "锲", 鍩: "锘", 鍬: "锹",
  鍰: "锾", 鍵: "键", 鍶: "锶", 鍺: "锗", 鍼: "针", 鍾: "钟", 鎂: "镁", 鎄: "锿", 鎇: "镅", 鎊: "镑",
  鎔: "镕", 鎖: "锁", 鎘: "镉", 鎚: "锤", 鎛: "镈", 鎢: "钨", 鎣: "蓥", 鎦: "镏", 鎧: "铠", 鎩: "铩",
  鎪: "锼", 鎬: "镐", 鎮: "镇", 鎰: "镒", 鎳: "镍", 鎵: "镓", 鎿: "镎", 鏃: "镞", 鏇: "镟", 鏈: "链",
  鏊: "鏊", 鏌: "镆", 鏍: "镙", 鏐: "镠", 鏑: "镝", 鏗: "铿", 鏘: "锵", 鏜: "镗", 鏝: "镘", 鏞: "镛",
  鏟: "铲", 鏡: "镜", 鏢: "镖", 鏤: "镂", 鏨: "錾", 鏰: "镚", 鏵: "铧", 鏷: "镤", 鏹: "镪", 鏺: "䥽",
  鏽: "锈", 鐃: "铙", 鐋: "铴", 鐐: "镣", 鐒: "铹", 鐓: "镦", 鐔: "镡", 鐘: "钟", 鐙: "镫", 鐠: "镨",
  鐦: "锎", 鐧: "锏", 鐨: "镄", 鐫: "镌", 鐮: "镰", 鐯: "䦃", 鐲: "镯", 鐳: "镭", 鐵: "铁", 鐶: "镮",
  鐸: "铎", 鐺: "铛", 鐿: "镱", 鑄: "铸", 鑊: "镬", 鑌: "镔", 鑑: "鉴", 鑒: "鉴", 鑔: "镲", 鑕: "锧",
  鑞: "镴", 鑠: "铄", 鑣: "镳", 鑥: "镥", 鑭: "镧", 鑰: "钥", 鑱: "镵", 鑲: "镶", 鑷: "镊", 鑹: "镩",
  鑼: "锣", 鑽: "钻", 鑾: "銮", 鑿: "凿", 長: "长", 門: "门", 閂: "闩", 閃: "闪", 閆: "闫", 閈: "闬",
  閉: "闭", 開: "开", 閌: "闶", 閎: "闳", 閏: "闰", 閑: "闲", 閒: "闲", 間: "间", 閔: "闵", 閘: "闸",
  閡: "阂", 閣: "阁", 閤: "合", 閥: "阀", 閨: "闺", 閩: "闽", 閫: "阃", 閬: "阆", 閭: "闾", 閱: "阅",
  閶: "阊", 閹: "阉", 閻: "阎", 閼: "阏", 閽: "阍", 閾: "阈", 闃: "阒", 闆: "板", 闈: "闱", 闊: "阔",
  闋: "阕", 闌: "阑", 闍: "阇", 闐: "阗", 闓: "闿", 闔: "阖", 闕: "阙", 闖: "闯", 關: "关", 闞: "阚",
  闡: "阐", 闢: "辟", 闤: "阛", 阪: "坂", 陝: "陕", 陣: "阵", 陰: "阴", 陳: "陈", 陸: "陆", 陽: "阳",
  隉: "陧", 隊: "队", 階: "阶", 隕: "陨", 際: "际", 隨: "随", 險: "险", 隱: "隐", 隴: "陇", 隸: "隶",
  隻: "只", 雋: "隽", 雖: "虽", 雙: "双", 雛: "雏", 雜: "杂", 雞: "鸡", 離: "离", 難: "难", 雲: "云",
  電: "电", 霧: "雾", 霽: "霁", 靂: "雳", 靄: "霭", 靈: "灵", 靚: "靓", 靜: "静", 靦: "腼", 鞏: "巩",
  鞝: "绱", 鞽: "鞒", 韁: "缰", 韃: "鞑", 韆: "千", 韋: "韦", 韌: "韧", 韍: "韨", 韓: "韩", 韙: "韪",
  韜: "韬", 韞: "韫", 韻: "韵", 響: "响", 頁: "页", 頂: "顶", 頃: "顷", 項: "项", 順: "顺", 須: "须",
  頊: "顼", 頌: "颂", 頎: "颀", 頏: "颃", 預: "预", 頑: "顽", 頒: "颁", 頓: "顿", 頗: "颇", 領: "领",
  頜: "颌", 頡: "颉", 頤: "颐", 頦: "颏", 頭: "头", 頰: "颊", 頲: "颋", 頷: "颔", 頸: "颈", 頹: "颓",
  頻: "频", 顆: "颗", 題: "题", 額: "额", 顎: "颚", 顏: "颜", 顒: "颙", 顓: "颛", 願: "愿", 顙: "颡",
  顛: "颠", 類: "类", 顢: "颟", 顥: "颢", 顧: "顾", 顫: "颤", 顬: "颥", 顯: "显", 顰: "颦", 顱: "颅",
  顳: "颞", 顴: "颧", 風: "风", 颭: "飐", 颮: "飑", 颯: "飒", 颱: "台", 颳: "刮", 颶: "飓", 颺: "飏",
  颼: "飕", 飀: "飗", 飄: "飘", 飆: "飙", 飈: "飚", 飛: "飞", 飢: "饥", 飣: "饤", 飥: "饦", 飩: "饨",
  飪: "饪", 飫: "饫", 飭: "饬", 飯: "饭", 飲: "饮", 飴: "饴", 飼: "饲", 飽: "饱", 飾: "饰", 餃: "饺",
  餄: "饸", 餅: "饼", 餉: "饷", 養: "养", 餌: "饵", 餍: "餍", 餎: "饳", 餏: "饹", 餑: "饽", 餒: "馁",
  餓: "饿", 餘: "余", 餚: "肴", 餛: "馄", 餜: "馃", 餞: "饯", 餡: "馅", 館: "馆", 餱: "糇", 餳: "饧",
  餵: "喂", 餶: "馉", 餷: "馇", 餺: "馎", 餼: "饩", 餾: "馏", 饁: "馌", 饃: "馍", 饅: "馒", 饈: "馐",
  饉: "馑", 饊: "馓", 饋: "馈", 饌: "馔", 饑: "饥", 饒: "饶", 饗: "飨", 饞: "馋", 饢: "馕", 馬: "马",
  馭: "驭", 馮: "冯", 馱: "驮", 馳: "驰", 馴: "驯", 駁: "驳", 駐: "驻", 駑: "驽", 駒: "驹", 駔: "驵",
  駕: "驾", 駘: "骀", 駙: "驸", 駛: "驶", 駝: "驼", 駟: "驷", 駡: "骂", 駢: "骈", 駭: "骇", 駰: "骃",
  駱: "骆", 駸: "骎", 駿: "骏", 騁: "骋", 騂: "骍", 騅: "骓", 騌: "骔", 騍: "骒", 騎: "骑", 騏: "骐",
  騖: "骛", 騙: "骗", 騤: "骙", 騫: "骞", 騭: "骘", 騮: "骝", 騰: "腾", 騶: "驺", 騷: "骚", 騸: "骟",
  騾: "骡", 驀: "蓦", 驁: "骜", 驂: "骖", 驃: "骠", 驅: "驱", 驊: "骅", 驌: "骕", 驍: "骁", 驏: "骣",
  驕: "骄", 驗: "验", 驚: "惊", 驛: "驿", 驟: "骤", 驢: "驴", 驤: "骧", 驥: "骥", 驪: "骊", 骯: "肮",
  髏: "髅", 髒: "脏", 體: "体", 髕: "髌", 髖: "髋", 鬆: "松", 鬍: "胡", 鬚: "须", 鬥: "斗", 鬧: "闹",
  鬨: "哄", 鬱: "郁", 魎: "魉", 魘: "魇", 魚: "鱼", 魯: "鲁", 魴: "鲂", 鮁: "鲅", 鮃: "鲆", 鮎: "鲇",
  鮐: "鲐", 鮑: "鲍", 鮒: "鲋", 鮓: "鲊", 鮚: "鲒", 鮞: "鲕", 鮦: "鲖", 鮪: "鲔", 鮫: "鲛", 鮭: "鲑",
  鮮: "鲜", 鮰: "鲴", 鮳: "鲉", 鮶: "鲪", 鮸: "鲞", 鯀: "鲧", 鯁: "鲠", 鯇: "鲩", 鯉: "鲤", 鯊: "鲨",
  鯒: "鲬", 鯔: "鲻", 鯖: "鲭", 鯗: "鲞", 鯛: "鲷", 鯝: "鲴", 鯡: "鲱", 鯢: "鲵", 鯤: "鲲", 鯧: "鲳",
  鯨: "鲸", 鯪: "鲮", 鯫: "鲰", 鯴: "鲺", 鯷: "鳀", 鯽: "鲫", 鯿: "鳊", 鰂: "鲗", 鰈: "鲽", 鰉: "鳇",
  鰍: "鳅", 鰒: "鳆", 鰓: "鳃", 鰜: "鳒", 鰟: "鳑", 鰠: "鳋", 鰣: "鲥", 鰤: "鳃", 鰥: "鳏", 鰨: "鳎",
  鰩: "鳐", 鰭: "鳍", 鰱: "鲢", 鰲: "鳌", 鰳: "鳓", 鰵: "鳘", 鰷: "鲦", 鰹: "鲣", 鰺: "鲹", 鰻: "鳗",
  鰼: "鳛", 鰾: "鳔", 鱂: "鳉", 鱅: "鳙", 鱈: "鳕", 鱉: "鳖", 鱒: "鳟", 鱔: "鳝", 鱖: "鳜", 鱗: "鳞",
  鱘: "鲟", 鱝: "鲼", 鱟: "鲎", 鱠: "鲙", 鱣: "鳣", 鱤: "鳡", 鱧: "鳢", 鱨: "鲿", 鱭: "鲚", 鱯: "鳠",
  鱷: "鳄", 鱸: "鲈", 鱺: "鲡", 鳥: "鸟", 鳧: "凫", 鳩: "鸠", 鳳: "凤", 鳴: "鸣", 鳶: "鸢", 鴆: "鸩",
  鴇: "鸨", 鴉: "鸦", 鴒: "鸰", 鴕: "鸵", 鴛: "鸳", 鴝: "鸲", 鴞: "鸮", 鴟: "鸱", 鴣: "鸪", 鴦: "鸯",
  鴨: "鸭", 鴯: "鸸", 鴰: "鸹", 鴴: "鸻", 鴻: "鸿", 鴿: "鸽", 鵂: "鸺", 鵃: "鸼", 鵐: "鹀", 鵑: "鹃",
  鵒: "鹆", 鵓: "鹁", 鵜: "鹈", 鵝: "鹅", 鵠: "鹄", 鵡: "鹉", 鵪: "鹌", 鵬: "鹏", 鵮: "鹐", 鵯: "鹎",
  鵲: "鹊", 鶇: "鸫", 鶉: "鹑", 鶊: "鹒", 鶓: "鹋", 鶘: "鹕", 鶚: "鹗", 鶡: "鹖", 鶥: "鹛", 鶩: "鹜",
  鶯: "莺", 鶲: "鹟", 鶴: "鹤", 鶹: "鹠", 鶺: "鹡", 鶻: "鹘", 鶼: "鹣", 鶿: "鹚", 鷂: "鹞", 鷄: "鸡",
  鷈: "䴘", 鷓: "鹧", 鷖: "鹥", 鷗: "鸥", 鷙: "鸷", 鷚: "鹨", 鷥: "鸶", 鷦: "鹪", 鷫: "鹔", 鷯: "鹩",
  鷲: "鹫", 鷸: "鹬", 鷹: "鹰", 鷺: "鹭", 鸇: "鹯", 鸌: "鹱", 鸏: "鹲", 鸕: "鸬", 鸚: "鹦", 鸛: "鹳",
  鸝: "鹂", 鹵: "卤", 鹹: "咸", 鹺: "鹾", 鹼: "碱", 鹽: "盐", 麗: "丽", 麥: "麦", 麩: "麸", 黃: "黄",
  黌: "黉", 點: "点", 黨: "党", 黲: "黪", 黴: "霉", 黶: "黡", 黷: "黩", 黽: "黾", 黿: "鼋", 鼉: "鼍",
  鼕: "冬", 鼴: "鼹", 齊: "齐", 齋: "斋", 齎: "赍", 齏: "齑", 齒: "齿", 齔: "龀", 齕: "龁", 齗: "龂",
  齙: "龅", 齜: "龇", 齟: "龃", 齠: "龆", 齡: "龄", 齣: "出", 齦: "龈", 齧: "啮", 齪: "龊", 齬: "龉",
  齲: "龋", 齶: "腭", 齷: "龌", 龍: "龙", 龐: "庞", 龔: "龚", 龕: "龛", 龜: "龟",
}));

const simplifiedToTraditional = new Map([...traditionalToSimplified.entries()].map(([traditional, simplified]) => [simplified, traditional]));

const phraseToSimplified = [
  ["為什麼", "为什么"],
  ["甚麼", "什么"],
  ["什麼", "什么"],
  ["怎麼", "怎么"],
  ["這麼", "这么"],
  ["那麼", "那么"],
  ["裡面", "里面"],
  ["裏面", "里面"],
  ["軟體", "软件"],
  ["網路", "网络"],
];

function convertChineseScript(text, targetCode) {
  if (!sameLanguage(targetCode, "zh")) return text;

  let converted = String(text || "");
  const toSimplified = normalizeLanguageCode(targetCode) !== "zh-Hant";
  if (toSimplified) {
    for (const [traditional, simplified] of phraseToSimplified) converted = converted.split(traditional).join(simplified);
  }

  const map = toSimplified ? traditionalToSimplified : simplifiedToTraditional;
  return [...converted].map((char) => map.get(char) || char).join("");
}

function normalizeCaptionScript(kind, text) {
  const languageCode = kind === "output" ? state.activeTargetCode : state.activeSourceCode;
  return sameLanguage(languageCode, "zh") ? convertChineseScript(text, state.primaryLanguage.code) : text;
}

function normalizeExistingChineseCaptions() {
  for (const kind of ["source", "output"]) {
    const languageCode = kind === "output" ? state.activeTargetCode : state.activeSourceCode;
    if (!sameLanguage(languageCode, "zh")) continue;
    const bucket = state.captions[kind];
    bucket.segments = bucket.segments.map((segment) => ({
      ...segment,
      text: convertChineseScript(segment.text, state.primaryLanguage.code),
    }));
    bucket.current = convertChineseScript(bucket.current, state.primaryLanguage.code);
    bucket.lastIncoming = convertChineseScript(bucket.lastIncoming, state.primaryLanguage.code);
  }
}

function getAutoConfig() {
  const browserLanguage = getBrowserLanguage();
  const browserChinesePreference = sameLanguage(browserLanguage.code, "zh") ? browserLanguage : chineseScriptOptions[0];
  const primary = readSavedLanguage(SETTINGS_KEYS.chineseScript, chineseScriptOptions, browserChinesePreference);
  const fallback = readSavedLanguage(SETTINGS_KEYS.counterpartLanguage, counterpartLanguages, counterpartLanguages[0]);
  const targets = uniqueLanguages([primary, fallback, ...counterpartLanguages]);
  return { primary, fallback, targets };
}

function chooseTargetForSource(sourceCode) {
  if (sameLanguage(sourceCode, state.primaryLanguage.code)) return state.counterpartLanguage || state.fallbackLanguage;
  return state.primaryLanguage;
}

function updateCaptionLabels() {
  const sourceName = state.activeSourceCode ? getLanguageName(state.activeSourceCode) : "Auto";
  elements.sourceLabel.textContent = `说的 · ${sourceName}`;
  elements.translationLabel.textContent = `翻译 · ${getLanguageName(state.activeTargetCode)}`;
  updateLanguageBar();
}

function swapPrimaryLanguages() {
  state.activeSourceCode = "";
  state.activeTargetCode = state.counterpartLanguage.code;
  clearCaptions();
  updateReadyState();
}

function updateActiveLanguages(languageCode) {
  const normalized = normalizeLanguageCode(languageCode);
  if (!normalized) return;

  // The model has no source-language pinning and sometimes misdetects
  // (e.g. Mandarin as Vietnamese). Only the primary language, the selected
  // counterpart and a curated auto-switch set may steer the direction.
  if (!sameLanguage(normalized, state.primaryLanguage.code) && !canAutoSwitchTo(normalized)) return;

  const previousTargetCode = state.activeTargetCode;
  const sourceLanguage = getLanguageForCode(normalized);
  state.activeSourceCode = normalized;

  if (sourceLanguage && !sameLanguage(normalized, state.primaryLanguage.code) && isCounterpartLanguage(sourceLanguage.code)) {
    setCounterpartLanguage(sourceLanguage.code, { auto: true, keepCaptions: true });
    warmTargetSession(sourceLanguage);
  }

  const nextTarget = chooseTargetForSource(normalized);
  state.activeTargetCode = nextTarget.code;
  warmTargetSession(nextTarget);

  if (previousTargetCode && !sameLanguage(previousTargetCode, state.activeTargetCode)) {
    if (!state.player?.consecutive) state.player?.interrupt();
  }

  updateCaptionLabels();
}

function isActiveTarget(target) {
  return sameTargetLanguage(target?.code, state.activeTargetCode);
}

const autoConfig = getAutoConfig();

const state = {
  pair: autoConfig.targets,
  primaryLanguage: autoConfig.primary,
  fallbackLanguage: autoConfig.fallback,
  counterpartLanguage: autoConfig.fallback,
  activeSourceCode: "",
  activeTargetCode: autoConfig.fallback.code,
  sessions: [],
  sessionPromises: new Map(),
  sessionNonce: 0,
  mic: null,
  player: null,
  running: false,
  muted: false,
  mode: "conversation",
  setupRecognition: null,
  captions: {
    source: { segments: [], current: "", currentLang: "", lastIncoming: "", updatedAt: 0 },
    output: { segments: [], current: "", currentLang: "", lastIncoming: "", updatedAt: 0 },
  },
  transcript: new Map(),
};

const metrics = {
  pageSessionId: createMetricSessionId(),
  sessionId: "",
  requestedAt: 0,
  liveStartedAt: 0,
  micStartedAt: 0,
  firstAudioAt: 0,
  inputEvents: 0,
  outputEvents: 0,
  audioOutputMs: 0,
  audioOutputBytes: 0,
  voiceChunks: 0,
  errors: 0,
  heartbeatId: null,
  ended: true,
};

metrics.sessionId = metrics.pageSessionId;

function createMetricSessionId() {
  try {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return `lt-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return `lt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function getMetricDevice() {
  const ua = navigator.userAgent || "";
  if (/iPad|Tablet|Pad|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|Android/i.test(ua)) return "mobile";
  return "desktop";
}

function getMetricBrowser() {
  const ua = navigator.userAgent || "";
  if (/MicroMessenger/i.test(ua)) return "WeChat";
  if (/FBAN|FBAV|Instagram|Line\//i.test(ua)) return "In-app";
  if (/Edg\//i.test(ua)) return "Edge";
  if (/CriOS|Chrome\//i.test(ua)) return "Chrome";
  if (/FxiOS|Firefox\//i.test(ua)) return "Firefox";
  if (/Version\/.*Safari/i.test(ua)) return "Safari";
  if (/Safari/i.test(ua)) return "Safari";
  return "Other";
}

function getMetricScreen() {
  return {
    width: window.screen?.width || window.innerWidth,
    height: window.screen?.height || window.innerHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    dpr: Number(window.devicePixelRatio || 1).toFixed(2),
  };
}

function getMetricCapabilities() {
  return {
    audioWorklet: Boolean(window.AudioWorkletNode),
    mediaDevices: Boolean(navigator.mediaDevices?.getUserMedia),
    secureContext: Boolean(window.isSecureContext),
    sendBeacon: Boolean(navigator.sendBeacon),
    speechRecognition: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    webkitAudioContext: Boolean(window.webkitAudioContext && !window.AudioContext),
  };
}

function getMetricsLanguageState() {
  return {
    sourceLanguage: state.activeSourceCode || state.primaryLanguage.code,
    targetLanguage: state.activeTargetCode || state.counterpartLanguage.code,
    primaryLanguage: state.primaryLanguage.code,
    counterpartLanguage: state.counterpartLanguage.code,
  };
}

function getSessionMetricSummary(now = Date.now()) {
  return {
    ...getMetricsLanguageState(),
    durationMs: metrics.liveStartedAt ? now - metrics.liveStartedAt : 0,
    startupMs: metrics.requestedAt && metrics.micStartedAt ? metrics.micStartedAt - metrics.requestedAt : 0,
    firstAudioMs: metrics.firstAudioAt && metrics.micStartedAt ? metrics.firstAudioAt - metrics.micStartedAt : 0,
    inputEvents: metrics.inputEvents,
    outputEvents: metrics.outputEvents,
    audioMs: Math.round(metrics.audioOutputMs),
    audioOutputBytes: metrics.audioOutputBytes,
    voiceChunks: metrics.voiceChunks,
    echoGatedMs: Math.round(state.mic?.gatedMs || 0),
    errors: metrics.errors,
    openSessions: state.sessions.filter((session) => session.isOpen).length,
    sessions: state.sessions.length,
  };
}

function postMetric(type, data = {}, options = {}) {
  const payload = {
    type,
    sessionId: metrics.sessionId,
    data: {
      model: LIVE_MODEL,
      build: APP_BUILD,
      pageSessionId: metrics.pageSessionId,
      device: getMetricDevice(),
      browser: getMetricBrowser(),
      ...getMetricsLanguageState(),
      ...data,
    },
  };

  const body = JSON.stringify(payload);
  if (options.beacon && navigator.sendBeacon) {
    try {
      const sent = navigator.sendBeacon("/api/metrics", new Blob([body], { type: "application/json" }));
      if (sent) return;
    } catch {
      // Fall back to fetch below.
    }
  }

  fetch("/api/metrics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: options.keepalive === true,
  }).catch(() => {});
}

function resetLiveMetrics() {
  metrics.sessionId = createMetricSessionId();
  metrics.requestedAt = Date.now();
  metrics.liveStartedAt = 0;
  metrics.micStartedAt = 0;
  metrics.firstAudioAt = 0;
  metrics.inputEvents = 0;
  metrics.outputEvents = 0;
  metrics.audioOutputMs = 0;
  metrics.audioOutputBytes = 0;
  metrics.voiceChunks = 0;
  metrics.errors = 0;
  metrics.ended = false;
}

function startMetricsHeartbeat() {
  window.clearInterval(metrics.heartbeatId);
  metrics.heartbeatId = window.setInterval(() => {
    if (metrics.liveStartedAt && !metrics.ended) {
      postMetric("session_heartbeat", getSessionMetricSummary(), { keepalive: true });
    }
  }, 60000);
}

function stopMetricsHeartbeat() {
  window.clearInterval(metrics.heartbeatId);
  metrics.heartbeatId = null;
}

function recordMetricError(error, data = {}) {
  metrics.errors += 1;
  postMetric(
    "error",
    {
      ...data,
      errorMessage: error?.message || String(error || "Unknown error"),
    },
    { keepalive: true },
  );
}

function isCounterpartLanguage(code) {
  return counterpartLanguages.some((language) => sameTargetLanguage(language.code, code));
}

function getCounterpartLanguage(code) {
  return counterpartLanguages.find((language) => sameTargetLanguage(language.code, code)) || counterpartLanguages[0];
}

function refreshLanguagePair() {
  state.pair = uniqueLanguages([state.primaryLanguage, state.fallbackLanguage, ...counterpartLanguages]);
}

function resetOutputForLanguageChange(previousTargetCode) {
  if (!previousTargetCode || sameTargetLanguage(previousTargetCode, state.activeTargetCode)) return;
  resetCaptionBucket("output");
  renderCaptions();
  state.player?.interrupt();
}

function setPrimaryLanguage(code) {
  const language = chineseScriptOptions.find((option) => sameTargetLanguage(option.code, code)) || chineseScriptOptions[0];
  const previousTargetCode = state.activeTargetCode;
  state.primaryLanguage = language;
  saveLanguagePreference(SETTINGS_KEYS.chineseScript, language.code);

  if (state.activeSourceCode && !sameLanguage(state.activeSourceCode, state.primaryLanguage.code)) {
    state.activeTargetCode = state.primaryLanguage.code;
  } else {
    state.activeTargetCode = state.counterpartLanguage.code;
  }

  refreshLanguagePair();
  warmTargetSession(state.primaryLanguage);
  pruneStaleSessions();
  resetOutputForLanguageChange(previousTargetCode);
  normalizeExistingChineseCaptions();
  renderCaptions();
  updateReadyState();
}

function setCounterpartLanguage(code, options = {}) {
  const language = getCounterpartLanguage(code);
  const previousTargetCode = state.activeTargetCode;
  state.fallbackLanguage = language;
  state.counterpartLanguage = language;
  if (!options.auto) saveLanguagePreference(SETTINGS_KEYS.counterpartLanguage, language.code);

  if (!state.activeSourceCode || sameLanguage(state.activeSourceCode, state.primaryLanguage.code)) {
    state.activeTargetCode = state.counterpartLanguage.code;
  } else {
    state.activeTargetCode = state.primaryLanguage.code;
  }

  refreshLanguagePair();
  warmTargetSession(state.counterpartLanguage);
  pruneStaleSessions();
  if (!options.keepCaptions) resetOutputForLanguageChange(previousTargetCode);
  updateReadyState();
}

function setStatus(element, text, muted = false) {
  if (element === elements.connectionStatus) {
    element.dataset.state = text;
    element.textContent = "•••";
    element.classList.toggle("muted", muted);
    setBottomStatus(text);
    return;
  }

  element.textContent = text;
  element.classList.toggle("muted", muted);
}

function setBottomStatus(status) {
  if (!elements.bottomStatus) return;
  const labels = {
    connecting: "Connecting",
    live: "Listening",
    muted: "Paused",
    offline: "Tap",
    reconnecting: "Reconnecting",
  };
  elements.bottomStatus.textContent = labels[status] || status || "Tap";
}

function setCaption(element, text, emptyText) {
  const value = text.trim();
  element.textContent = value || emptyText;
  element.classList.toggle("empty", !value);
}

function clipText(value, max = 1200) {
  if (value.length <= max) return value;
  return `…${value.slice(value.length - max)}`;
}

function scrollToLatest() {
  requestAnimationFrame(() => {
    for (const element of [
      elements.sourceCaption,
      elements.translationCaption,
      elements.sourceBlock,
      elements.translationBlock,
      elements.translateSurface,
    ]) {
      if (!element) continue;
      const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
      if (distanceFromBottom > 96) continue;
      element.scrollTo({
        top: element.scrollHeight,
        behavior: "auto",
      });
    }
  });
}

function resetCaptionBucket(kind) {
  state.captions[kind] = { segments: [], current: "", currentLang: "", lastIncoming: "", updatedAt: 0 };
}

function splitCompleteSegments(text, force = false) {
  const segments = [];
  let start = 0;
  let lastSoftBreak = -1;
  let lastWordBreak = -1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const hardBreak = /[。！？!?]/u.test(char);
    const softBreak = /[，,；;、]/u.test(char);
    const wordBreak = /\s/u.test(char);
    if (softBreak) lastSoftBreak = index + 1;
    if (wordBreak) lastWordBreak = index + 1;

    const length = index - start + 1;
    const shouldSoftBreak = softBreak && length >= 44;
    const shouldForceSoftBreak = !hardBreak && length >= 86 && lastSoftBreak > start;
    const shouldWordBreak = !hardBreak && length >= 96 && lastWordBreak > start;
    const shouldLongBreak = !hardBreak && length >= 72 && lastSoftBreak <= start && lastWordBreak <= start;

    if (hardBreak || shouldSoftBreak || shouldForceSoftBreak || shouldWordBreak || shouldLongBreak) {
      const end = hardBreak || shouldSoftBreak || shouldLongBreak ? index + 1 : shouldForceSoftBreak ? lastSoftBreak : lastWordBreak;
      const segment = text.slice(start, end).trim();
      if (segment) segments.push(segment);
      start = end;
      lastSoftBreak = -1;
      lastWordBreak = -1;
    }
  }

  const rest = text.slice(start).trimStart();
  if (force && rest.trim()) return { segments: [...segments, rest.trim()], rest: "" };
  return { segments, rest };
}

function captionLanguage(kind) {
  return normalizeLanguageCode(kind === "output" ? state.activeTargetCode : state.activeSourceCode) || "";
}

function appendCaptionSegment(kind, text, finished = false) {
  const bucket = state.captions[kind];
  const now = Date.now();
  const lang = captionLanguage(kind);
  const incoming = String(text || "");
  const wasPaused = bucket.updatedAt && now - bucket.updatedAt > 1400;

  if (wasPaused && bucket.current.trim()) {
    const flushed = splitCompleteSegments(bucket.current, true);
    bucket.segments.push(...flushed.segments.map((value) => ({ text: value, lang: bucket.currentLang || lang })));
    for (const value of flushed.segments) logSessionEntry(kind, value, bucket.currentLang || lang);
    bucket.current = "";
    bucket.lastIncoming = "";
  }

  let delta = incoming;
  if (bucket.lastIncoming && incoming.startsWith(bucket.lastIncoming) && incoming.length > bucket.lastIncoming.length) {
    delta = incoming.slice(bucket.lastIncoming.length);
  } else if (bucket.lastIncoming && bucket.lastIncoming.startsWith(incoming)) {
    delta = "";
  }

  bucket.lastIncoming = finished ? "" : incoming;
  bucket.current = `${bucket.current}${delta}`;
  bucket.currentLang = lang;
  const { segments, rest } = splitCompleteSegments(bucket.current, finished);

  bucket.segments.push(...segments.map((value) => ({ text: value, lang })));
  for (const value of segments) logSessionEntry(kind, value, lang);
  bucket.current = rest;
  bucket.updatedAt = now;
  if (bucket.segments.length > 120) bucket.segments.splice(0, bucket.segments.length - 120);
}

function renderCaption(element, bucket, emptyText, options = {}) {
  const items = bucket.segments.map((segment) => ({ text: segment.text, lang: segment.lang, done: true }));
  const tail = bucket.current.trim();
  if (tail) items.push({ text: tail, lang: bucket.currentLang || "", done: false });

  element.replaceChildren();
  element.classList.toggle("empty", items.length === 0);

  if (!items.length) {
    element.textContent = emptyText;
    return;
  }

  let previousLang = null;
  for (const item of items) {
    const lang = normalizeLanguageCode(item.lang || "");
    // Mark direction changes so a two-way conversation reads as turns.
    if (lang && previousLang !== null && lang !== previousLang) {
      const tag = document.createElement("span");
      tag.className = "caption-dir-tag";
      tag.textContent = getLanguageName(lang);
      element.append(tag);
    }
    if (lang) previousLang = lang;

    const line = document.createElement("span");
    line.className = "caption-line";
    if (item.done) line.classList.add("done-line");
    if (options.editable && item.done) line.classList.add("editable-line");
    if (lang) line.dataset.lang = lang;
    renderLineContent(line, item.text);
    element.append(line);
  }
}

// Numbers, prices, times and phone-like sequences are where translation
// mistakes cost the most - make them stand out.
const NUMERIC_RUN = /[$€¥£₩฿]\s?\d[\d.,:\/\-\s]*\d%?|[$€¥£₩฿]\s?\d%?|\d[\d.,:\/\-]*\d\s?[%元块美金円원]?|\d\s?[%元块美金円원]?/g;

function renderLineContent(line, text) {
  const value = String(text || "");
  let lastIndex = 0;
  for (const match of value.matchAll(NUMERIC_RUN)) {
    if (match.index > lastIndex) line.append(document.createTextNode(value.slice(lastIndex, match.index)));
    const strong = document.createElement("strong");
    strong.className = "caption-figure";
    strong.textContent = match[0];
    line.append(strong);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < value.length) line.append(document.createTextNode(value.slice(lastIndex)));
}

function renderCaptions() {
  renderCaption(elements.sourceCaption, state.captions.source, "…", { editable: true });
  renderCaption(elements.translationCaption, state.captions.output, "…");
  scrollToLatest();
}

function renderLanguagePair() {
  elements.languagePair.innerHTML = "";
  if (!state.pair) return;

  const [from, to] = state.pair;
  for (const label of [from.name, "↔", to.name]) {
    const chip = document.createElement("span");
    chip.className = "language-chip";
    chip.textContent = label;
    elements.languagePair.append(chip);
  }
}

function updateLanguageBar() {
  elements.sourceLanguageBtn.value = state.primaryLanguage.code;
  elements.targetLanguageBtn.value = state.counterpartLanguage.code;
}


function updateReadyState() {
  const hasPair = Boolean(state.pair);
  elements.startBtn.disabled = !hasPair;
  elements.modeTitle.textContent = hasPair
    ? `${state.pair[0].name} ⇄ ${state.pair[1].name}`
    : "Ready";
  elements.modeSubtitle.textContent = hasPair
    ? "点开始"
    : "先选语言";
  renderLanguagePair();
  updateLanguageBar();
}

async function resolveLanguages() {
  const text = elements.languagePrompt.value.trim();
  if (!text) {
    setStatus(elements.setupStatus, "empty", true);
    elements.languagePrompt.focus();
    return;
  }

  elements.resolveBtn.disabled = true;
  setStatus(elements.setupStatus, "reading");

  try {
    const response = await fetch("/api/resolve-languages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) throw new Error("resolver failed");

    const result = await response.json();
    if (Array.isArray(result.languages) && result.languages.length === 2) {
      state.pair = result.languages;
      setStatus(elements.setupStatus, "ready");
      updateReadyState();
      return;
    }

    setStatus(elements.setupStatus, "?", true);
  } catch {
    const fallback = resolveLanguagesLocally(text);
    if (fallback.length === 2) {
      state.pair = fallback;
      setStatus(elements.setupStatus, "ready");
      updateReadyState();
      return;
    }

    setStatus(elements.setupStatus, "retry", true);
  } finally {
    elements.resolveBtn.disabled = false;
  }
}

function resolveLanguagesLocally(text) {
  const normalized = text.toLowerCase();
  const found = [];
  for (const [code, name, aliases] of languageAliases) {
    if (aliases.some((alias) => normalized.includes(alias.toLowerCase()))) {
      if (!found.some((language) => language.code === code)) found.push({ code, name });
    }
  }
  return found.slice(0, 2);
}

function startSetupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setStatus(elements.setupStatus, "type", true);
    return;
  }

  if (state.setupRecognition) {
    state.setupRecognition.stop();
    state.setupRecognition = null;
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = navigator.language || "zh-CN";
  recognition.continuous = false;
  recognition.interimResults = true;

  recognition.onstart = () => {
    elements.voiceSetupBtn.classList.add("listening");
    setStatus(elements.setupStatus, "listening");
  };

  recognition.onresult = (event) => {
    let transcript = "";
    let finalTranscript = "";
    for (const result of event.results) {
      transcript += result[0]?.transcript || "";
      if (result.isFinal) finalTranscript += result[0]?.transcript || "";
    }
    elements.languagePrompt.value = transcript.trim();
    if (finalTranscript.trim()) resolveLanguages();
  };

  recognition.onerror = () => setStatus(elements.setupStatus, "type", true);
  recognition.onend = () => {
    elements.voiceSetupBtn.classList.remove("listening");
    state.setupRecognition = null;
  };

  state.setupRecognition = recognition;
  recognition.start();
}

async function requestToken(targetLanguageCode) {
  const response = await fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetLanguageCode, echoTargetLanguage: false }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Token request failed: ${response.status}`);
  }

  return response.json();
}

function getSessionKey(languageCode) {
  return normalizeLanguageCode(languageCode);
}

function getInitialSessionTargets() {
  return uniqueLanguages([state.primaryLanguage, state.fallbackLanguage]);
}

function warmTargetSession(targetLanguage) {
  if (!state.running || !targetLanguage) return;
  ensureSessionForTarget(targetLanguage).catch((error) => {
    console.error(error);
    if (!state.running) return;
    const key = getSessionKey(targetLanguage.code);
    const stillWanted =
      key === getSessionKey(state.primaryLanguage.code) || key === getSessionKey(state.counterpartLanguage.code);
    if (stillWanted) scheduleSessionReconnect(getLanguageForCode(key));
  });
}

async function rotateSession(oldSession) {
  if (!state.running || !oldSession || oldSession.rotating || oldSession.closed) return;
  oldSession.rotating = true;
  const nonce = state.sessionNonce;

  const replacement = new GeminiTranslateSession({
    target: oldSession.target,
    index: state.sessions.length,
    onEvent: handleSessionEvent,
  });
  state.sessions.push(replacement);
  updateSessionStats();

  try {
    await replacement.connect();
    if (nonce !== state.sessionNonce) {
      replacement.close();
      state.sessions = state.sessions.filter((session) => session !== replacement);
      updateSessionStats();
      return;
    }
    oldSession.close();
    state.sessions = state.sessions.filter((session) => session !== oldSession);
    postMetric("session_rotate", { targetLanguage: oldSession.target.code });
  } catch {
    replacement.close();
    state.sessions = state.sessions.filter((session) => session !== replacement);
    oldSession.rotating = false;
    // If the old session already died while we were connecting, its closed
    // event was suppressed; kick off the reactive reconnect ourselves.
    if (oldSession.closed && state.running && nonce === state.sessionNonce) {
      scheduleSessionReconnect(oldSession.target);
    }
  }
  updateSessionStats();
}

function pruneStaleSessions() {
  const keep = new Set([getSessionKey(state.primaryLanguage.code), getSessionKey(state.counterpartLanguage.code)]);
  const stale = state.sessions.filter((session) => !keep.has(getSessionKey(session.target.code)));
  if (!stale.length) return;
  for (const session of stale) session.close();
  state.sessions = state.sessions.filter((session) => !stale.includes(session));
  updateSessionStats();
}

let screenWakeLock = null;

async function acquireWakeLock() {
  if (!navigator.wakeLock?.request) return;
  try {
    screenWakeLock = await navigator.wakeLock.request("screen");
    screenWakeLock.addEventListener?.("release", () => {
      screenWakeLock = null;
    });
  } catch {
    screenWakeLock = null;
  }
}

function releaseWakeLock() {
  try {
    screenWakeLock?.release();
  } catch {
    // Already released.
  }
  screenWakeLock = null;
}

const reconnectHistory = new Map();
const pendingReconnects = new Set();

function scheduleSessionReconnect(target) {
  if (!state.running || !target) return;
  const key = getSessionKey(target.code);
  if (!key) return;

  // Multiple paths (closed event, warm failure, rotation fallback) can all
  // ask for a reconnect at once; one in-flight chain per channel is enough.
  // A second chain defeats the backoff and can trip upstream rate limits.
  if (pendingReconnects.has(key)) return;

  // If the page is hidden AND the mic is not actually capturing (phone
  // locked, app switched away), a reconnected session would just be
  // idle-closed again; the visibilitychange handler revives channels on
  // return. But a merely occluded desktop window with a live mic must keep
  // reconnecting - macOS Chrome reports covered windows as hidden too.
  if (document.hidden && state.mic?.context?.state !== "running") return;

  const now = Date.now();
  const history = (reconnectHistory.get(key) || []).filter((at) => now - at < 120000);
  if (history.length >= 6) {
    setStatus(elements.connectionStatus, `${target.name} 通道已断开`, true);
    return;
  }
  history.push(now);
  reconnectHistory.set(key, history);

  setStatus(elements.connectionStatus, "reconnecting", true);
  postMetric("reconnect", { targetLanguage: target.code, attempt: history.length });

  const delay = Math.min(4000, 400 * 2 ** (history.length - 1));
  pendingReconnects.add(key);
  window.setTimeout(() => {
    if (!state.running) {
      pendingReconnects.delete(key);
      return;
    }
    ensureSessionForTarget(target)
      .then((session) => {
        pendingReconnects.delete(key);
        if (!session) return;
        if (state.running) setStatus(elements.connectionStatus, state.muted ? "muted" : "live", state.muted);
      })
      .catch(() => {
        pendingReconnects.delete(key);
        scheduleSessionReconnect(target);
      });
  }, delay);
}

async function ensureSessionForTarget(targetLanguage, nonce = state.sessionNonce) {
  const target = getLanguageForCode(targetLanguage?.code || targetLanguage);
  const key = getSessionKey(target?.code);
  if (!target || !key) return null;

  const pending = state.sessionPromises.get(key);
  if (pending) return pending;

  const existing = state.sessions.find((session) => sameTargetLanguage(session.target.code, key));
  if (existing?.isReady && existing.socket?.readyState === WebSocket.OPEN) return existing;
  if (existing) {
    existing.close();
    state.sessions = state.sessions.filter((session) => session !== existing);
    updateSessionStats();
  }

  const promise = (async () => {
    if (nonce !== state.sessionNonce) return null;

    const session = new GeminiTranslateSession({
      target,
      index: state.sessions.length,
      onEvent: handleSessionEvent,
    });

    state.sessions.push(session);
    updateSessionStats();

    try {
      await session.connect();
      if (nonce !== state.sessionNonce) {
        session.close();
        state.sessions = state.sessions.filter((item) => item !== session);
        updateSessionStats();
        return null;
      }
      return session;
    } catch (error) {
      session.close();
      state.sessions = state.sessions.filter((item) => item !== session);
      updateSessionStats();
      throw error;
    }
  })();

  state.sessionPromises.set(key, promise);

  try {
    return await promise;
  } finally {
    state.sessionPromises.delete(key);
  }
}

async function startInterpreter() {
  if (state.running) {
    stopInterpreter();
    return;
  }

  if (!state.pair) return;

  resetLiveMetrics();
  postMetric(
    "session_request",
    {
      screen: getMetricScreen(),
      capabilities: getMetricCapabilities(),
    },
    { keepalive: true },
  );

  clearCaptions();
  state.sessionNonce += 1;
  state.counterpartLanguage = state.fallbackLanguage;
  state.activeSourceCode = "";
  state.activeTargetCode = state.counterpartLanguage.code;
  updateCaptionLabels();

  elements.startBtn.disabled = true;
  elements.resolveBtn.disabled = true;
  setStatus(elements.connectionStatus, "connecting");

  try {
    state.player = state.player || new AudioPlayer();
    state.mic = new MicrophoneStreamer(
      (base64Audio) => {
        metrics.voiceChunks += 1;
        for (const session of state.sessions) session.sendAudio(base64Audio);
      },
      (noiseState) => updateNoiseStatus(noiseState),
      {
        // Only feed playback state to the gate where echo suppression is
        // actually needed; elsewhere the mic stays full-duplex.
        isPlaybackActive: ECHO_GATE_ENABLED ? () => state.player?.isAudible() === true : null,
        onFrame: ECHO_GATE_ENABLED ? (lastTalkAt) => state.player?.pump(lastTalkAt) : null,
      },
    );

    // Mic permission/device startup, channel connects and player init are
    // independent; running them in parallel cuts start latency roughly in
    // half. Audio captured before a channel is ready is dropped harmlessly.
    await Promise.all([
      state.player.init().then(() => state.player.setVolume(Number(elements.volume.value) / 100)),
      Promise.all(getInitialSessionTargets().map((language) => ensureSessionForTarget(language))),
      state.mic.start(),
    ]);

    metrics.liveStartedAt = Date.now();
    metrics.micStartedAt = metrics.liveStartedAt;
    startMetricsHeartbeat();

    state.running = true;
    state.muted = false;
    diag.log("start", `build=${APP_BUILD} gate=${ECHO_GATE_ENABLED ? 1 : 0}`);
    acquireWakeLock();
    document.body.classList.add("running");
    elements.startBtn.textContent = "停止";
    elements.muteBtn.textContent = "静音";
    elements.muteBtn.disabled = false;
    elements.startBtn.disabled = false;
    setStatus(elements.connectionStatus, "live");
    postMetric(
      "session_start",
      {
        ...getSessionMetricSummary(),
        startupMs: metrics.liveStartedAt - metrics.requestedAt,
        screen: getMetricScreen(),
        capabilities: getMetricCapabilities(),
      },
      { keepalive: true },
    );
    updateSessionStats();
  } catch (error) {
    console.error(error);
    recordMetricError(error, { stage: "startup", latencyMs: Date.now() - metrics.requestedAt });
    setStatus(elements.connectionStatus, error.message || "连接失败", true);
    stopInterpreter({ keepStatus: true });
  } finally {
    elements.resolveBtn.disabled = false;
    if (state.pair) elements.startBtn.disabled = false;
  }
}

function stopInterpreter(options = {}) {
  if (metrics.liveStartedAt && !metrics.ended) {
    postMetric("session_end", getSessionMetricSummary(), {
      beacon: options.beacon === true,
      keepalive: true,
    });
    metrics.ended = true;
  }
  stopMetricsHeartbeat();

  state.sessionNonce += 1;
  reconnectHistory.clear();
  pendingReconnects.clear();
  diag.log("stop");
  diag.flush("stop");
  flushSessionToHistory();
  releaseWakeLock();
  state.mic?.stop();
  state.mic = null;

  for (const session of state.sessions) session.close();
  state.sessions = [];
  state.sessionPromises.clear();

  state.player?.interrupt();
  state.running = false;
  state.muted = false;
  document.body.classList.remove("running");

  elements.startBtn.textContent = "开始";
  elements.muteBtn.textContent = "静音";
  elements.muteBtn.disabled = true;
  if (!options.keepStatus) setStatus(elements.connectionStatus, "offline", true);
  updateSessionStats();
}

function toggleMute() {
  if (!state.mic) return;
  state.muted = !state.muted;
  state.mic.setMuted(state.muted);
  elements.muteBtn.textContent = state.muted ? "恢复" : "静音";
  setStatus(elements.connectionStatus, state.muted ? "muted" : "live", state.muted);
}

function handleSessionEvent(event) {
  if (event.type === "ready") {
    postMetric(
      "live_ready",
      {
        targetLanguage: event.target?.code,
        latencyMs: event.latencyMs,
        openSessions: state.sessions.filter((session) => session.isOpen).length,
        sessions: state.sessions.length,
      },
      { keepalive: true },
    );
    updateSessionStats();
    return;
  }

  if (event.type === "audio") {
    if (!isActiveTarget(event.target)) return;
    const audioMs = AudioPlayer.getBase64PcmDurationMs(event.data);
    metrics.audioOutputMs += audioMs;
    metrics.audioOutputBytes += Math.floor((String(event.data || "").length * 3) / 4);
    if (!metrics.firstAudioAt && metrics.micStartedAt) {
      metrics.firstAudioAt = Date.now();
      postMetric(
        "first_audio",
        {
          targetLanguage: event.target?.code,
          latencyMs: metrics.firstAudioAt - metrics.micStartedAt,
          audioMs: Math.round(audioMs),
        },
        { keepalive: true },
      );
    }
    if (state.mode !== "text") state.player?.play(event.data);
    return;
  }

  if (event.type === "input" && sameTargetLanguage(event.target?.code, state.primaryLanguage.code)) {
    metrics.inputEvents += 1;
    if (event.languageCode) {
      updateActiveLanguages(event.languageCode);
      elements.detectedLanguage.textContent = `Lang · ${getLanguageName(event.languageCode)}`;
    }
    appendCaption("source", event.text, event.finished);
    appendTranscript("input", event.languageCode ? `原声 · ${getLanguageName(event.languageCode)}` : "原声", event.text, event.finished);
    return;
  }

  if (event.type === "output") {
    if (!isActiveTarget(event.target)) return;
    metrics.outputEvents += 1;
    appendCaption("output", event.text, event.finished);
    appendTranscript("output", `译成 ${event.target.name}`, event.text, event.finished, event.target.code);
    return;
  }

  if (event.type === "interrupted") {
    // In consecutive mode the held queue is still valid translation audio;
    // playback timing is governed by the pause/resume controller.
    if (!state.player?.consecutive) state.player?.interrupt();
    return;
  }

  if (event.type === "goAway") {
    rotateSession(event.session);
    return;
  }

  if (event.type === "closed") {
    state.sessions = state.sessions.filter((session) => !session.closed);
    updateSessionStats();
    // A rotating session is being replaced deliberately; its successor is
    // already connecting, so skip the reactive reconnect.
    if (event.session?.rotating) return;
    scheduleSessionReconnect(event.target);
    return;
  }

  if (event.type === "error") {
    recordMetricError(event.message || "Live session error", {
      stage: "live",
      targetLanguage: event.target?.code,
    });
    // Mid-session drops are handled by the reconnect path; only surface
    // errors when we are not in a position to recover automatically.
    if (!state.running) {
      setStatus(elements.connectionStatus, event.message || "Live session error", true);
    }
  }
}

function appendCaption(kind, text, finished = false) {
  if (!text) return;
  const displayText = normalizeCaptionScript(kind, text);
  document.body.classList.add("has-captions");
  updateCaptionLabels();
  appendCaptionSegment(kind, displayText, finished);
  renderCaptions();
}

function appendTranscript(type, label, text, finished = false, lane = "default") {
  if (!text) return;
  const key = `${type}:${lane}`;
  const now = Date.now();
  let entry = state.transcript.get(key);

  if (!entry || entry.finished || now - entry.updatedAt > 2600) {
    const row = document.createElement("div");
    row.className = `transcript-entry ${type === "output" ? "output" : "input"}`;
    const strong = document.createElement("strong");
    strong.textContent = label;
    const span = document.createElement("span");
    row.append(strong, span);
    elements.transcriptLog.append(row);
    entry = { row, span, text: "", updatedAt: now, finished: false };
    state.transcript.set(key, entry);
  }

  entry.text = clipText(`${entry.text}${text}`, 1600);
  entry.span.textContent = entry.text;
  entry.updatedAt = now;
  entry.finished = Boolean(finished);
  elements.transcriptLog.scrollTop = elements.transcriptLog.scrollHeight;
}

function clearCaptions() {
  resetCaptionBucket("source");
  resetCaptionBucket("output");
  state.transcript.clear();
  elements.transcriptLog.innerHTML = "";
  document.body.classList.remove("has-captions");
  state.activeSourceCode = "";
  state.counterpartLanguage = state.fallbackLanguage;
  state.activeTargetCode = state.counterpartLanguage.code;
  updateCaptionLabels();
  elements.detectedLanguage.textContent = "Auto";
  renderCaptions();
}

function updateNoiseStatus(noiseState) {
  if (!elements.noiseStatus) return;
  elements.noiseStatus.textContent = noiseState.active ? "Voice" : "Quiet";
}

function updateSessionStats() {
  const open = state.sessions.filter((session) => session.isOpen).length;
  elements.sessionStats.textContent = `${open}/${state.sessions.length}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

class GeminiTranslateSession {
  constructor({ target, index, onEvent }) {
    this.target = target;
    this.index = index;
    this.onEvent = onEvent;
    this.socket = null;
    this.isOpen = false;
    this.isReady = false;
    this.closed = false;
    this.manualClose = false;
    this.readyResolve = null;
    this.readyReject = null;
    this.errorReported = false;
    this.closeHandled = false;
    this.createdAt = Date.now();
    this.lastDrainAt = Date.now();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = getLiveSocketUrl(this.target.code);
      const socket = new WebSocket(url);
      this.socket = socket;

      const timeout = window.setTimeout(() => {
        fail(new Error(`连接 ${this.target.name} 翻译通道超时`));
        socket.close();
      }, 12000);

      const cleanup = () => {
        window.clearTimeout(timeout);
        this.readyResolve = null;
        this.readyReject = null;
      };

      const succeed = () => {
        cleanup();
        resolve();
      };

      const fail = (error) => {
        cleanup();
        reject(error);
      };

      this.readyResolve = succeed;
      this.readyReject = fail;

      socket.onopen = () => {
        this.isOpen = true;
        this.sendSetup();
      };

      socket.onmessage = (event) => this.handleMessage(event);
      socket.onerror = () => {
        const error = new Error(`${this.target.name} 通道连接错误`);
        this.emitError(error.message);
        if (!this.isReady) this.readyReject?.(error);
      };
      socket.onclose = (event) => this.handleClose(event);
    });
  }

  handleClose(event) {
    if (this.closeHandled) return;
    this.closeHandled = true;
    const wasReady = this.isReady;
    this.isOpen = false;
    this.isReady = false;
    this.closed = true;
    const reason = String(event?.reason || "").slice(0, 140);
    if (!this.manualClose) {
      // Keep the upstream close reason visible in metrics; "quota" vs
      // "idle" vs network tells completely different stories.
      postMetric("channel_closed", {
        targetLanguage: this.target.code,
        closeCode: event?.code || 0,
        closeReason: reason,
        wasReady,
      });
    }
    if (!this.manualClose && !wasReady) {
      this.readyReject?.(new Error(`${this.target.name} 通道已关闭${reason ? `：${reason}` : ""}`));
    }
    updateSessionStats();
    if (!this.manualClose) {
      this.onEvent({ type: "closed", target: this.target, sessionIndex: this.index, session: this });
    }
  }

  emitError(message) {
    if (this.manualClose || this.errorReported) return;
    this.errorReported = true;
    this.onEvent({ type: "error", message, target: this.target, sessionIndex: this.index });
  }

  sendSetup() {
    this.send({
      setup: {
        model: `models/${LIVE_MODEL}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });
  }

  async handleMessage(event) {
    const text = event.data instanceof Blob ? await event.data.text() : event.data;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }

    if (data.setupComplete) {
      this.isReady = true;
      this.onEvent({
        type: "ready",
        target: this.target,
        sessionIndex: this.index,
        latencyMs: Date.now() - this.createdAt,
      });
      this.readyResolve?.();
      return;
    }

    if (data.error) {
      const message = data.error.message || "Gemini Live error";
      this.emitError(message);
      this.readyReject?.(new Error(message));
      return;
    }

    if (data.goAway) {
      this.onEvent({ type: "goAway", target: this.target, sessionIndex: this.index, session: this });
      return;
    }

    const content = data.serverContent || {};
    const inputTranscription = content.inputTranscription || data.inputTranscription;
    const outputTranscription = content.outputTranscription || data.outputTranscription;

    if (inputTranscription?.text) {
      this.onEvent({
        type: "input",
        text: inputTranscription.text,
        finished: Boolean(inputTranscription.finished),
        languageCode: inputTranscription.languageCode || "",
        target: this.target,
        sessionIndex: this.index,
      });
    }

    if (outputTranscription?.text) {
      this.onEvent({
        type: "output",
        text: outputTranscription.text,
        finished: Boolean(outputTranscription.finished),
        languageCode: outputTranscription.languageCode || "",
        target: this.target,
        sessionIndex: this.index,
      });
    }

    const parts = content.modelTurn?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        this.onEvent({ type: "audio", data: part.inlineData.data, target: this.target, sessionIndex: this.index });
      }
    }

    if (content.interrupted) this.onEvent({ type: "interrupted", target: this.target, sessionIndex: this.index });
  }

  sendAudio(base64Audio) {
    if (!this.isReady) return;
    const readyState = this.socket?.readyState;
    // A close handshake can stall for up to a minute behind multi-hop
    // proxies; Chrome only fires onclose after its timeout. For us a
    // CLOSING socket is already dead - handle it now, not in 60s.
    if (readyState === WebSocket.CLOSING || readyState === WebSocket.CLOSED) {
      this.handleClose({ code: 1006, reason: "close handshake stalled" });
      return;
    }
    const buffered = this.socket?.bufferedAmount || 0;
    const now = Date.now();
    if (buffered < 16384) this.lastDrainAt = now;
    // Zombie-socket watchdog: after mobile network transitions the socket can
    // stay "open" while nothing drains, so the model goes deaf without any
    // error event. Force-close so the reconnect path revives the channel.
    if (now - this.lastDrainAt > 6000) {
      try {
        this.socket?.close();
      } catch {
        // Already closing.
      }
      return;
    }
    // Backpressure guard: on slow uplinks the buffer grows unbounded and the
    // connection eventually dies. Dropping frames beyond ~2s of backlog keeps
    // the channel alive; the model tolerates gaps.
    if (buffered > 131072) return;
    this.send({
      realtimeInput: {
        audio: {
          data: base64Audio,
          mimeType: `audio/pcm;rate=${MIC_SAMPLE_RATE}`,
        },
      },
    });
  }

  send(data) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data));
    }
  }

  close() {
    this.manualClose = true;
    this.socket?.close();
    this.socket = null;
    this.isOpen = false;
    this.isReady = false;
    this.closed = true;
  }
}

class MicrophoneStreamer {
  // Base RMS a captured frame must reach, while translated audio is playing,
  // to count as the user talking over the playback rather than speaker echo.
  // The effective threshold adapts upward when the measured echo is loud.
  static BARGE_IN_RMS = 0.03;

  constructor(onAudio, onNoiseState, options = {}) {
    this.onAudio = onAudio;
    this.onNoiseState = onNoiseState;
    this.isPlaybackActive = options.isPlaybackActive || null;
    this.onBargeIn = options.onBargeIn || null;
    this.stream = null;
    this.context = null;
    this.worklet = null;
    this.scriptProcessor = null;
    this.source = null;
    this.highpass = null;
    this.muted = false;
    this.inputSampleRate = MIC_SAMPLE_RATE;
    this.voiceActive = false;
    this.lastNoiseEmitAt = 0;
    this.preRoll = [];
    this.loudFrames = 0;
    this.bargeInUntil = 0;
    this.bargeInActive = false;
    this.gatedMs = 0;
    this.echoFloor = 0;
    this.wasPlaying = false;
    this.lastTalkAt = 0;
    this.talkStreak = 0;
    this.onFrame = options.onFrame || null;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("此浏览器不支持麦克风 · Mic not supported in this browser");
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: { ideal: 1 },
          sampleRate: { ideal: MIC_SAMPLE_RATE },
        },
      });
    } catch (error) {
      const name = error?.name || "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        throw new Error("麦克风权限被拒绝，请在浏览器设置里允许后重试 · Mic access denied");
      }
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        throw new Error("没有检测到麦克风 · No microphone found");
      }
      throw error;
    }

    this.context = createAudioContext({ sampleRate: MIC_SAMPLE_RATE, latencyHint: "interactive" });
    this.inputSampleRate = this.context.sampleRate;

    this.source = this.context.createMediaStreamSource(this.stream);
    this.highpass = this.context.createBiquadFilter();
    this.highpass.type = "highpass";
    this.highpass.frequency.value = 100;
    this.highpass.Q.value = 0.7;

    const handleSamples = (data) => {
      if (this.muted) return;
      const samples = MicrophoneStreamer.resampleToMicRate(data, this.inputSampleRate);
      const rms = this.trackVoiceLevel(samples);
      const playing = this.isPlaybackActive?.() === true;
      const now = Date.now();

      if (playing) {
        // TTS is on the speaker and (in gated environments) the mic mostly
        // hears that speech back. Detect the user talking OVER it with an
        // adaptive threshold; the consecutive-playback controller pauses
        // playback almost immediately, restoring full-duplex capture.
        if (!this.wasPlaying) {
          // The speaker output lags dispatch by 100-300ms; start with a
          // pessimistic floor and give the EMA a warmup window so the TTS's
          // own onset echo cannot fake a barge-in and pause the playback.
          this.echoFloor = Math.max(rms, 0.05);
          this.playStartAt = now;
        }
        this.wasPlaying = true;
        this.talkStreak = 0;

        const inWarmup = now - (this.playStartAt || 0) < 350;
        const threshold = Math.max(MicrophoneStreamer.BARGE_IN_RMS, this.echoFloor * 1.8);
        if (inWarmup) {
          this.loudFrames = 0;
        } else {
          this.loudFrames = rms >= threshold ? this.loudFrames + 1 : Math.max(0, this.loudFrames - 1);
        }
        if (this.loudFrames >= 2) this.bargeInUntil = now + 900;

        if (now > this.bargeInUntil) {
          this.setBargeIn(false);
          // Frames treated as echo also teach us how loud the echo is.
          this.echoFloor = this.echoFloor * 0.9 + rms * 0.1;
          this.preRoll.push(samples);
          if (this.preRoll.length > 25) this.preRoll.shift();
          this.gatedMs += (samples.length / MIC_SAMPLE_RATE) * 1000;
          this.onFrame?.(this.lastTalkAt);
          diag.frame(rms, true, true);
          return;
        }

        if (!this.bargeInActive) {
          diag.log("bargein", `rms=${rms.toFixed(3)} thr=${Math.max(MicrophoneStreamer.BARGE_IN_RMS, this.echoFloor * 1.8).toFixed(3)} floor=${this.echoFloor.toFixed(3)}`);
        }
        this.setBargeIn(true);
        this.lastTalkAt = now;
        if (this.preRoll.length) {
          const buffered = this.preRoll;
          this.preRoll = [];
          for (const chunk of buffered) this.emitFrame(chunk);
        }
      } else {
        this.wasPlaying = false;
        this.loudFrames = 0;
        this.bargeInUntil = 0;
        this.preRoll = [];
        this.setBargeIn(false);
        // "User is talking" needs two consecutive speech-level frames -
        // AGC-amplified room noise hovering near the floor must not stall
        // the held-playback dispatcher.
        if (rms > (this.talkStreak > 0 ? 0.018 : 0.028)) {
          this.talkStreak += 1;
          if (this.talkStreak >= 2) this.lastTalkAt = now;
        } else {
          this.talkStreak = 0;
        }
      }

      this.emitFrame(samples);
      this.onFrame?.(this.lastTalkAt);
      diag.frame(rms, false, playing);
    };

    this.source.connect(this.highpass);

    if (this.context.audioWorklet && window.AudioWorkletNode) {
      await this.context.audioWorklet.addModule("/audio-worklets/capture.worklet.js");
      this.worklet = new AudioWorkletNode(this.context, "audio-capture-processor");
      this.worklet.port.onmessage = (event) => handleSamples(event.data);
      this.highpass.connect(this.worklet);
      return this.context.resume();
    }

    this.scriptProcessor = this.context.createScriptProcessor(1024, 1, 1);
    this.scriptProcessor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      handleSamples(new Float32Array(input));
      event.outputBuffer.getChannelData(0).fill(0);
    };
    this.highpass.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.context.destination);
    await this.context.resume();
  }

  static float32ToPCM16(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Array.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, float32Array[i]));
      const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(i * 2, value, true);
    }
    return buffer;
  }

  static resampleToMicRate(float32Array, inputSampleRate) {
    if (inputSampleRate === MIC_SAMPLE_RATE) return float32Array;

    const ratio = inputSampleRate / MIC_SAMPLE_RATE;
    const outputLength = Math.max(1, Math.round(float32Array.length / ratio));
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i += 1) {
      const sourceIndex = i * ratio;
      const leftIndex = Math.floor(sourceIndex);
      const rightIndex = Math.min(leftIndex + 1, float32Array.length - 1);
      const fraction = sourceIndex - leftIndex;
      output[i] = float32Array[leftIndex] * (1 - fraction) + float32Array[rightIndex] * fraction;
    }

    return output;
  }

  emitFrame(samples) {
    const pcm = MicrophoneStreamer.float32ToPCM16(samples);
    this.onAudio(arrayBufferToBase64(pcm));
  }

  setBargeIn(active) {
    if (active === this.bargeInActive) return;
    this.bargeInActive = active;
    this.onBargeIn?.(active);
  }

  trackVoiceLevel(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / Math.max(1, samples.length));
    const active = this.voiceActive ? rms > 0.008 : rms > 0.015;
    const now = Date.now();
    if (active !== this.voiceActive || now - this.lastNoiseEmitAt >= 300) {
      this.voiceActive = active;
      this.lastNoiseEmitAt = now;
      this.onNoiseState?.({ active, rms });
    }
    return rms;
  }

  setMuted(muted) {
    this.muted = muted;
    if (muted && this.voiceActive) {
      this.voiceActive = false;
      this.onNoiseState?.({ active: false, rms: 0 });
    }
  }

  stop() {
    this.worklet?.disconnect();
    this.worklet?.port.close();
    this.scriptProcessor?.disconnect();
    this.highpass?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.context?.close();
    this.worklet = null;
    this.scriptProcessor = null;
    this.highpass = null;
    this.source = null;
    this.stream = null;
    this.context = null;
    this.voiceActive = false;
    this.preRoll = [];
    this.loudFrames = 0;
    this.bargeInUntil = 0;
    this.bargeInActive = false;
  }
}

class AudioPlayer {
  constructor() {
    this.context = null;
    this.worklet = null;
    this.gain = null;
    this.sources = new Set();
    this.fallbackPlayTime = 0;
    this.inputSampleRate = 24000;
    this.playbackEndsAt = 0;
    this.volume = 0.92;
    this.ducked = false;
    this.pendingChunks = [];
    this.flushTimer = null;
    // Consecutive-interpretation mode (speakerphone environments): hold TTS
    // in a queue while the user is talking, speak during their pauses, and
    // pause again the moment they resume. Full-duplex capture, no swallowed
    // speech, no echo loop.
    this.consecutive = ECHO_GATE_ENABLED;
    this.holdQueue = [];
    this.dispatchOn = false;
    this.dispatched = [];
  }

  // Called ~25x/s from the mic with the timestamp of the user's last speech.
  pump(lastTalkAt) {
    if (!this.consecutive) return;
    const now = Date.now();
    const idleMs = now - (lastTalkAt || 0);

    if (idleMs < 250) {
      // User is talking: pause playback (droppable worklet buffer is small);
      // the held queue survives and resumes later.
      if (this.isPlaying()) this.pausePlayback();
      if (this.dispatchOn) diag.log("dispatch_off", `q=${this.holdQueue.length}`);
      this.dispatchOn = false;
      return;
    }

    if (idleMs > 450 && !this.dispatchOn && this.holdQueue.length) {
      diag.log("dispatch_on", `q=${this.holdQueue.length} idle=${Math.round(idleMs)}`);
    }
    if (idleMs > 450) this.dispatchOn = true;
    if (!this.dispatchOn || !this.holdQueue.length) return;

    // Keep a modest amount in flight; anything unplayed at pause time is
    // re-queued, so the lookahead costs nothing on interruption.
    if (this.playbackEndsAt - now < 700) {
      const chunk = this.holdQueue.shift();
      this.playThrough(chunk);
    }
  }

  pausePlayback() {
    // Re-queue everything that has not finished SOUNDING yet - including
    // chunks whose bookkeeping ended moments ago but whose audio is still
    // draining through the output pipeline. Pausing must never eat the tail.
    const now = Date.now();
    const unplayed = this.dispatched.filter((entry) => entry.endAt > now - 150).map((entry) => entry.b64);
    if (unplayed.length) this.holdQueue.unshift(...unplayed);
    diag.log("pause", `requeued=${unplayed.length} q=${this.holdQueue.length} endsIn=${Math.round(this.playbackEndsAt - now)}`);
    diag.flush("pause");
    postMetric("tts_pause", { requeued: unplayed.length, queued: this.holdQueue.length });
    this.dispatched = [];

    this.worklet?.port.postMessage("interrupt");
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.sources.clear();
    this.fallbackPlayTime = this.context?.currentTime || 0;
    this.playbackEndsAt = 0;
  }

  isPlaying() {
    return Date.now() < this.playbackEndsAt;
  }

  // The speaker keeps sounding ~300ms past our bookkeeping (decode + worklet
  // + output latency); treat that tail as "audible" so the mic gate does not
  // mistake our own fading TTS for the user talking.
  isAudible() {
    return this.playbackEndsAt > 0 && Date.now() < this.playbackEndsAt + 350;
  }

  duck(active) {
    if (this.ducked === active) return;
    this.ducked = active;
    this.applyVolume();
  }

  applyVolume() {
    if (!this.gain) return;
    this.gain.gain.value = Math.max(0, Math.min(1, this.volume)) * (this.ducked ? 0.25 : 1);
  }

  async init() {
    if (this.context) return;
    this.context = createAudioContext({ sampleRate: 24000, latencyHint: "interactive" });
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
    this.applyVolume();

    if (this.context.audioWorklet && window.AudioWorkletNode) {
      await this.context.audioWorklet.addModule("/audio-worklets/playback.worklet.js");
      this.worklet = new AudioWorkletNode(this.context, "pcm-playback-processor");
      this.worklet.connect(this.gain);
    }

    await this.context.resume();
  }

  play(base64Audio) {
    if (this.consecutive) {
      this.holdQueue.push(base64Audio);
      diag.sec.arrivals += 1;
      if (this.holdQueue.length > 400) this.holdQueue.shift();
      return;
    }
    const durationMs = AudioPlayer.getBase64PcmDurationMs(base64Audio);
    const startingFresh = !this.isPlaying() && !this.flushTimer;
    this.playbackEndsAt = Math.max(this.playbackEndsAt, Date.now()) + durationMs;
    this.pendingChunks.push(base64Audio);
    if (this.flushTimer) return;
    // Small jitter buffer at utterance start so network hiccups do not
    // fragment the speech; mid-stream chunks flush immediately.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPending();
    }, startingFresh ? 140 : 0);
  }

  playThrough(base64Audio) {
    const durationMs = AudioPlayer.getBase64PcmDurationMs(base64Audio);
    // A freshly started pipeline takes ~250ms (decode + worklet + output
    // hardware) before the first sample leaves the speaker; bake that into
    // the bookkeeping so chunk end times track physical audibility.
    const base = Math.max(this.playbackEndsAt, Date.now() + (this.isPlaying() ? 0 : 250));
    this.playbackEndsAt = base + durationMs;
    this.dispatched.push({ b64: base64Audio, endAt: this.playbackEndsAt });
    if (this.dispatched.length > 64) this.dispatched.shift();
    this.playChunk(base64Audio).catch((error) => console.error("playback chunk failed", error));
  }

  async flushPending() {
    const chunks = this.pendingChunks;
    this.pendingChunks = [];
    for (const chunk of chunks) {
      try {
        await this.playChunk(chunk);
      } catch (error) {
        console.error("playback chunk failed", error);
      }
    }
  }

  async playChunk(base64Audio) {
    await this.init();
    if (this.context.state === "suspended") await this.context.resume();
    const bytes = base64ToBytes(base64Audio);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = view.getInt16(i * 2, true) / 32768;
    }
    const playbackSamples = AudioPlayer.resample(samples, this.inputSampleRate, this.context.sampleRate);
    if (this.worklet) {
      this.worklet.port.postMessage(playbackSamples, [playbackSamples.buffer]);
      return;
    }

    this.playWithBuffer(playbackSamples);
  }

  playWithBuffer(samples) {
    const buffer = this.context.createBuffer(1, samples.length, this.context.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.onended = () => this.sources.delete(source);
    const startAt = Math.max(this.context.currentTime + 0.02, this.fallbackPlayTime || 0);
    source.start(startAt);
    this.fallbackPlayTime = startAt + buffer.duration;
    this.sources.add(source);
  }

  static getBase64PcmDurationMs(base64Audio) {
    const byteLength = Math.floor((String(base64Audio || "").length * 3) / 4);
    return (byteLength / 2 / 24000) * 1000;
  }

  static resample(samples, fromRate, toRate) {
    if (fromRate === toRate) return samples;

    const ratio = fromRate / toRate;
    const outputLength = Math.max(1, Math.round(samples.length / ratio));
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i += 1) {
      const sourceIndex = i * ratio;
      const leftIndex = Math.floor(sourceIndex);
      const rightIndex = Math.min(leftIndex + 1, samples.length - 1);
      const fraction = sourceIndex - leftIndex;
      output[i] = samples[leftIndex] * (1 - fraction) + samples[rightIndex] * fraction;
    }

    return output;
  }

  setVolume(volume) {
    this.volume = volume;
    this.applyVolume();
  }

  interrupt() {
    this.worklet?.port.postMessage("interrupt");
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.sources.clear();
    this.fallbackPlayTime = this.context?.currentTime || 0;
    this.playbackEndsAt = 0;
    this.pendingChunks = [];
    this.holdQueue = [];
    this.dispatchOn = false;
    this.dispatched = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

function setMode(mode, options = {}) {
  const next = mode === "text" ? "text" : "conversation";
  if (!options.force && next === state.mode) return;
  state.mode = next;
  try {
    localStorage.setItem(SETTINGS_KEYS.mode, next);
  } catch {
    // Ignore blocked storage.
  }

  // Captions-only mode keeps the live session running; just silence the
  // translated speech that is currently playing.
  if (next === "text") state.player?.interrupt();

  document.body.classList.toggle("text-mode", next === "text");
  elements.modeConversationBtn.classList.toggle("active", next === "conversation");
  elements.modeTextBtn.classList.toggle("active", next === "text");
  elements.typeConsole.hidden = next !== "text";
}

// Correction flow: tap a recognized line, fix it, re-translate via the
// text model. The live session keeps running untouched.
const editState = { originalText: null };

function inferSourceLanguage(text) {
  const value = String(text || "");
  if (/[\u3040-\u30ff]/.test(value)) return "ja";
  if (/[\uac00-\ud7af]/.test(value)) return "ko";
  if (/[\u4e00-\u9fff]/.test(value)) return state.primaryLanguage.code;
  if (/[A-Za-z]/.test(value)) {
    return sameLanguage(state.counterpartLanguage.code, "zh") ? "en" : state.counterpartLanguage.code;
  }
  return "";
}

function openEditSheet(text) {
  if (typeof closeTransSheet === "function") closeTransSheet();
  editState.originalText = text;
  elements.editSheetInput.value = text;
  elements.editSheetConfirm.textContent = "重新翻译";
  elements.editSheet.hidden = false;
  elements.editSheetInput.focus();
}

function closeEditSheet() {
  elements.editSheet.hidden = true;
  editState.originalText = null;
}

async function confirmEditSheet() {
  const original = editState.originalText;
  const edited = elements.editSheetInput.value.trim();
  if (!edited) return;
  if (edited === String(original || "").trim()) {
    closeEditSheet();
    return;
  }

  const button = elements.editSheetConfirm;
  button.disabled = true;
  button.textContent = "…";

  try {
    const sourceCode = inferSourceLanguage(edited) || state.primaryLanguage.code;
    const target = chooseTargetForSource(sourceCode);
    const response = await fetch("/api/translate-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: edited, targetLanguageCode: target.code }),
    });
    if (!response.ok) throw new Error(`correction translate failed: ${response.status}`);
    const data = await response.json();

    const sourceBucket = state.captions.source;
    const index = sourceBucket.segments.map((segment) => segment.text).lastIndexOf(original);
    if (index >= 0) sourceBucket.segments[index] = { ...sourceBucket.segments[index], text: edited };
    else sourceBucket.segments.push({ text: edited, lang: normalizeLanguageCode(sourceCode) });

    const outputBucket = state.captions.output;
    outputBucket.segments.push({ text: `✎ ${String(data.translation || "").trim()}`, lang: target.code });
    logSessionEntry("output", `✎ ${String(data.translation || "").trim()}`, target.code);
    if (outputBucket.segments.length > 120) outputBucket.segments.splice(0, outputBucket.segments.length - 120);
    outputBucket.updatedAt = Date.now();
    document.body.classList.add("has-captions");

    renderCaptions();
    postMetric("correction", { targetLanguage: target.code });
    closeEditSheet();
  } catch (error) {
    console.error(error);
    recordMetricError(error, { stage: "correction" });
    button.textContent = "重试";
  } finally {
    button.disabled = false;
  }
}

elements.sourceCaption.addEventListener("click", (event) => {
  const line = event.target.closest(".caption-line.editable-line");
  if (!line) return;
  openEditSheet(line.textContent);
});
elements.editSheetCancel.addEventListener("click", closeEditSheet);
elements.editSheetConfirm.addEventListener("click", confirmEditSheet);

// ---- Session history (localStorage) ----
const HISTORY_KEY = "liveTranslate.history";
const sessionLog = { startedAt: 0, entries: [] };
let historyOpenSessionId = null;

function logSessionEntry(kind, text, lang) {
  const value = String(text || "").trim();
  if (!value) return;
  if (!sessionLog.startedAt) sessionLog.startedAt = Date.now();
  sessionLog.entries.push({ k: kind === "output" ? "o" : "s", t: value, l: lang || "", at: Date.now() });
  if (sessionLog.entries.length > 500) sessionLog.entries.splice(0, sessionLog.entries.length - 500);
  // Cloud copy for debugging (user-approved): lets transcripts be lined up
  // against the audio trace when diagnosing swallowed words.
  postMetric("transcript_segment", { build: APP_BUILD, kind, lang: lang || "", content: value });
}

function readHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeHistory(sessions) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(sessions.slice(0, 30)));
  } catch {
    // Storage full or blocked - drop oldest and retry once.
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(sessions.slice(0, 10)));
    } catch {
      // Give up quietly.
    }
  }
}

function flushSessionToHistory() {
  if (!sessionLog.entries.length) return;
  const sessions = readHistory();
  sessions.unshift({
    id: `h-${sessionLog.startedAt}`,
    startedAt: sessionLog.startedAt,
    endedAt: Date.now(),
    pair: `${state.primaryLanguage.name} ⇄ ${state.counterpartLanguage.name}`,
    entries: sessionLog.entries,
  });
  writeHistory(sessions);
  sessionLog.startedAt = 0;
  sessionLog.entries = [];
}

function formatHistoryText(session) {
  const started = new Date(session.startedAt);
  const header = `Live Translate · ${started.toLocaleString()} · ${session.pair}`;
  const lines = session.entries.map((entry) => `${entry.k === "o" ? "译" : "原"}｜${entry.t}`);
  return [header, "", ...lines].join("\n");
}

function renderHistoryList() {
  const sessions = readHistory();
  elements.historyDetail.hidden = true;
  elements.historyList.hidden = false;
  elements.historyTitle.textContent = "会话记录 · HISTORY";
  elements.historyList.replaceChildren();

  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "还没有会话记录。完成一次翻译后，这里会自动保存文字记录。";
    elements.historyList.append(empty);
    return;
  }

  for (const session of sessions) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "history-card";
    const meta = document.createElement("span");
    meta.className = "history-card-meta";
    const started = new Date(session.startedAt);
    meta.textContent = `${started.toLocaleDateString()} ${started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${session.pair} · ${session.entries.length} 条`;
    const preview = document.createElement("span");
    preview.className = "history-card-preview";
    preview.textContent = session.entries.slice(0, 2).map((entry) => entry.t).join(" / ") || "(空)";
    card.append(meta, preview);
    card.addEventListener("click", () => renderHistoryDetail(session.id));
    elements.historyList.append(card);
  }
}

function renderHistoryDetail(sessionId) {
  const session = readHistory().find((item) => item.id === sessionId);
  if (!session) return;
  historyOpenSessionId = sessionId;
  elements.historyList.hidden = true;
  elements.historyDetail.hidden = false;
  const started = new Date(session.startedAt);
  elements.historyTitle.textContent = `${started.toLocaleDateString()} · ${session.pair}`;
  elements.historyEntries.replaceChildren();
  for (const entry of session.entries) {
    const row = document.createElement("div");
    row.className = `history-entry ${entry.k === "o" ? "output" : "source"}`;
    const tag = document.createElement("span");
    tag.className = "history-entry-tag";
    tag.textContent = entry.k === "o" ? `译 · ${getLanguageName(entry.l)}` : `原 · ${getLanguageName(entry.l)}`;
    const text = document.createElement("span");
    text.className = "history-entry-text";
    text.textContent = entry.t;
    row.append(tag, text);
    elements.historyEntries.append(row);
  }
}

function openHistoryPanel() {
  flushSessionToHistory();
  renderHistoryList();
  elements.historyPanel.hidden = false;
}

function closeHistoryPanel() {
  if (!elements.historyDetail.hidden) {
    historyOpenSessionId = null;
    renderHistoryList();
    return;
  }
  elements.historyPanel.hidden = true;
}

function currentHistorySession() {
  return readHistory().find((item) => item.id === historyOpenSessionId) || null;
}

elements.historyBtn.addEventListener("click", openHistoryPanel);
elements.historyCloseBtn.addEventListener("click", closeHistoryPanel);

elements.historyCopyBtn.addEventListener("click", async () => {
  const session = currentHistorySession();
  if (!session) return;
  try {
    await navigator.clipboard.writeText(formatHistoryText(session));
    elements.historyCopyBtn.textContent = "已复制";
    setTimeout(() => (elements.historyCopyBtn.textContent = "复制全文"), 1500);
  } catch {
    elements.historyCopyBtn.textContent = "复制失败";
    setTimeout(() => (elements.historyCopyBtn.textContent = "复制全文"), 1500);
  }
});

elements.historyShareBtn.addEventListener("click", async () => {
  const session = currentHistorySession();
  if (!session) return;
  const text = formatHistoryText(session);
  if (navigator.share) {
    try {
      await navigator.share({ text });
    } catch {
      // User cancelled the share sheet.
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    elements.historyShareBtn.textContent = "已复制";
    setTimeout(() => (elements.historyShareBtn.textContent = "分享"), 1500);
  } catch {
    // Ignore.
  }
});

elements.historyDownloadBtn.addEventListener("click", () => {
  const session = currentHistorySession();
  if (!session) return;
  const blob = new Blob([formatHistoryText(session)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `live-translate-${new Date(session.startedAt).toISOString().slice(0, 16).replace(/[T:]/g, "-")}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

elements.historyDeleteBtn.addEventListener("click", () => {
  const session = currentHistorySession();
  if (!session) return;
  writeHistory(readHistory().filter((item) => item.id !== session.id));
  historyOpenSessionId = null;
  renderHistoryList();
});

// ---- Photo translation ----
async function fileToJpegBase64(file, maxDim = 1280) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82).split(",")[1];
}

async function handlePhotoTranslation(file) {
  if (!file) return;
  elements.photoBtn.disabled = true;
  elements.photoBtn.textContent = "识别中…";

  try {
    const imageBase64 = await fileToJpegBase64(file);
    const response = await fetch("/api/translate-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64,
        mimeType: "image/jpeg",
        primaryLanguageCode: state.primaryLanguage.code,
        counterpartLanguageCode: state.counterpartLanguage.code,
      }),
    });
    if (!response.ok) throw new Error(`image translate failed: ${response.status}`);
    const data = await response.json();

    if (!data.originalText && !data.translation) {
      elements.photoBtn.textContent = "未识别到文字";
      setTimeout(() => (elements.photoBtn.textContent = "拍照翻译"), 1800);
      return;
    }

    const sourceLang = normalizeLanguageCode(data.sourceLanguageCode) || "";
    const targetLang = normalizeLanguageCode(data.targetLanguageCode) || state.activeTargetCode;
    state.captions.source.segments.push({ text: data.originalText, lang: sourceLang });
    state.captions.output.segments.push({ text: data.translation, lang: targetLang });
    logSessionEntry("source", data.originalText, sourceLang);
    logSessionEntry("output", data.translation, targetLang);
    document.body.classList.add("has-captions");
    renderCaptions();
    postMetric("photo_translate", { targetLanguage: targetLang });
    elements.photoBtn.textContent = "拍照翻译";
  } catch (error) {
    console.error(error);
    recordMetricError(error, { stage: "photo-translate" });
    elements.photoBtn.textContent = "失败，重试";
    setTimeout(() => (elements.photoBtn.textContent = "拍照翻译"), 1800);
  } finally {
    elements.photoBtn.disabled = false;
    elements.photoInput.value = "";
  }
}

elements.photoBtn.addEventListener("click", () => elements.photoInput.click());
elements.photoInput.addEventListener("change", () => handlePhotoTranslation(elements.photoInput.files?.[0]));

// ---- Translation line actions: replay + back-translation ----
const SPEECH_LANG_TAGS = new Map([
  ["zh-Hans", "zh-CN"],
  ["zh-Hant", "zh-TW"],
  ["en", "en-US"],
  ["ja", "ja-JP"],
  ["ko", "ko-KR"],
  ["es", "es-ES"],
  ["fr", "fr-FR"],
  ["de", "de-DE"],
  ["it", "it-IT"],
  ["pt-BR", "pt-BR"],
  ["ru", "ru-RU"],
]);

const transSheetState = { text: "", lang: "" };

function openTransSheet(text, lang) {
  closeEditSheet();
  transSheetState.text = text;
  transSheetState.lang = lang || "";
  // WeChat and most in-app webviews silently break speechSynthesis.
  elements.transSheetReplay.hidden = !window.speechSynthesis || IS_INAPP_WEBVIEW;
  elements.transSheetText.textContent = text;
  elements.transSheetBack.hidden = true;
  elements.transSheetBack.textContent = "";
  elements.transSheetBackBtn.textContent = "回译确认";
  elements.transSheet.hidden = false;
}

function closeTransSheet() {
  elements.transSheet.hidden = true;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    // Ignore.
  }
}

elements.translationCaption.addEventListener("click", (event) => {
  const line = event.target.closest(".caption-line.done-line");
  if (!line) return;
  openTransSheet(line.textContent, line.dataset.lang || "");
});

elements.transSheetClose.addEventListener("click", closeTransSheet);

elements.transSheetReplay.addEventListener("click", () => {
  if (!transSheetState.text || !window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(transSheetState.text.replace(/^✎\s*/, ""));
  utterance.lang = SPEECH_LANG_TAGS.get(transSheetState.lang) || transSheetState.lang || "en-US";
  utterance.rate = 0.95;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
});

elements.transSheetBackBtn.addEventListener("click", async () => {
  const text = transSheetState.text.replace(/^✎\s*/, "");
  if (!text) return;
  const button = elements.transSheetBackBtn;
  button.disabled = true;
  button.textContent = "…";
  try {
    // Translate the translation back into the "other" language of the pair
    // so the speaker can sanity-check what the counterpart actually heard.
    const backTarget = sameLanguage(transSheetState.lang, state.primaryLanguage.code)
      ? state.counterpartLanguage
      : state.primaryLanguage;
    const response = await fetch("/api/translate-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, targetLanguageCode: backTarget.code }),
    });
    if (!response.ok) throw new Error(`back translate failed: ${response.status}`);
    const data = await response.json();
    elements.transSheetBack.textContent = `回译 · ${String(data.translation || "").trim()}`;
    elements.transSheetBack.hidden = false;
    button.textContent = "回译确认";
  } catch (error) {
    console.error(error);
    button.textContent = "重试";
  } finally {
    button.disabled = false;
  }
});

async function submitTypedTranslation() {
  const text = elements.typeInput.value.trim();
  if (!text || elements.typeSendBtn.disabled) return;

  elements.typeSendBtn.disabled = true;
  elements.typeSendBtn.textContent = "…";

  try {
    const sourceCode = inferSourceLanguage(text) || state.primaryLanguage.code;
    const target = chooseTargetForSource(sourceCode);
    const response = await fetch("/api/translate-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, targetLanguageCode: target.code }),
    });
    if (!response.ok) throw new Error(`typed translate failed: ${response.status}`);
    const data = await response.json();

    state.activeSourceCode = normalizeLanguageCode(data.sourceLanguageCode) || normalizeLanguageCode(sourceCode);
    state.activeTargetCode = target.code;
    state.captions.source.segments.push({ text, lang: state.activeSourceCode });
    state.captions.output.segments.push({ text: String(data.translation || "").trim(), lang: target.code });
    logSessionEntry("source", text, state.activeSourceCode);
    logSessionEntry("output", String(data.translation || "").trim(), target.code);
    document.body.classList.add("has-captions");
    updateCaptionLabels();
    renderCaptions();
    elements.typeInput.value = "";
    postMetric("typed_translate", { targetLanguage: target.code });
  } catch (error) {
    console.error(error);
    recordMetricError(error, { stage: "typed-translate" });
    elements.typeSendBtn.textContent = "失败";
    elements.typeInput.placeholder = "翻译失败，请重试 · Failed, try again";
    setTimeout(() => {
      elements.typeSendBtn.textContent = "→";
      elements.typeInput.placeholder = "输入文字翻译 · Type to translate";
    }, 2200);
  } finally {
    elements.typeSendBtn.disabled = false;
    if (elements.typeSendBtn.textContent === "…") elements.typeSendBtn.textContent = "→";
  }
}

elements.typeConsole.addEventListener("submit", (event) => {
  event.preventDefault();
  submitTypedTranslation();
});

// Face-to-face mode: rotate the translation panel 180° so the person across
// the table can read it while the phone lies between the two speakers.
elements.flipBtn.addEventListener("click", () => {
  const flipped = document.body.classList.toggle("flip-view");
  elements.flipBtn.classList.toggle("active", flipped);
  elements.flipBtn.setAttribute("aria-pressed", String(flipped));
  scrollToLatest();
});

function chooseMode(mode) {
  document.body.classList.remove("choose-mode");
  elements.modeChooser.hidden = true;
  setMode(mode, { force: true });
}

elements.modeConversationBtn.addEventListener("click", () => setMode("conversation"));
elements.modeTextBtn.addEventListener("click", () => setMode("text"));
elements.chooseConversation.addEventListener("click", () => chooseMode("conversation"));
elements.chooseText.addEventListener("click", () => chooseMode("text"));

// First visit: ask what the user needs before showing either console.
let savedMode = null;
try {
  savedMode = localStorage.getItem(SETTINGS_KEYS.mode);
} catch {
  savedMode = null;
}

if (savedMode === "conversation" || savedMode === "text") {
  setMode(savedMode, { force: true });
} else {
  setMode("conversation", { force: true });
  document.body.classList.add("choose-mode");
  elements.modeChooser.hidden = false;
  try {
    localStorage.removeItem(SETTINGS_KEYS.mode);
  } catch {
    // Ignore blocked storage.
  }
}

for (const button of document.querySelectorAll("[data-example]")) {
  button.addEventListener("click", () => {
    elements.languagePrompt.value = button.dataset.example;
    resolveLanguages();
  });
}

elements.resolveBtn.addEventListener("click", resolveLanguages);
elements.voiceSetupBtn.addEventListener("click", startSetupSpeechRecognition);
elements.startBtn.addEventListener("click", startInterpreter);
elements.sourceLanguageBtn.addEventListener("change", () => setPrimaryLanguage(elements.sourceLanguageBtn.value));
elements.targetLanguageBtn.addEventListener("change", () => setCounterpartLanguage(elements.targetLanguageBtn.value));
elements.swapBtn.addEventListener("click", swapPrimaryLanguages);
elements.muteBtn.addEventListener("click", toggleMute);
elements.clearBtn.addEventListener("click", clearCaptions);
elements.volume.addEventListener("input", () => state.player?.setVolume(Number(elements.volume.value) / 100));

function resumeAudioContexts() {
  const resumables = [state.player?.context, state.mic?.context].filter((context) => context?.state === "suspended");
  for (const context of resumables) context.resume().catch(() => {});
}

window.addEventListener("pointerdown", resumeAudioContexts, { passive: true });
window.addEventListener("touchend", resumeAudioContexts, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  resumeAudioContexts();
  // iOS Safari kills WebSockets while the page is backgrounded; revive
  // any dead sessions as soon as the user comes back.
  if (state.running) {
    if (!screenWakeLock) acquireWakeLock();
    state.sessions = state.sessions.filter((session) => !session.closed);
    updateSessionStats();
    for (const target of uniqueLanguages([state.primaryLanguage, state.counterpartLanguage])) {
      warmTargetSession(target);
    }
  }
});

window.addEventListener("beforeunload", () => {
  stopInterpreter({ keepStatus: true, beacon: true });
  flushSessionToHistory();
});

// Build the counterpart selector from the full language list.
elements.targetLanguageBtn.replaceChildren(
  ...counterpartLanguages.map((language) => {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = language.name;
    return option;
  }),
);

renderCaptions();
updateReadyState();
setStatus(elements.connectionStatus, "offline", true);
postMetric(
  "page_view",
  {
    screen: getMetricScreen(),
    capabilities: getMetricCapabilities(),
  },
  { keepalive: true },
);

if (!window.isSecureContext) {
  setStatus(elements.connectionStatus, "HTTPS required", true);
}
