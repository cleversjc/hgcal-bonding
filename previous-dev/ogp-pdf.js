import { OGP_PARSER, validateManifest } from './ogp.js';

// This parser supports text-based HGCal YOLO grid reports, not arbitrary PDFs or OCR.
// A page without a heading continues the preceding module in the SAME document.
export function parseCaptionItems(items, viewport, previousModule) {
  const content = items.filter(item => typeof item.str === 'string');
  const headings = content.filter(item => /HGCal\s+YOLO\s+Leakage\s+Report/i.test(item.str));
  const modules = [...new Set(headings.flatMap(item => item.str.match(/320[A-Z0-9]{12}(?![A-Z0-9])/g) || []))];
  if (modules.length > 1 || (headings.length && modules.length !== 1)) throw new Error('一页的模块标题不唯一或无效。');
  const moduleId = modules[0] || previousModule;
  if (!moduleId) throw new Error('第一页缺少 HGCal YOLO 模块标题，不能推测模块归属。');
  const captions = [];
  for (const item of content) {
    if (!/\bcell\b/i.test(item.str)) continue;
    const match = item.str.trim().match(/^cell\s+(\d+)\s+conf\s+(0(?:\.\d+)?|1(?:\.0+)?)$/i);
    if (!match) throw new Error('检测标签格式不支持，无法可靠匹配图片：' + item.str);
    if (+match[1] < 1 || +match[1] > 198) throw new Error('检测 Cell 超出 C1–C198。');
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    captions.push({ cell: 'C' + Number(match[1]), confidence: +match[2], caption: item.str, x, y });
  }
  if (!captions.length) throw new Error('本页没有可读取的 cell / conf 标签；扫描版或其他版式请先预处理。');
  return { moduleId, inherited: !modules.length, captions };
}

export function imageBoxes(operatorList, OPS, Util, viewport) {
  let matrix = [1, 0, 0, 1, 0, 0];
  const stack = [], boxes = [];
  for (let i = 0; i < operatorList.fnArray.length; i++) {
    const op = operatorList.fnArray[i], args = operatorList.argsArray[i];
    if (op === OPS.save) stack.push([...matrix]);
    else if (op === OPS.restore) { if (!stack.length) throw new Error('PDF 图片变换栈无效。'); matrix = stack.pop(); }
    else if (op === OPS.transform) matrix = Util.transform(matrix, args);
    else if (op === OPS.paintFormXObjectBegin) { stack.push([...matrix]); if (args[0]) matrix = Util.transform(matrix, args[0]); }
    else if (op === OPS.paintFormXObjectEnd) matrix = stack.pop() || matrix;
    else if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject) {
      // Reject rotated/skewed report tiles instead of assigning evidence incorrectly.
      if (Math.abs(matrix[1]) > 0.01 || Math.abs(matrix[2]) > 0.01 || matrix[0] <= 0 || matrix[3] <= 0) throw new Error('暂不支持旋转 / 倾斜的检测图片，请使用预处理流程。');
      const rect = viewport.convertToViewportRectangle([matrix[4], matrix[5], matrix[4] + matrix[0], matrix[5] + matrix[3]]);
      boxes.push({ x: Math.min(rect[0], rect[2]), y: Math.min(rect[1], rect[3]), width: Math.abs(rect[2] - rect[0]), height: Math.abs(rect[3] - rect[1]),
        pixelWidth: op === OPS.paintImageXObject ? args[1] : args[0].width, pixelHeight: op === OPS.paintImageXObject ? args[2] : args[0].height });
    } else if ([OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectRepeat, OPS.paintImageMaskXObjectGroup, OPS.paintInlineImageXObjectGroup].includes(op)) {
      throw new Error('本报告使用了不支持的图片组合，请使用预处理流程。');
    }
  }
  return boxes;
}

