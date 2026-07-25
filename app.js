const statusText = {
  not_logged_in: "未登录",
  waiting_confirmation: "等待确认",
  success: "读取成功",
  failed: "读取失败",
  manual_required: "需要手动录入"
};

const typeText = {
  securities: "证券",
  alipay: "支付宝",
  bank: "银行",
  cash: "现金",
  other: "其他"
};

const scopeText = {
  cash: "现金余额",
  total: "总资产",
  invested: "投资资产"
};

const defaultUrls = {
  securities: { appUrl: "", webUrl: "https://www.cs.ecitic.com/newsite/login/index.html" },
  alipay: { appUrl: "alipays://", webUrl: "https://www.alipay.com/x/personal" },
  bank: { appUrl: "", webUrl: "https://pbank.bankcomm.com/personbank/logon.jsp" },
  cash: { appUrl: "", webUrl: "" },
  other: { appUrl: "", webUrl: "" }
};

const LOCAL_STATE_KEY = "retirement-dashboard-local-state-v1";
const LEGACY_SUMMARY_CACHE_KEY = "retirement-dashboard-summary";

const yuan = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY"
});

const wholeYuan = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  maximumFractionDigits: 0
});

let summary = null;
let localState = loadLocalState();

const planningForm = document.querySelector("#planningForm");
const targetAmount = document.querySelector("#targetAmount");
const retirementDate = document.querySelector("#retirementDate");
const homeScreenHint = document.querySelector("#homeScreenHint");
const accountList = document.querySelector("#accountList");
const screenshotUpload = document.querySelector("#screenshotUpload");
const uploadHint = document.querySelector("#uploadHint");
const reviewSection = document.querySelector("#reviewSection");
const reviewList = document.querySelector("#reviewList");
const clearReviews = document.querySelector("#clearReviews");
const confirmReviews = document.querySelector("#confirmReviews");
const dialog = document.querySelector("#accountDialog");
const dialogTitle = document.querySelector("#accountDialogTitle");
const accountForm = document.querySelector("#accountForm");
let reviewItems = [];

registerServiceWorker();

document.querySelector("#addAccount").addEventListener("click", () => openAccountDialog());
document.querySelector("#cancelDialog").addEventListener("click", () => dialog.close());

screenshotUpload.addEventListener("change", async () => {
  const files = Array.from(screenshotUpload.files ?? []);
  if (!files.length) return;

  uploadHint.textContent = `已选择 ${files.length} 张截图，正在识别...`;
  const startIndex = reviewItems.length;
  reviewItems.push(
    ...files.map((file, index) => ({
      id: `${Date.now()}-${startIndex + index}`,
      file,
      fileName: file.name,
      status: "识别中",
      rawText: "",
      candidates: [],
      preferredAmounts: [],
      selectedAmounts: [],
      manualAmount: "",
      accountId: guessAccountId(file.name)
    }))
  );
  renderReviews();

  await Promise.all(reviewItems.slice(startIndex).map(recognizeReviewItem));
  uploadHint.textContent = "请逐张确认金额和账户，然后点确认更新存款。";
  renderReviews();
});

clearReviews.addEventListener("click", () => {
  reviewItems = [];
  screenshotUpload.value = "";
  uploadHint.textContent = "可一次选择多张截图。识别后请确认金额和账户，再更新存款。";
  renderReviews();
});

confirmReviews.addEventListener("click", async () => {
  const totalsByAccount = new Map();
  for (const item of reviewItems) {
    const itemTotal = calculateReviewTotal(item);
    if (!item.accountId || itemTotal <= 0) continue;
    totalsByAccount.set(item.accountId, (totalsByAccount.get(item.accountId) ?? 0) + itemTotal);
  }

  if (!totalsByAccount.size) {
    uploadHint.textContent = "请至少确认一个金额和账户。";
    return;
  }

  confirmReviews.disabled = true;
  try {
    updateBalances(Array.from(totalsByAccount, ([accountId, amount]) => ({ accountId, amount })));
  } finally {
    confirmReviews.disabled = false;
  }
  reviewItems = [];
  screenshotUpload.value = "";
  uploadHint.textContent = "已更新存款。截图和 OCR 原文没有保存。";
  await loadSummary();
  renderReviews();
});

