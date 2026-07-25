const STRICT_TOTAL_PATCH_FLAG = "__depositStrictTotalPatch";

function strictTotalText(text) {
  const source = normalizeOcrSource(text);
  const lines = source.split(/\r?\n/);
  const rows = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const compact = line.replace(/\s+/g, "");
    const label = findTotalLabel(compact);
    if (!label) continue;

    const windowText = `${textAfterLooseLabel(line, label)} ${lines[index + 1] ?? ""}`;
    for (const amount of extractStrictTotalAmounts(windowText)) {
      rows.push(`总资产 ¥${amount}`);
    }
  }

  return [...new Set(rows)].join("\n");
}

function findTotalLabel(compactLine) {
  return ["总资产", "总金额", "资产总额", "账户总资产", "资产合计", "合计资产", "总市值", "总余额"].find((label) =>
    compactLine.includes(label)
  );
}

function textAfterLooseLabel(line, label) {
  const looseLabel = label.split("").map(escapeRegExp).join("\\s*");
  return line.replace(new RegExp(`^[\\s\\S]*?${looseLabel}`), "");
}

function extractStrictTotalAmounts(text) {
  const clean = normalizeAmountText(removeDateText(text));
  const matches = clean.match(/(?:¥|￥|RMB|CNY)?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?/gi) ?? [];
  return matches
    .filter(isLikelyTotalAmountText)
    .map((value) => Number(value.replace(/[¥￥,\s]|RMB|CNY/gi, "")))
    .filter((amount) => Number.isFinite(amount) && amount >= 1000);
}

function normalizeOcrSource(text) {
  return (typeof text === "string" ? text : "")
    .replace(/[，]/g, ",")
    .replace(/[。]/g, ".")
    .replace(/[￥]/g, "¥")
    .replace(/总资[严广声]/g, "总资产")
    .replace(/总金[颤额頟]/g, "总金额");
}

function normalizeAmountText(text) {
  return normalizeOcrSource(text)
    .replace(/(?<=\d)\s+(?=\d)/g, "")
    .replace(/(\d{1,3})\.(\d{3})(?!\d)/g, "$1,$2");
}

function removeDateText(text) {
  return normalizeOcrSource(text)
    .replace(/\b\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?\b/g, " ")
    .replace(/\b\d{1,2}[-/.月]\d{1,2}日?\b/g, " ");
}

function isLikelyTotalAmountText(value) {
  const raw = String(value).trim();
  const digits = raw.replace(/\D/g, "");
  return /[¥￥]|RMB|CNY/i.test(raw) || raw.includes(",") || /\.\d{1,2}$/.test(raw) || digits.length >= 4;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const patchTimer = setInterval(() => {
  if (!window.Tesseract || window.Tesseract[STRICT_TOTAL_PATCH_FLAG]) return;

  const originalRecognize = window.Tesseract.recognize.bind(window.Tesseract);
  window.Tesseract.recognize = async (...args) => {
    const result = await originalRecognize(...args);
    if (result?.data?.text) {
      result.data.text = strictTotalText(result.data.text);
    }
    return result;
  };

  window.Tesseract[STRICT_TOTAL_PATCH_FLAG] = true;
  clearInterval(patchTimer);
}, 50);
