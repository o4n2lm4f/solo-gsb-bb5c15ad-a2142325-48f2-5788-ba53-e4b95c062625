// 博物馆展签排版工具 —— Express 服务
// 仅负责提供静态页面；所有排版（字宽测量、动态规划断行、字号决策）均在浏览器端完成，
// 这样预览与打印共用同一套字体与测量结果，保证“所见即所打”。

const path = require('path');
const express = require('express');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

app.use(
  '/',
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    maxAge: '1h',
  }),
);

// 简易健康检查，便于 Compose healthcheck / 容器编排探活。
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[museum-label] listening on http://${HOST}:${PORT}`);
});