export function pairCaptions(captions, boxes) {
  if (captions.length !== boxes.length) throw new Error('检测标签与图片数量不一致；已停止导入，未保存任何数据。');
  const used = new Set();
  return captions.map(caption => {
    const candidates = boxes.map((box, index) => ({ box, index })).filter(({ box }) => caption.x >= box.x - 2 && caption.x < box.x + box.width && caption.y - (box.y + box.height) >= 0 && caption.y - (box.y + box.height) <= 30);
    if (candidates.length !== 1 || used.has(candidates[0].index)) throw new Error('图片和 Cell 标签无法一一对应；已停止导入。');
    used.add(candidates[0].index);
    return { ...caption, box: candidates[0].box };
  });
}

export async function parseOgpPdf(file, onProgress = () => {}, signal) {
  if (file.size > 30 * 1024 * 1024) throw new Error('PDF 超过 30 MB，请先使用预处理流程。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!new TextDecoder().decode(bytes.slice(0, 5)).startsWith('%PDF-')) throw new Error('文件不是有效的 PDF。');
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
  const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  // No eval, embedded scripts, attachments, forms or external image URLs are used.
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true, stopAtErrors: true, isImageDecoderSupported: false, useWasm: false });
  const abort = () => { void task.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  let pdf;
  try {
    pdf = await task.promise;
    if (pdf.numPages > 60) throw new Error('PDF 超过 60 页，请分批预处理。');
    const pages = [], detections = [];
    let previousModule = null, encodedBytes = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      signal?.throwIfAborted();
      onProgress('正在解析第 ' + number + ' / ' + pdf.numPages + ' 页…');
      const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 });
      const parsed = parseCaptionItems((await page.getTextContent()).items, viewport, previousModule);
      const pairs = pairCaptions(parsed.captions, imageBoxes(await page.getOperatorList(), pdfjs.OPS, pdfjs.Util, viewport));
      pages.push({ page: number, moduleId: parsed.moduleId, count: pairs.length, inherited: parsed.inherited });
      previousModule = parsed.moduleId;
      for (let index = 0; index < pairs.length; index++) {
        signal?.throwIfAborted();
        const { box, ...caption } = pairs[index];
        if (box.pixelWidth < 1 || box.pixelHeight < 1 || box.pixelWidth > 4096 || box.pixelHeight > 4096 || Math.abs(box.width / box.height - box.pixelWidth / box.pixelHeight) > 0.03) throw new Error('检测图片尺寸不支持，请先预处理。');
        const scale = box.pixelWidth / box.width, canvas = document.createElement('canvas');
        canvas.width = box.pixelWidth; canvas.height = box.pixelHeight;
        // Render the entire image footprint at native resolution. Page drawing /
        // red overlays remain visible. PNG is lossless; no thumbnail recompression.
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: page.getViewport({ scale }), transform: [1, 0, 0, 1, -box.x * scale, -box.y * scale], background: 'rgb(255,255,255)' }).promise;
        const data = canvas.toDataURL('image/png');
        canvas.width = canvas.height = 0;
        encodedBytes += data.length;
        if (encodedBytes > 80 * 1024 * 1024) throw new Error('原图数据超过手机导入上限，请分批预处理。');
        detections.push({ moduleId: parsed.moduleId, cell: caption.cell, confidence: caption.confidence, caption: caption.caption, page: number, index: index + 1,
          image: { name: 'page-' + number + '-' + (index + 1) + '-' + caption.cell + '.png', data, width: box.pixelWidth, height: box.pixelHeight } });
        if (detections.length > 2000) throw new Error('一次最多导入 2000 条检测。');
      }
      page.cleanup();
    }
    return validateManifest({ app: 'HGCAL OGP Import', schemaVersion: 1, source: { name: file.name, sha256, pageCount: pdf.numPages, parser: OGP_PARSER + '-pdfjs-5.6.205' }, pages, detections });
  } finally {
    signal?.removeEventListener('abort', abort);
    await task.destroy();
  }
}
