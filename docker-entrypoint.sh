#!/bin/sh
# 容器启动入口：先安装依赖（node_modules 挂载于命名卷，首次安装、后续直接复用），再启动服务。
set -e

echo "[entrypoint] installing dependencies ..."
npm install --omit=dev --no-audit --no-fund

echo "[entrypoint] starting server ..."
exec node server.js
