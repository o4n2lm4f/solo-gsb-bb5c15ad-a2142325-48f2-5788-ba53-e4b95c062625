/* app.js —— 交互、字宽测量、字号搜索、渲染与打印 */
(function () {
  'use strict';

  var PX_PER_MM = window.LabelLayout.PX_PER_MM;
  var MIN_BODY = 12, MAX_BODY = 24;
  var TITLE_RATIO = 1.4;          // 标题字号 = 正文 × 1.4
  var PADDING_MM = 8;             // 展签内边距
  var TITLE_LINE_HEIGHT = 1.3;
  var BODY_LINE_HEIGHT = 1.6;
  var TITLE_GAP_PX_FACTOR = 0.5;  // 标题与正文间距 = 0.5 个正文字号
  var PARA_GAP_PX_FACTOR = 0.6;   // 段间距 = 0.6 个正文字号

  var el = {
    title: document.getElementById('title'),
    body: document.getElementById('body'),
    widthMm: document.getElementById('widthMm'),
    heightMm: document.getElementById('heightMm'),
    printBtn: document.getElementById('printBtn'),
    status: document.getElementById('status'),
    stage: document.getElementById('stage'),
    label: document.getElementById('label'),
    labelTitle: document.getElementById('labelTitle'),
    labelBody: document.getElementById('labelBody'),
    labelError: document.getElementById('labelError')
  };

  // ---------- Canvas 实际字宽测量（按 font 分别缓存） ----------
  // 正文与标题（加粗、1.4×）字号不同：每 font 一个独立 context，
  // 避免交替调用互相改写 ctx.font；缓存也按 font 隔离，避免拼接 key 碰撞。
  var measurers = {};

  function makeMeasure(font) {
    if (!measurers[font]) {
      var context = document.createElement('canvas').getContext('2d');
      context.font = font;
      var cache = {};
      measurers[font] = function (text) {
        var v = cache[text];
        if (v === undefined) {
          v = context.measureText(text).width;
          cache[text] = v;
        }
        return v;
      };
    }
    return measurers[font];
  }

  function fontString(size, weight) {
    var family = '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", ' +
                 '"SimSun", "Times New Roman", serif';
    return (weight || 400) + ' ' + size + 'px ' + family;
  }

  // ---------- 一次排版尝试 ----------
  // 返回 { ok, titlePlan, bodyPlan, bodyPx, titlePx, contentH } 或 { ok:false, reason }
  function tryLayout(titleText, bodyText, widthMm, heightMm, bodyPx) {
    var contentW = (widthMm - PADDING_MM * 2) * PX_PER_MM;
    var contentH = (heightMm - PADDING_MM * 2) * PX_PER_MM;
    if (contentW <= 4 || contentH <= 4) {
      return { ok: false, reason: 'config', message: '标签尺寸过小：内边距为 8mm，请加大宽或高。' };
    }

    var titlePx = Math.round(bodyPx * TITLE_RATIO * 100) / 100;
    var bodyMeasure = makeMeasure(fontString(bodyPx, 400));
    var titleMeasure = makeMeasure(fontString(titlePx, 700));

    var widthFailure = false;

    // 标题：作为普通文本规划（允许折行），空标题跳过
    var titlePlan = null;
    if (titleText.trim()) {
      titlePlan = window.LabelLayout.planText(titleText, contentW, titleMeasure);
      if (!titlePlan) widthFailure = true;
    }

    // 正文
    var bodyPlan = null;
    if (bodyText.trim()) {
      bodyPlan = window.LabelLayout.planText(bodyText, contentW, bodyMeasure);
      if (!bodyPlan) widthFailure = true;
    }

    if (widthFailure) {
      return {
        ok: false,
        reason: 'width',
        bodyPx: bodyPx,
        message: '存在即使 ' + bodyPx + 'px（最小字号）也无法放入一行的连续内容（如过长的英文单词），请加宽标签或修改文案。'
      };
    }

    if (!titlePlan && !bodyPlan) {
      return { ok: true, titlePlan: null, bodyPlan: null, bodyPx: bodyPx, titlePx: titlePx, contentH: 0 };
    }

    // 高度核算
    var titleH = 0, titleGap = 0, bodyH = 0;
    if (titlePlan) {
      titleH = titlePlan.totalLines * titlePx * TITLE_LINE_HEIGHT;
      if (bodyPlan) titleGap = bodyPx * TITLE_GAP_PX_FACTOR;
    }
    if (bodyPlan) {
      var paraGaps = (bodyPlan.paragraphs.length - 1) * bodyPx * PARA_GAP_PX_FACTOR;
      bodyH = bodyPlan.totalLines * bodyPx * BODY_LINE_HEIGHT + paraGaps;
    }
    var totalH = titleH + titleGap + bodyH;

    if (totalH > contentH + 0.75) {
      return { ok: false, reason: 'height', bodyPx: bodyPx, totalH: totalH, contentH: contentH };
    }

    return {
      ok: true, titlePlan: titlePlan, bodyPlan: bodyPlan,
      bodyPx: bodyPx, titlePx: titlePx, contentH: totalH
    };
  }

  // ---------- 12→24 中选最大可行字号 ----------
  function computeLayout(input) {
    var lastHeightFailure = null;
    for (var px = MAX_BODY; px >= MIN_BODY; px--) {
      var r = tryLayout(input.title, input.body, input.widthMm, input.heightMm, px);
      if (r.ok) return r;
      if (r.reason === 'config') return r;     // 尺寸配置错误，与字号无关
      if (r.reason === 'width') {
        if (px === MIN_BODY) return r;         // 最小字号仍超宽，无法挽救
        continue;
      }
      if (r.reason === 'height') lastHeightFailure = r;
    }
    // 12px 仍超高
    return lastHeightFailure || {
      ok: false, reason: 'height', bodyPx: MIN_BODY, totalH: 0, contentH: 0
    };
  }

  // ---------- 渲染 ----------
  function buildLines(container, plan) {
    container.innerHTML = '';
    plan.paragraphs.forEach(function (para) {
      var p = document.createElement('div');
      p.className = 't-paragraph';
      para.lines.forEach(function (lineText) {
        var div = document.createElement('div');
        div.className = 't-line';
        div.textContent = lineText;
        p.appendChild(div);
      });
      container.appendChild(p);
    });
  }

  var lastGood = null;

  function render() {
    var input = {
      title: el.title.value,
      body: el.body.value,
      widthMm: parseFloat(el.widthMm.value),
      heightMm: parseFloat(el.heightMm.value)
    };

    if (!(input.widthMm >= 30 && input.widthMm <= 999 &&
          input.heightMm >= 20 && input.heightMm <= 999)) {
      setStatus('请输入有效的标签尺寸：宽 30–999mm，高 20–999mm。', 'err');
      showError('标签尺寸无效\n（宽 30–999mm，高 20–999mm）');
      el.printBtn.disabled = true;
      return;
    }

    var result = computeLayout(input);

    if (!result.ok) {
      if (result.reason === 'config') {
        setStatus(result.message, 'err');
        showError('标签尺寸过小\n' + result.message);
      } else if (result.reason === 'width') {
        setStatus(result.message, 'err');
        showError('排不下：存在无法放入行宽的连续内容\n（如过长的英文单词）。\n请加宽标签或修改文案——不会截断显示。');
      } else {
        var msg = '内容在 12–24px 任何字号下都超出标签高度（' +
                  Math.round(result.totalH / PX_PER_MM) + 'mm / 可用 ' +
                  Math.round(result.contentH / PX_PER_MM) + 'mm）。\n请加高标签或精简文案——不会截断显示。';
        setStatus(msg, 'err');
        showError(msg);
      }
      el.printBtn.disabled = true;
      fitScale();
      return;
    }

    lastGood = { input: input, result: result };

    // 写入物理尺寸与字号
    var s = el.label.style;
    s.setProperty('--label-w', input.widthMm + 'mm');
    s.setProperty('--label-h', input.heightMm + 'mm');
    s.setProperty('--body-size', result.bodyPx + 'px');
    s.setProperty('--title-size', result.titlePx + 'px');
    s.setProperty('--title-gap',
      result.titlePlan && result.bodyPlan ? (result.bodyPx * TITLE_GAP_PX_FACTOR) + 'px' : '0px');
    s.setProperty('--para-gap', result.bodyPx * PARA_GAP_PX_FACTOR + 'px');

    el.labelError.hidden = true;

    el.labelTitle.innerHTML = '';
    if (result.titlePlan) {
      buildLines(el.labelTitle, result.titlePlan);
    }

    el.labelBody.innerHTML = '';
    if (result.bodyPlan) {
      buildLines(el.labelBody, result.bodyPlan);
    }

    var usedH = Math.round(result.contentH / PX_PER_MM);
    var info = '正文字号 ' + result.bodyPx + 'px（标题 ' +
      Math.round(result.titlePx * 10) / 10 + 'px）';
    if (result.bodyPlan) info += '，正文 ' + result.bodyPlan.totalLines + ' 行';
    if (result.titlePlan) info += '，标题 ' + result.titlePlan.totalLines + ' 行';
    info += '，内容高约 ' + usedH + 'mm / ' + Math.round(input.heightMm - PADDING_MM * 2) + 'mm';
    setStatus(info, 'ok');

    el.printBtn.disabled = false;
    fitScale();
  }

  function showError(message) {
    el.labelError.textContent = message;
    el.labelError.hidden = false;
    el.labelTitle.innerHTML = '';
    el.labelBody.innerHTML = '';
  }

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  // ---------- 屏幕预览缩放（仅显示用，不影响打印的毫米尺寸） ----------
  function fitScale() {
    var wMm = parseFloat(el.widthMm.value) || 120;
    var hMm = parseFloat(el.heightMm.value) || 80;
    var availW = el.stage.clientWidth - 24;
    var availH = el.stage.clientHeight - 24;
    var labelW = wMm * PX_PER_MM;
    var labelH = hMm * PX_PER_MM;
    var scale = Math.min(1, availW / labelW, availH / labelH);
    if (!(scale > 0) || !isFinite(scale)) scale = 1;
    el.label.style.transform = 'scale(' + scale + ')';
  }

  // ---------- 打印前把 @page 尺寸设为标签物理尺寸 ----------
  var pageStyle = null;
  function beforePrint() {
    if (el.printBtn.disabled || !lastGood) return;
    if (!pageStyle) {
      pageStyle = document.createElement('style');
      document.head.appendChild(pageStyle);
    }
    pageStyle.textContent = '@page { size: ' +
      lastGood.input.widthMm + 'mm ' + lastGood.input.heightMm + 'mm; margin: 0; }';
  }

  // ---------- 初始化 ----------
  el.body.value =
    '新石器时代·仰韶文化，约公元前 5000–前 3000 年。\n' +
    '泥质红陶，器表刻划有几何纹（geometric patterns），是研究黄河中游早期制陶工艺（pottery craftsmanship）的重要实物。出土于河南省渑池县仰韶村，1951 年入藏。';

  var schedule = (function () {
    var timer = null;
    return function () { clearTimeout(timer); timer = setTimeout(render, 120); };
  })();

  ['input', 'change'].forEach(function (evt) {
    el.title.addEventListener(evt, schedule);
    el.body.addEventListener(evt, schedule);
    el.widthMm.addEventListener(evt, schedule);
    el.heightMm.addEventListener(evt, schedule);
  });

  el.printBtn.addEventListener('click', function () { window.print(); });
  window.addEventListener('beforeprint', beforePrint);

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitScale, 80);
  });

  // 字体加载完成后重排，确保测量字宽与渲染一致
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(render);
  }
  render();
})();
