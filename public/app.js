/* 浏览器端：采集输入 -> 调用 MuseumLayout 排版核心 -> 渲染预览与打印版 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    title: $('title'),
    body: $('body'),
    widthMm: $('widthMm'),
    heightMm: $('heightMm'),
    form: $('form'),
    stage: $('stage'),
    stageBox: $('stage-box'),
    stageError: $('stage-error'),
    status: $('status'),
    printRoot: $('print-root'),
    btnPrint: $('btn-print'),
    btnSample: $('btn-sample'),
  };

  // 与 CSS 中实际渲染保持一致的字体栈
  const FONT_STACK =
    '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", ' +
    '"Noto Sans CJK SC", "Source Han Sans SC", sans-serif';

  // —— Canvas 字宽测量（带字号缓存）——
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const measureCache = new Map();

  function measure(ch, sizePx, bold) {
    const key = (bold ? 'B' : 'R') + sizePx + '|' + ch;
    let w = measureCache.get(key);
    if (w === undefined) {
      ctx.font = `${bold ? '700' : '400'} ${sizePx}px ${FONT_STACK}`;
      w = ctx.measureText(ch).width;
      measureCache.set(key, w);
    }
    return w;
  }

  // —— 渲染：预览与打印共用同一 DOM 结构与字号/行距 ——
  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildLabelHtml(layout, widthMm, heightMm) {
    const cssVars = [
      `--pad:${MuseumLayout.PADDING_MM}`,
      `--body-size:${layout.sizePx}`,
      `--title-size:${layout.titleSizePx}`,
      `--body-lh:${(layout.bodyLineHeightPx / layout.sizePx).toFixed(4)}`,
      `--title-lh:${(layout.titleLineHeightPx / layout.titleSizePx).toFixed(4)}`,
      `--title-gap:${layout.titleGapPx.toFixed(3)}`,
      `--para-gap:${layout.paraGapPx.toFixed(3)}`,
    ].join(';');

    const titleHtml = layout.titleLines.length
      ? `<h1 class="label-title">${layout.titleLines
          .map((l) => `<div class="line">${escapeHtml(l)}</div>`)
          .join('')}</h1>`
      : '';

    const bodyHtml =
      layout.bodyParagraphs.length
        ? `<div class="label-body">${layout.bodyParagraphs
            .map(
              (para) =>
                `<p class="para">${para
                  .map((l) => `<div class="line">${escapeHtml(l)}</div>`)
                  .join('')}</p>`,
            )
            .join('')}</div>`
        : '';

    return (
      `<div class="label" style="width:${widthMm}mm;height:${heightMm}mm;${cssVars};` +
      `font-family:${FONT_STACK}">${titleHtml}${bodyHtml}</div>`
    );
  }

  function setStatus(kind, html) {
    els.status.className = 'status show ' + kind;
    els.status.innerHTML = html;
  }

  function clearStatus() {
    els.status.className = 'status';
    els.status.textContent = '';
  }

  // 预览等比缩放，使整张展签始终完整可见
  function fitPreview() {
    const label = els.stageBox.querySelector('.label');
    if (!label) return;
    const rectW = label.offsetWidth;
    const rectH = label.offsetHeight;
    if (!rectW || !rectH) return;
    const availW = els.stage.clientWidth - 80;
    const availH = els.stage.clientHeight - 80;
    const scale = Math.min(1, availW / rectW, availH / rectH);
    els.stageBox.style.transform = `scale(${scale})`;
  }

  function showError(result) {
    els.stageBox.innerHTML = '';
    els.stageError.hidden = false;
    els.stageError.innerHTML = `<strong>无法排版</strong>${escapeHtml(result.message)}`;
    els.printRoot.innerHTML = '';
    setStatus('err', escapeHtml(result.message));
    els.btnPrint.disabled = true;
  }

  function render() {
    // 缓存键包含字号、粗细与文本，无需随输入清空；字体异步加载后由 fonts.ready 重排
    const input = {
      title: els.title.value,
      body: els.body.value,
      widthMm: parseFloat(els.widthMm.value),
      heightMm: parseFloat(els.heightMm.value),
    };

    const result = MuseumLayout.computeLayout(input, measure);
    if (!result.ok) {
      showError(result);
      return;
    }

    els.stageError.hidden = true;
    els.stageError.innerHTML = '';

    const html = buildLabelHtml(result, input.widthMm, input.heightMm);
    els.stageBox.innerHTML = html;
    els.printRoot.innerHTML = html; // 打印版：同样的换行与物理 mm 尺寸
    els.btnPrint.disabled = false;

    const bodyLines = result.bodyParagraphs.reduce((a, p) => a + p.length, 0);
    const usedMm = (result.heightPx / MuseumLayout.PX_PER_MM).toFixed(1);
    setStatus(
      'ok',
      `正文字号 <code>${result.sizePx}px</code> · 标题字号 <code>${result.titleSizePx}px</code>` +
        ` · 标题 ${result.titleLines.length} 行 / 正文 ${bodyLines} 行` +
        ` · 内容高 ${usedMm} / ${input.heightMm} mm`,
    );

    requestAnimationFrame(fitPreview);
  }

  // —— 打印：动态设置 @page size 为展签物理尺寸 ——
  let pageStyleEl = null;
  function printLabel() {
    const w = parseFloat(els.widthMm.value);
    const h = parseFloat(els.heightMm.value);
    if (!pageStyleEl) {
      pageStyleEl = document.createElement('style');
      pageStyleEl.id = 'print-page-style';
      document.head.appendChild(pageStyleEl);
    }
    try {
      if (pageStyleEl.sheet.cssRules.length) pageStyleEl.sheet.deleteRule(0);
      pageStyleEl.sheet.insertRule(
        `@media print { @page { size: ${w}mm ${h}mm; margin: 0; } }`,
        0,
      );
    } catch (_) {
      // 个别浏览器不允许脚本写 @page size，退回系统页面设置（用户选 100% 即可）
    }
    window.print();
  }

  // —— 示例内容 ——
  const SAMPLE = {
    title: '白釉黑彩婴戏纹瓷枕',
    body:
      '北宋（公元960—1127年）\n' +
      '瓷枕呈腰圆形，枕面以白釉黑彩绘婴戏图，童子持荷奔跑，神态天真。' +
      '白地黑花（Black-and-White Glaze Decorated Porcelain）为磁州窑最具代表性的装饰手法，' +
      '笔墨酣畅，充满民间生活气息。\n' +
      '1986年出土于河南省修武县，现藏于本馆陶瓷厅。',
  };

  function loadSample() {
    els.title.value = SAMPLE.title;
    els.body.value = SAMPLE.body;
    els.widthMm.value = 120;
    els.heightMm.value = 85;
    render();
  }

  // —— 事件绑定 ——
  let timer = null;
  const scheduleRender = () => {
    clearTimeout(timer);
    timer = setTimeout(render, 60);
  };

  ['input', 'change'].forEach((evt) =>
    els.form.addEventListener(evt, scheduleRender),
  );
  els.form.addEventListener('submit', (e) => e.preventDefault());
  els.btnPrint.addEventListener('click', printLabel);
  els.btnSample.addEventListener('click', loadSample);
  window.addEventListener('resize', fitPreview);

  // Web 字体异步加载完成后字宽可能变化，清空测量缓存后重新排版
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      measureCache.clear();
      render();
    });
  }

  // 初始渲染（已预填示例，打开即有效果）
  loadSample();
})();