accountForm.elements.type.addEventListener("change", () => {
  applyDefaultUrls(accountForm.elements.type.value);
});

planningForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  saveConfig({
    targetAmount: Number(targetAmount.value),
    retirementDate: retirementDate.value,
    accounts: summary.accounts.map(stripAccountState)
  });
  await loadSummary();
});

accountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(accountForm));
  const accountId = payload.id;
  delete payload.id;

  if (accountId) {
    updateAccount(accountId, payload);
  } else {
    addAccount(payload);
  }

  accountForm.reset();
  dialog.close();
  await loadSummary();
});

async function loadSummary() {
  summary = buildLocalSummary();
  homeScreenHint.hidden = false;
  homeScreenHint.textContent = "纯手机本地版：目标、账户、余额和记录都保存在当前手机浏览器里，不依赖电脑服务。";
  renderSummary(summary);
}

function renderSummary(data) {
  targetAmount.value = String(data.targetAmount);
  retirementDate.value = data.retirementDate ?? "";
  const depositTotal = data.depositTotal ?? data.assetTotal;
  const depositGap = data.depositGap ?? data.assetGap;
  const depositProgress = data.depositProgress ?? data.assetProgress;
  const depositDelta = data.depositDelta ?? data.assetDelta;
  document.querySelector("#depositTotal").textContent = wholeYuan.format(depositTotal);
  document.querySelector("#targetLabel").textContent = yuan.format(data.targetAmount);
  document.querySelector("#depositGap").textContent = yuan.format(depositGap);
  document.querySelector("#depositPercent").textContent = `${Math.round(depositProgress * 100)}%`;
  renderDelta("#depositDelta", depositDelta);
  document.querySelector("#currentRecordAt").textContent = `本次记录：${formatDate(data.currentRecordAt)}`;
  document.querySelector("#previousRecordAt").textContent = `上次更新：${formatDate(data.previousRecordAt)}`;
  renderRetirement(data);
  const progressPercent = Math.round(depositProgress * 100);
  const markerPercent = Math.min(Math.max(progressPercent, 4), 96);
  document.querySelector("#depositProgress").style.width = `${progressPercent}%`;
  document.querySelector("#depositProgressMarker").style.left = `${markerPercent}%`;

  accountList.replaceChildren(...data.accounts.map(renderAccount));
  setOnlineControls();
}

function renderRetirement(data) {
  const days = data.daysUntilRetirement;
  document.querySelector("#retirementDaysCard").textContent = days === null || days === undefined ? "待设置" : `${days} 天`;
}

function renderDelta(selector, value) {
  const element = document.querySelector(selector);
  element.classList.remove("positive", "negative", "flat");

  if (value === null || value === undefined) {
    element.textContent = "暂无";
    return;
  }

  if (value > 0) {
    element.textContent = `增加 ${yuan.format(value)}`;
    element.classList.add("positive");
    return;
  }

  if (value < 0) {
    element.textContent = `减少 ${yuan.format(Math.abs(value))}`;
    element.classList.add("negative");
    return;
  }

  element.textContent = "持平";
  element.classList.add("flat");
}

function setOnlineControls() {
  planningForm.querySelectorAll("input, button").forEach((element) => {
    element.disabled = false;
  });
  screenshotUpload.disabled = false;
  document.querySelector(".upload-button").classList.remove("disabled");
  document.querySelector("#addAccount").disabled = false;
  accountList.querySelectorAll("button, input, select").forEach((element) => {
    element.disabled = false;
  });
}

function formatDate(value) {
  if (!value) return "暂无";
  return new Date(value).toLocaleString("zh-CN");
}

