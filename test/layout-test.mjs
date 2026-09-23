// 排版核心的 Node 端验证：分词分类、避头尾、最优断行代价、字号决策与报错。
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const L = require('../public/layout.js');

// 模拟 CJK 字体字宽（px = 字号 × 相对宽度）：
// 空白 0.5em，ASCII 字母数字 0.55em，ASCII 标点 0.5em，其余（汉字/全角标点）1em
const measure = (ch, size) => {
  let em = 0;
  for (const c of ch) {
    if (/\s/.test(c)) em += 0.5;
    else if (/[A-Za-z0-9]/.test(c)) em += 0.55;
    else if (/^[\x21-\x7e]$/.test(c)) em += 0.5;
    else em += 1;
  }
  return size * em;
};

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// 1. 分词分类
t('分词：英文单词为整体，汉字逐字，标点分类', () => {
  const toks = L.tokenize('Hello（中国）World');
  assert.deepEqual(toks.map((x) => x.t), [
    'word', 'open', 'han', 'han', 'close', 'word',
  ]);
  assert.equal(toks[0].ch, 'Hello');
  assert.equal(toks[5].ch, 'World');
});

t('分词：连续空白折叠，首尾空格剥离', () => {
  const toks = L.tokenize('  你好   world  \n');
  assert.equal(toks[0].t, 'han');
  assert.equal(toks[toks.length - 1].t, 'word');
  assert.ok(!toks.some((x, i) => x.t === 'space' && toks[i + 1]?.t === 'space'));
});

t('分词：破折号/省略号叠用为不可拆 generic', () => {
  const toks = L.tokenize('——啊……！！');
  assert.deepEqual(toks.map((x) => x.t), ['generic', 'han', 'generic', 'generic']);
  assert.equal(toks[0].ch, '——');
});

t('分词：带连接符的数字与英文不拆', () => {
  const toks = L.tokenize('1.5 don’t New-York A/B').filter((x) => x.t !== 'space');
  assert.deepEqual(toks.map((x) => x.ch), ['1.5', 'don’t', 'New-York', 'A/B']);
  assert.ok(toks.every((x) => x.t === 'word'));
});

// 2. 避头尾
const validateKinsoku = (lines, label) => {
  for (const line of lines) {
    assert.ok(!/[（【《「『『“‘\(\[\{]$/.test(line), `开标点在行尾: “${line}” [${label}]`);
    assert.ok(!/^[）】》」』”’、，。．：；！？？…—\)\]\},\.;:!?]/.test(line), `闭标点在行首: “${line}” [${label}]`);
  }
};

t('断行：闭标点不居行首、开标点不居行尾', () => {
  for (const w of [64, 70, 80, 90, 100, 120]) {
    const r = L.breakLines(L.tokenize('这是（一个）测试，包含“引号”和《书名号》以及English单词！'), w, (tok) =>
      measure(tok.ch, 16),
    );
    validateKinsoku(r.lines, `width=${w}`);
  }
});

t('断行：行首尾不挂空格，英文单词不被拆开', () => {
  const text = 'The quick brown fox jumps over the lazy dog 敏捷的棕色狐狸跳过懒狗';
  for (const w of [50, 70, 90, 110, 200]) {
    const r = L.breakLines(L.tokenize(text), w, (tok) => measure(tok.ch, 16));
    for (const line of r.lines) {
      assert.ok(!line.startsWith(' ') && !line.endsWith(' '), `行首尾挂空格: “${line}”`);
    }
    const rejoined = r.lines.join('').replace(/\s+/g, '');
    const original = text.replace(/\s+/g, '');
    assert.equal(rejoined, original, '重排后字符顺序/字形不变');
    // 英文单词必须完整处于同一行（未被断行拆开）
    const words = new Set(text.match(/[A-Za-z]+/g) || []);
    for (const line of r.lines) {
      for (const w of line.match(/[A-Za-z]+/g) || []) words.delete(w);
    }
    assert.equal(words.size, 0, `有英文单词被跨断: ${[...words].join(', ')}`);
  }
});

