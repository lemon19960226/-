const OCR_PATCH_FLAG = "__depositDatePatch";

function removeDatesNearTotalLabels(text) {
  if (typeof text !== "string") return text;
  return text.replace(
    /((?:总\s*资\s*产|资\s*产\s*总\s*额|总\s*金\s*额|总\s*余\s*额|总\s*市\s*值)[\s\S]{0,24}?)(?:\d{4}[-/.年])?\d{1,2}[-/.月]\d{1,2}日?/g,
    "$1"
  );
}

const patchTimer = setInterval(() => {
  if (!window.Tesseract || window.Tesseract[OCR_PATCH_FLAG]) return;

  const originalRecognize = window.Tesseract.recognize.bind(window.Tesseract);
  window.Tesseract.recognize = async (...args) => {
    const result = await originalRecognize(...args);
    if (result?.data?.text) {
      result.data.text = removeDatesNearTotalLabels(result.data.text);
    }
    return result;
  };

  window.Tesseract[OCR_PATCH_FLAG] = true;
  clearInterval(patchTimer);
}, 50);