function formatDateOnly(value) {
  if (!value) return "暂无";
  return new Date(`${value}T00:00:00`).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function renderAccount(account) {
  const card = document.createElement("article");
  card.className = "account-card";

  const header = document.createElement("div");
  header.className = "account-header";

  const titleWrap = document.createElement("div");
  const title = document.createElement("div");
  title.className = "account-title";
  title.textContent = account.name;
  const meta = document.createElement("div");
  meta.className = "account-meta";
  meta.textContent = `${typeText[account.type]} · ${scopeText[account.scope]}`;
  titleWrap.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "account-actions";
  actions.append(
    createButton("打开App", "small-button secondary-button", () => openSource(account)),
    createButton("网页", "small-button secondary-button", () => openWeb(account)),
    createButton("设置", "small-button secondary-button", () => openAccountDialog(account)),
    createButton("删除", "small-button danger-button", async () => {
      deleteAccount(account.id);
      await loadSummary();
    })
  );

  header.append(titleWrap, actions);

  const amount = document.createElement("div");
  amount.className = "amount";
  amount.textContent = account.state.amount === null ? "待录入" : yuan.format(account.state.amount);

  const status = document.createElement("p");
  status.className = "status";
  const updated = account.state.updatedAt ? ` · ${new Date(account.state.updatedAt).toLocaleString("zh-CN")}` : "";
  status.textContent = `${statusText[account.state.status]}${updated}。${account.state.message}`;

  const manual = document.createElement("form");
  manual.className = "manual-form";
  manual.innerHTML = `
    <input name="amount" type="number" min="0" step="0.01" inputmode="decimal" placeholder="输入本次余额" />
    <button type="submit">录入</button>
  `;
  manual.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(manual);
    updateBalances([{ accountId: account.id, amount: Number(form.get("amount")) }]);
    await loadSummary();
  });

  card.append(header, amount, status, manual);
  return card;
}

async function recognizeReviewItem(item) {
  try {
    if (!window.Tesseract) {
      item.status = "OCR 未加载，请手动输入金额。";
      return;
    }

    const result = await window.Tesseract.recognize(item.file, "chi_sim+eng", {
      logger: (message) => {
        if (message.status === "loading tesseract core" || message.status === "loading language traineddata") {
          item.status = "正在加载中文识别模型...";
          renderReviews();
        }
        if (message.status === "recognizing text") {
          item.status = `识别中 ${Math.round((message.progress ?? 0) * 100)}%`;
          renderReviews();
        }
      }
    });
    item.rawText = result.data.text;
    const parsed = parseDepositAmountsFromText(item.rawText);
    item.candidates = parsed.amounts ?? [];
    item.preferredAmounts = parsed.preferredAmounts ?? [];
    const visibleAmounts = getVisibleAmounts(item);
    item.selectedAmounts = item.preferredAmounts.length
      ? [...item.preferredAmounts]
      : visibleAmounts.length === 1
        ? [visibleAmounts[0]]
        : [];
    item.status = item.preferredAmounts.length
      ? `优先提取到 ${item.preferredAmounts.length} 个总资产/总金额，请确认。`
      : item.candidates.length
        ? `未定位到总资产，列出 ${item.candidates.length} 个金额供确认。`
      : "未识别到金额，请手动输入。";
  } catch (error) {
    item.status = `识别失败：${error?.message ?? "请手动输入金额"}`;
  }
}

function renderReviews() {
  reviewSection.hidden = reviewItems.length === 0;
  reviewList.replaceChildren(...reviewItems.map(renderReviewCard));
}

function renderReviewCard(item) {
  const card = document.createElement("article");
  card.className = "review-card";

  const top = document.createElement("div");
  top.className = "review-top";
  const title = document.createElement("div");
  title.className = "review-title";
  title.textContent = item.fileName;
  const status = document.createElement("div");
  status.className = "review-status";
  status.textContent = item.status;
  top.append(title, status);

  const candidates = document.createElement("div");
  candidates.className = "candidate-row";
  const visibleAmounts = getVisibleAmounts(item);
  for (const amount of visibleAmounts) {
    const button = createButton(yuan.format(amount), "candidate-button", () => {
      toggleSelectedAmount(item, amount);
      renderReviews();
    });
    if (item.selectedAmounts.includes(amount)) button.classList.add("selected");
    candidates.append(button);
  }
  if (item.preferredAmounts.length) candidates.classList.add("preferred");

  const controls = document.createElement("div");
  controls.className = "review-controls";

  const amountLabel = document.createElement("label");
  amountLabel.textContent = "手动补充金额";
  const amountInput = document.createElement("input");
  amountInput.type = "number";
  amountInput.min = "0";
  amountInput.step = "0.01";
  amountInput.inputMode = "decimal";
  amountInput.value = item.manualAmount;
  amountInput.placeholder = "可选，用于补充";
  amountInput.addEventListener("input", () => {
    item.manualAmount = amountInput.value;
  });
  amountLabel.append(amountInput);

  const accountLabel = document.createElement("label");
  accountLabel.textContent = "归属账户";
  const accountSelect = document.createElement("select");
  for (const account of summary.accounts) {
    const option = document.createElement("option");
    option.value = account.id;
    option.textContent = account.name;
    option.selected = account.id === item.accountId;
    accountSelect.append(option);
  }
  accountSelect.addEventListener("change", () => {
    item.accountId = accountSelect.value;
  });
  accountLabel.append(accountSelect);
  controls.append(amountLabel, accountLabel);

  const subtotal = document.createElement("div");
  subtotal.className = "review-subtotal";
  subtotal.textContent = `本张小计：${yuan.format(calculateReviewTotal(item))}`;

  card.append(top);
  if (visibleAmounts.length) card.append(candidates);
  card.append(controls, subtotal);
  return card;
}

