/*
 * 展签排版核心：分词 -> 行内合法断行（动态规划） -> 字号搜索。
 *
 * 纯逻辑模块，不依赖 DOM：字宽通过外部注入的 measure(ch, sizePx, bold) 获得，
 * 浏览器中由 Canvas 2D 的 measureText 提供（与预览/打印同一字体栈），
 * Node 测试中可注入等宽模拟。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MuseumLayout = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // —— 常量（像素 / 毫米换算按 CSS 参考像素 96dpi）——
  const PX_PER_MM = 96 / 25.4;
  const MIN_SIZE = 12;
  const MAX_SIZE = 24;
  const TITLE_RATIO = 1.5; // 标题字号 = 正文字号 × 1.5
  const LINE_HEIGHT_BODY = 1.6; // 正文行距（倍数）
  const LINE_HEIGHT_TITLE = 1.35; // 标题行距（倍数）
  const TITLE_GAP_MM = 2.5; // 标题与正文间距
  const PARA_GAP_EM = 0.7; // 段落间距（正文字号倍数）
  const PADDING_MM = 6; // 展签四周内边距
  const EPS_PX = 0.25; // 浮点容差

  // —— 避头尾标点（全角为主，兼容常见半角形式）——
  const OPEN_PUNCT = new Set(
    '（【《「『〈〔〖“‘·' + '([{',
  );
  const CLOSE_PUNCT = new Set(
    '）】》」』〉〕〗”’、，。．：；！？・…—' + ')]},.;:!?',
  );
  const DASH_CHARS = '‐-－—–‒―';

  const isWS = (c) => /\s/.test(c) || c === '　'; // 含全角空格
  const isDash = (c) => DASH_CHARS.includes(c);

  /*
   * 判断是否汉字类字符（含汉字扩展区、全角符号/假名等方块文字）。
   * 这类字符以单字为原子，两侧均可断行。
   */
  function isHanLike(ch) {
    const cp = ch.codePointAt(0);
    return (
      (cp >= 0x2e80 && cp <= 0x9fff) || // CJK 部首 ~ 汉字
      (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文音节
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意文字
      (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容符号（破折号等除外，已在别处处理）
      (cp >= 0xff00 && cp <= 0xffef) || // 全角 ASCII / 半角假名
      (cp >= 0x20000 && cp <= 0x2ffff) // 扩展区汉字
    );
  }

  /*
   * 段落分词。token: { ch, t }
   * t: space 空格(可断点) / open 闭头(禁行尾) / close 开头(禁行首)
   *    word 英文单词(整体不可拆) / han 汉字类单字 / generic 其他不可拆片段
   */
  function tokenize(text) {
    const tokens = [];
    const push = (ch, t) => {
      if (t === 'space') {
        // 折叠连续空白；段落首尾不留空格
        if (tokens.length === 0 || tokens[tokens.length - 1].t === 'space') return;
      }
      tokens.push({ ch, t });
    };

    let i = 0;
    while (i < text.length) {
      const ch = text[i];

      if (isWS(ch)) {
        push(' ', 'space');
        i++;
        continue;
      }

      // 破折号连用（—— 等）作为不可拆整体；单个破折号同样按 generic 原子处理
      if (isDash(ch)) {
        let run = '';
        while (i < text.length && isDash(text[i])) run += text[i++];
        push(run, 'generic');
        continue;
      }

      // 省略号连用（……）作为不可拆整体
      if (ch === '…') {
        let run = ch;
        let j = i + 1;
        while (j < text.length && text[j] === '…') run += text[j++];
        push(run, 'generic');
        i = j;
        continue;
      }

      // 句末点号叠用（！！ ？？ 。。 等）作为不可拆整体；单个时为“开头禁”标点
      if ('。？！.!?'.includes(ch)) {
        let run = ch;
        let j = i + 1;
        while (j < text.length && text[j] === ch) run += text[j++];
        if (run.length > 1) push(run, 'generic');
        else push(ch, 'close');
        i = j;
        continue;
      }

      // 英文/数字单词，内部允许 . _ - / ' 等连接符（如 New-York、1.5、don't、A/B）
      const m = /^[A-Za-z0-9]+(?:[._'’\-/][A-Za-z0-9]+)*/.exec(text.slice(i));
      if (m) {
        push(m[0], 'word');
        i += m[0].length;
        continue;
      }

      if (OPEN_PUNCT.has(ch)) {
        push(ch, 'open');
        i++;
        continue;
      }
      if (CLOSE_PUNCT.has(ch)) {
        push(ch, 'close');
        i++;
        continue;
      }
      if (isHanLike(ch)) {
        push(ch, 'han');
        i += ch.length;
        continue;
      }

      // 其他字符：按单字 generic 原子处理，两侧可断
      push(ch, 'generic');
      i += ch.length;
    }

    while (tokens.length && tokens[tokens.length - 1].t === 'space') tokens.pop();
    return tokens;
  }

  /*
   * 在给定可用宽度内对一个段落做最优断行。
   * 目标：最小化 Σ(非末行空白宽度)^2；
   * 约束：word/generic 不拆、闭标点不居行首、开标点不居行尾、行首尾不挂空格。
   *
   * 返回 { lines: string[], edges: number[] }；
   * 若存在整体超过行宽的不可拆片段则抛出 { code: 'OVERFLOW_UNIT', unit }。
   */
  function breakLines(tokens, maxWidthPx, widthOf) {
    const n = tokens.length;
    if (n === 0) return { lines: [], edges: [] };

    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + widthOf(tokens[i]);

    const lineWidth = (i, j) => {
      // 去掉行尾悬挂空格的宽度
      let end = j;
      while (end > i && tokens[end - 1].t === 'space') end--;
      return prefix[end] - prefix[i];
    };

    // 预检查：任何单个不可拆片段（含汉字、标点、英文词、破折号整体）超过行宽 → 无解
    for (let k = 0; k < n; k++) {
      if (tokens[k].t !== 'space' && widthOf(tokens[k]) > maxWidthPx + EPS_PX) {
        throw { code: 'OVERFLOW_UNIT', unit: tokens[k].ch };
      }
    }

    const INF = Infinity;
    const cost = new Float64Array(n + 1).fill(INF);
    const parent = new Int32Array(n + 1).fill(-1);
    cost[0] = 0;

    for (let i = 0; i < n; i++) {
      if (cost[i] === INF) continue;
      if (tokens[i].t === 'space') continue; // 行不能以空格开始（到达 i 时也不会发生，双保险）

      for (let j = i + 1; j <= n; j++) {
        const last = tokens[j - 1];
        if (last.t === 'space') continue; // 行尾不挂空格
        if (last.t === 'open') continue; // 开标点不居行尾

        // i..j 之后的断行点 k：若行末后跟空格，断点跨过空格
        let k = j;
        if (j < n && tokens[j].t === 'space') {
          k = j + 1;
          if (k < n && tokens[k].t === 'close') continue; // 闭标点不居次行行首
        } else if (j < n && tokens[j].t === 'close') {
          continue; // 闭标点不居次行行首
        }

        const w = lineWidth(i, j);
        if (w > maxWidthPx + EPS_PX) break; // 宽度随 j 单调增加，可安全剪枝

        const isLast = k === n;
        const blank = maxWidthPx - w;
        const add = isLast ? 0 : blank * blank;
        const cand = cost[i] + add;
        if (cand < cost[k]) {
          cost[k] = cand;
          parent[k] = i;
        }
      }
    }

    if (cost[n] === INF) {
      // 理论上预检查后不会发生；防御性报错
      throw { code: 'OVERFLOW_UNIT', unit: '' };
    }

    // 回溯
    const edges = [n];
    let cur = n;
    while (cur > 0) {
      cur = parent[cur];
      edges.push(cur);
    }
    edges.reverse();

    const lines = [];
    for (let q = 0; q < edges.length - 1; q++) {
      let s = '';
      for (let p = edges[q]; p < edges[q + 1]; p++) {
        if (tokens[p].t === 'space' && p === edges[q + 1] - 1) break; // 去掉悬挂空格
        s += tokens[p].ch;
      }
      lines.push(s);
    }
    return { lines, edges };
  }

  function toParagraphs(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /*
   * 在给定正文字号下尝试排版。返回结构化版面；装不下时抛错。
   * measure: (ch, sizePx, bold) => 宽度 px
   */
  function fitAt(sizePx, opts, measure) {
    const contentW = (opts.widthMm - 2 * PADDING_MM) * PX_PER_MM;
    const contentH = (opts.heightMm - 2 * PADDING_MM) * PX_PER_MM;

    const titleSizePx = Math.round(sizePx * TITLE_RATIO);
    const bodyLineH = sizePx * LINE_HEIGHT_BODY;
    const titleLineH = titleSizePx * LINE_HEIGHT_TITLE;
    const titleGapPx = TITLE_GAP_MM * PX_PER_MM;
    const paraGapPx = sizePx * PARA_GAP_EM;

    const bodyWidthOf = (tok) => measure(tok.ch, sizePx, false);
    const titleWidthOf = (tok) => measure(tok.ch, titleSizePx, true);

    let titleLines = [];
    const titleParas = toParagraphs(opts.title);
    if (titleParas.length) {
      const titleText = titleParas.join(' '); // 标题按单段处理
      titleLines = breakLines(tokenize(titleText), contentW, titleWidthOf).lines;
    }

    const bodyParagraphs = toParagraphs(opts.body).map((p) =>
      breakLines(tokenize(p), contentW, bodyWidthOf),
    );

    const bodyLineCount = bodyParagraphs.reduce((a, p) => a + p.lines.length, 0);
    let heightPx = bodyLineCount * bodyLineH;
    if (bodyParagraphs.length > 1) {
      heightPx += (bodyParagraphs.length - 1) * paraGapPx;
    }
    if (titleLines.length) {
      heightPx += titleLines.length * titleLineH + titleGapPx;
    }

    if (heightPx > contentH + EPS_PX) {
      throw {
        code: 'TOO_TALL',
        heightPx,
        contentHPx: contentH,
        lines: bodyLineCount + titleLines.length,
      };
    }

    return {
      sizePx,
      titleSizePx,
      bodyLineHeightPx: bodyLineH,
      titleLineHeightPx: titleLineH,
      titleGapPx,
      paraGapPx,
      titleLines,
      bodyParagraphs: bodyParagraphs.map((p) => p.lines),
      contentWPx: contentW,
      contentHPx: contentH,
      heightPx,
    };
  }

  /*
   * 主入口：从 24px 到 12px 取能放入宽高的最大整数正文字号。
   */
  function computeLayout(input, measure) {
    const opts = {
      title: input.title || '',
      body: input.body || '',
      widthMm: Number(input.widthMm),
      heightMm: Number(input.heightMm),
    };

    if (!(opts.widthMm > 0) || !(opts.heightMm > 0)) {
      return { ok: false, code: 'BAD_DIMENSIONS', message: '展签宽高必须为正数（毫米）。' };
    }
    if (!toParagraphs(opts.body).length && !toParagraphs(opts.title).length) {
      return { ok: false, code: 'EMPTY', message: '请输入标题或正文。' };
    }

    let lastErr = null;
    for (let size = MAX_SIZE; size >= MIN_SIZE; size--) {
      try {
        return { ok: true, ...fitAt(size, opts, measure) };
      } catch (e) {
        lastErr = e;
      }
    }

    // 最小字号仍装不下：区分“宽度装不下不可拆片段”与“超高”
    if (lastErr && lastErr.code === 'OVERFLOW_UNIT') {
      return {
        ok: false,
        code: 'TOO_WIDE',
        unit: lastErr.unit,
        message:
          '即使使用最小正文字号 12px，仍有不可拆分的内容超过可用宽度' +
          (lastErr.unit ? `（“${lastErr.unit}”）` : '') +
          '，请加宽展签或缩短该英文单词/连字。',
      };
    }
    const mm = (px) => (px / PX_PER_MM).toFixed(1);
    return {
      ok: false,
      code: 'TOO_TALL',
      message:
        `最小正文字号 12px 仍排不下：内容高约 ${mm(lastErr ? lastErr.heightPx : 0)} mm，` +
        `可用高度仅 ${mm(lastErr ? lastErr.contentHPx : 0)} mm。请加高展签或精简文字。`,
    };
  }

  return {
    PX_PER_MM,
    PADDING_MM,
    MIN_SIZE,
    MAX_SIZE,
    tokenize,
    breakLines,
    computeLayout,
    toParagraphs,
  };
});