// 3. 最优代价
t('断行：最小化非末行空白平方和（末行不罚）', () => {
  // 10 个等宽汉字，每字宽 10px；行宽 35 → 每行最多 3 字
  const toks = L.tokenize('一二三四五六七八九十');
  const r = L.breakLines(toks, 35, () => 10);
  // 最优应尽量把行填满：3/3/3/1；空白 5,5,5,末行不罚
  assert.deepEqual(r.lines.map((s) => s.length), [3, 3, 3, 1]);
});

t('断行：与贪心排法代价对比，DP 选总代价更小者', () => {
  // 手工构造贪心次优的情形（cap=9，词间空格宽 1）：
  //   greedy: [6][1 1 1][5] → 非末行空白 3 + 6，代价 45
  //   DP:     [6 1][1 1 5] → 非末行空白 1，末行不罚，代价 1
  const mk = (ch, t) => ({ ch, t });
  const tokens = [
    mk('aaaaaa', 'word'), mk(' ', 'space'),
    mk('b', 'word'), mk(' ', 'space'),
    mk('c', 'word'), mk(' ', 'space'),
    mk('d', 'word'), mk(' ', 'space'),
    mk('eeeee', 'word'),
  ];
  const w = (tok) => (tok.t === 'space' ? 1 : tok.ch.length);
  const r = L.breakLines(tokens, 9, w);
  assert.deepEqual(r.lines, ['aaaaaa b', 'c d eeeee']);
});

// 4. 装不下的硬错误
t('错误：不可拆单词超过行宽 → OVERFLOW_UNIT', () => {
  assert.throws(
    () =>
      L.breakLines(L.tokenize('Supercalifragilistic'), 50, (tok) => measure(tok.ch, 12)),
    (e) => e.code === 'OVERFLOW_UNIT',
  );
});

// 5. 字号决策
const baseInput = {
  title: '青铜鼎',
  body: '这是一件商代晚期的青铜鼎，出土于河南安阳，Bronze Ritual Vessel（公元前1200年）。',
  widthMm: 100,
  heightMm: 60,
};

t('字号决策：返回 12–24 之间可放入的最大字号', () => {
  const r = L.computeLayout(baseInput, measure);
  assert.equal(r.ok, true, r.message);
  assert.ok(r.sizePx >= 12 && r.sizePx <= 24);
  const bigger = L.computeLayout({ ...baseInput, heightMm: 200, widthMm: 200 }, measure);
  assert.equal(bigger.sizePx, 24);
  const smaller = L.computeLayout({ ...baseInput, heightMm: 30 }, measure);
  if (smaller.ok) {
    assert.ok(smaller.sizePx <= r.sizePx, '空间越小，字号不应更大');
  } else {
    assert.equal(smaller.code, 'TOO_TALL');
  }
});

t('字号决策：超高时报 TOO_TALL 而非截断', () => {
  const r = L.computeLayout(
    { ...baseInput, body: baseInput.body.repeat(40), widthMm: 60, heightMm: 40 },
    measure,
  );
  assert.equal(r.ok, false);
  assert.ok(['TOO_TALL', 'TOO_WIDE'].includes(r.code));
  assert.ok(r.message.includes('12px'));
});

t('字号决策：超宽单词报 TOO_WIDE 并指出该词', () => {
  const r = L.computeLayout(
    { title: '', body: 'Antidisestablishmentarianism', widthMm: 20, heightMm: 40 },
    measure,
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TOO_WIDE');
  assert.ok(r.message.includes('Antidisestablishmentarianism'));
});

t('段落：多段落保留段间距，空行忽略', () => {
  const r = L.computeLayout(
    { title: '标题', body: '第一段文字。\n\n\n第二段文字。\n第三段！', widthMm: 80, heightMm: 80 },
    measure,
  );
  assert.equal(r.ok, true);
  assert.equal(r.bodyParagraphs.length, 3);
});

t('尺寸校验与空内容校验', () => {
  assert.equal(L.computeLayout({ ...baseInput, widthMm: 0 }, measure).code, 'BAD_DIMENSIONS');
  assert.equal(L.computeLayout({ title: '', body: '', widthMm: 80, heightMm: 80 }, measure).code, 'EMPTY');
});

console.log(`\n${passed} 项全部通过 ✔`);