function getVisibleAmounts(item) {
  return item.preferredAmounts.length ? item.preferredAmounts : item.candidates;
}

function toggleSelectedAmount(item, amount) {
  item.selectedAmounts = item.selectedAmounts.includes(amount)
    ? item.selectedAmounts.filter((selected) => selected !== amount)
    : [...item.selectedAmounts, amount];
}

function calculateReviewTotal(item) {
  const candidateTotal = item.selectedAmounts.reduce((total, amount) => total + amount, 0);
  const manualAmount = Number(item.manualAmount);
  return candidateTotal + (Number.isFinite(manualAmount) && manualAmount > 0 ? manualAmount : 0);
}

function guessAccountId(fileName) {
  const name = fileName.toLowerCase();
  const account = summary?.accounts.find((item) => {
    const accountName = item.name.toLowerCase();
    return name.includes(accountName) || name.includes(item.type);
  });
  return account?.id ?? summary?.accounts[0]?.id ?? "";
}

async function openSource(account) {
  markAccountWaiting(account.id);
  summary = buildLocalSummary();
  renderSummary(summary);

  if (account.appUrl) {
    window.location.href = account.appUrl;
  } else if (account.webUrl) {
    window.open(account.webUrl, "_blank", "noopener,noreferrer");
  }
}

function openWeb(account) {
  if (account.webUrl) window.open(account.webUrl, "_blank", "noopener,noreferrer");
}

function openAccountDialog(account = null) {
  accountForm.reset();
  dialogTitle.textContent = account ? "设置账户" : "添加账户";
  accountForm.elements.id.value = account?.id ?? "";
  accountForm.elements.name.value = account?.name ?? "";
  accountForm.elements.type.value = account?.type ?? "securities";
  accountForm.elements.scope.value = account?.scope ?? "total";
  accountForm.elements.appUrl.value = account?.appUrl ?? "";
  accountForm.elements.webUrl.value = account?.webUrl ?? "";
  if (!account) applyDefaultUrls(accountForm.elements.type.value);
  dialog.showModal();
}

function applyDefaultUrls(type) {
  const urls = defaultUrls[type] ?? defaultUrls.other;
  if (!accountForm.elements.appUrl.value) accountForm.elements.appUrl.value = urls.appUrl;
  if (!accountForm.elements.webUrl.value) accountForm.elements.webUrl.value = urls.webUrl;
}

function createButton(label, className, onClick) {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function stripAccountState({ state, shortcutUrl, ...account }) {
  return account;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("service-worker.js").catch(() => {});
}

function loadLocalState() {
  try {
    const raw = localStorage.getItem(LOCAL_STATE_KEY);
    let state = normalizeLocalState(raw ? JSON.parse(raw) : null);
    const legacyState = loadLegacyState();
    if ((!raw && legacyState) || (legacyState && isFreshLocalState(state))) {
      state = legacyState;
    }
    if (!raw || state === legacyState) localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
    return state;
  } catch {
    const state = loadLegacyState() ?? normalizeLocalState(null);
    localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
    return state;
  }
}

function loadLegacyState() {
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_SUMMARY_CACHE_KEY) || "null")?.summary;
    if (!legacy?.accounts?.length) return null;
    const config = normalizeConfig({
      targetAmount: legacy.targetAmount,
      retirementDate: legacy.retirementDate,
      accounts: legacy.accounts.map(stripAccountState)
    });
    const session = Object.fromEntries(
      legacy.accounts.map((account) => [
        account.id,
        {
          status: account.state?.status ?? "manual_required",
          amount: typeof account.state?.amount === "number" ? account.state.amount : null,
          message: account.state?.message ?? "从旧版缓存迁移",
          updatedAt: account.state?.updatedAt ?? null
        }
      ])
    );
    const records = normalizeRecords([
      legacy.previousRecordAt
        ? {
            recordedAt: legacy.previousRecordAt,
            cashTotal: Math.max((legacy.cashTotal ?? 0) - (legacy.cashDelta ?? 0), 0),
            assetTotal: Math.max((legacy.assetTotal ?? legacy.depositTotal ?? 0) - (legacy.assetDelta ?? legacy.depositDelta ?? 0), 0)
          }
        : null,
      legacy.currentRecordAt
        ? {
            recordedAt: legacy.currentRecordAt,
            cashTotal: legacy.cashTotal ?? 0,
            assetTotal: legacy.assetTotal ?? legacy.depositTotal ?? 0
          }
        : null
    ].filter(Boolean));
    return normalizeLocalState({ config, session, records });
  } catch {
    return null;
  }
}

function isFreshLocalState(state) {
  return (
    state.records.length === 0 &&
    Object.values(state.session).every((item) => item.amount === null)
  );
}

function saveLocalState() {
  localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(localState));
}

function normalizeLocalState(input) {
  const fallback = createDefaultLocalState();
  const source = input && typeof input === "object" ? input : {};
  const config = normalizeConfig(source.config, fallback.config);
  const session = reconcileSession(source.session ?? fallback.session, config);
  const records = normalizeRecords(source.records ?? fallback.records);
  return { config, session, records };
}

function createDefaultLocalState() {
  const config = {
    targetAmount: 100000,
    retirementDate: "",
    accounts: [
      createAccount({ name: "中信证券", type: "securities", scope: "total" }),
      createAccount({ name: "支付宝", type: "alipay", scope: "cash" }),
      createAccount({ name: "交通银行", type: "bank", scope: "cash" })
    ]
  };
  return {
    config,
    session: createEmptySession(config),
    records: []
  };
}

function saveConfig(config) {
  localState.config = normalizeConfig(config, localState.config);
  localState.session = reconcileSession(localState.session, localState.config);
  saveLocalState();
}

function addAccount(account) {
  localState.config.accounts.push(normalizeAccount(account));
  localState.config = normalizeConfig(localState.config, localState.config);
  localState.session = reconcileSession(localState.session, localState.config);
  saveLocalState();
}

function updateAccount(accountId, payload) {
  localState.config.accounts = localState.config.accounts.map((account) =>
    account.id === accountId ? normalizeAccount({ ...account, ...payload, id: account.id }) : account
  );
  localState.config = normalizeConfig(localState.config, localState.config);
  localState.session = reconcileSession(localState.session, localState.config);
  saveLocalState();
}

function deleteAccount(accountId) {
  localState.config.accounts = localState.config.accounts.filter((account) => account.id !== accountId);
  delete localState.session[accountId];
  localState.config = normalizeConfig(localState.config, localState.config);
  localState.session = reconcileSession(localState.session, localState.config);
  saveLocalState();
}

function updateBalances(updates) {
  const now = new Date().toISOString();
  for (const update of updates) {
    if (!localState.config.accounts.some((account) => account.id === update.accountId)) continue;
    const amount = toNonNegativeNumber(update.amount, null);
    if (amount === null) continue;
    localState.session[update.accountId] = {
      status: "success",
      amount,
      message: "已在手机本地更新本次余额。",
      updatedAt: now
    };
  }
  recordSnapshot();
  saveLocalState();
}

function markAccountWaiting(accountId) {
  localState.session[accountId] = {
    status: "waiting_confirmation",
    amount: localState.session[accountId]?.amount ?? null,
    message: "已尝试打开 App，请截图后回到看板上传识别或手动录入。",
    updatedAt: new Date().toISOString()
  };
  saveLocalState();
}

function recordSnapshot() {
  const nextSummary = buildLocalSummary();
  localState.records = normalizeRecords([
    ...localState.records,
    {
      recordedAt: new Date().toISOString(),
      cashTotal: nextSummary.cashTotal,
      assetTotal: nextSummary.assetTotal
    }
  ]);
}

function buildLocalSummary() {
  const currentRecord = localState.records.at(-1) ?? null;
  const previousRecord = localState.records.at(-2) ?? null;
  return calculateSummary(localState.config, localState.session, { currentRecord, previousRecord });
}

function normalizeConfig(input, fallback = createDefaultLocalState().config) {
  const source = input && typeof input === "object" ? input : {};
  const targetAmount = toNonNegativeNumber(source.targetAmount, fallback.targetAmount);
  const retirementDate = normalizeDate(source.retirementDate ?? fallback.retirementDate);
  const accounts = Array.isArray(source.accounts) ? source.accounts : fallback.accounts;
  return {
    targetAmount,
    retirementDate,
    accounts: ensureDefaultAccounts(accounts.map(normalizeAccount).filter(Boolean))
  };
}

function createAccount(account) {
  return normalizeAccount({ id: crypto.randomUUID(), ...account });
}

function normalizeAccount(account) {
  const type = Object.hasOwn(typeText, account?.type) ? account.type : "other";
  const scope = Object.hasOwn(scopeText, account?.scope) ? account.scope : (type === "securities" ? "total" : "cash");
  return {
    id: typeof account?.id === "string" && account.id.trim() ? account.id : crypto.randomUUID(),
    name: typeof account?.name === "string" && account.name.trim() ? account.name.trim() : "未命名账户",
    type,
    scope,
    appUrl: normalizeAppUrl(account?.appUrl, defaultUrls[type]?.appUrl ?? ""),
    webUrl: normalizeWebUrl(account?.webUrl ?? account?.loginUrl, defaultUrls[type]?.webUrl ?? ""),
    enabled: account?.enabled !== false
  };
}

function normalizeWebUrl(value, fallback = "") {
  const raw = typeof value === "string" ? value.trim() : "";
  const candidate = raw || fallback;
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function normalizeAppUrl(value, fallback = "") {
  const raw = typeof value === "string" ? value.trim() : "";
  const candidate = raw || fallback;
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    return ["javascript:", "data:", "file:", "vbscript:"].includes(url.protocol.toLowerCase()) ? "" : url.toString();
  } catch {
    return "";
  }
}

function ensureDefaultAccounts(accounts) {
  const next = [...accounts];
  if (!next.some((account) => account.type === "securities")) {
    next.push(createAccount({ name: "中信证券", type: "securities", scope: "total" }));
  }
  if (!next.some((account) => account.type === "alipay")) {
    next.push(createAccount({ name: "支付宝", type: "alipay", scope: "cash" }));
  }
  if (!next.some((account) => account.type === "bank" && account.name === "交通银行")) {
    next.push(createAccount({ name: "交通银行", type: "bank", scope: "cash" }));
  }
  return next;
}

function createEmptySession(config) {
  return Object.fromEntries(
    config.accounts.map((account) => [
      account.id,
      {
        status: "manual_required",
        amount: null,
        message: "等待手动录入或截图识别",
        updatedAt: null
      }
    ])
  );
}

function reconcileSession(session, config) {
  return Object.fromEntries(
    config.accounts.map((account) => [
      account.id,
      session?.[account.id] ?? {
        status: "manual_required",
        amount: null,
        message: "等待手动录入或截图识别",
        updatedAt: null
      }
    ])
  );
}

function calculateSummary(config, session, options = {}) {
  let cashTotal = 0;
  let assetTotal = 0;
  let recordedAccountCount = 0;
  const accounts = config.accounts.map((account) => {
    const state = session[account.id] ?? {};
    const amount = typeof state.amount === "number" && Number.isFinite(state.amount) ? state.amount : null;
    if (account.enabled && amount !== null) {
      recordedAccountCount += 1;
      assetTotal += amount;
      if (account.scope === "cash") cashTotal += amount;
    }
    return {
      ...account,
      shortcutUrl: "",
      state: {
        status: statusText[state.status] ? state.status : "manual_required",
        amount,
        message: typeof state.message === "string" ? state.message : "",
        updatedAt: state.updatedAt ?? null
      }
    };
  });
  const depositTotal = recordedAccountCount > 0 ? assetTotal : options.currentRecord?.assetTotal ?? assetTotal;
  return {
    targetAmount: config.targetAmount,
    retirementDate: config.retirementDate,
    daysUntilRetirement: calculateDaysUntil(config.retirementDate),
    depositTotal,
    cashTotal,
    assetTotal,
    currentRecordAt: options.currentRecord?.recordedAt ?? null,
    previousRecordAt: options.previousRecord?.recordedAt ?? null,
    depositDelta: calculateDelta(depositTotal, options.previousRecord?.assetTotal),
    cashDelta: calculateDelta(cashTotal, options.previousRecord?.cashTotal),
    assetDelta: calculateDelta(assetTotal, options.previousRecord?.assetTotal),
    depositProgress: ratio(depositTotal, config.targetAmount),
    cashProgress: ratio(cashTotal, config.targetAmount),
    assetProgress: ratio(assetTotal, config.targetAmount),
    depositGap: Math.max(config.targetAmount - depositTotal, 0),
    cashGap: Math.max(config.targetAmount - cashTotal, 0),
    assetGap: Math.max(config.targetAmount - assetTotal, 0),
    accounts
  };
}

function normalizeRecords(input) {
  return (Array.isArray(input) ? input : [])
    .map((record) => ({
      recordedAt: typeof record?.recordedAt === "string" ? record.recordedAt : "",
      cashTotal: toNonNegativeNumber(record?.cashTotal, 0),
      assetTotal: toNonNegativeNumber(record?.assetTotal, 0)
    }))
    .filter((record) => record.recordedAt)
    .slice(-20);
}

function parseDepositAmountsFromText(text) {
  const amounts = parseAmountsFromText(text);
  const preferredAmounts = extractPreferredAmounts(text);
  return {
    amounts,
    preferredAmounts,
    status: preferredAmounts.length ? "preferred" : amounts.length === 1 ? "single" : amounts.length > 1 ? "multiple" : "none"
  };
}

function parseAmountsFromText(text) {
  const matches = (typeof text === "string" ? text : "").match(amountPattern()) ?? [];
  return [
    ...new Set(
      matches
        .map((match) => Number(match.replace(/[¥￥,\s]|RMB|CNY/gi, "")))
        .filter((amount) => Number.isFinite(amount) && amount >= 0)
    )
  ];
}

function extractPreferredAmounts(text) {
  const source = typeof text === "string" ? text.replace(/\s+/g, "") : "";
  const keywords = ["总资产", "资产总额", "总金额", "账户总资产", "账户资产", "资产合计", "合计资产", "总市值", "总余额", "存款总额"];
  const amounts = [];
  for (const keyword of keywords) {
    let start = source.indexOf(keyword);
    while (start !== -1) {
      const match = source.slice(start, start + 80).match(amountPattern())?.[0];
      if (match) {
        const amount = Number(match.replace(/[¥￥,\s]|RMB|CNY/gi, ""));
        if (Number.isFinite(amount) && amount >= 0) amounts.push(amount);
      }
      start = source.indexOf(keyword, start + keyword.length);
    }
  }
  return [...new Set(amounts)];
}

function amountPattern() {
  return /(?:¥|￥|RMB|CNY)?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?/gi;
}

function normalizeDate(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return "";
  const [year, month, day] = trimmed.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? trimmed : "";
}

function calculateDaysUntil(dateValue) {
  const normalizedDate = normalizeDate(dateValue);
  if (!normalizedDate) return null;
  const [year, month, day] = normalizedDate.split("-").map(Number);
  const target = new Date(year, month - 1, day);
  const today = new Date();
  const current = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(Math.ceil((target.getTime() - current.getTime()) / 86400000), 0);
}

function toNonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function ratio(value, target) {
  return target ? Math.min(value / target, 1) : 0;
}

function calculateDelta(currentValue, previousValue) {
  return typeof previousValue === "number" && Number.isFinite(previousValue) ? currentValue - previousValue : null;
}

loadSummary();
