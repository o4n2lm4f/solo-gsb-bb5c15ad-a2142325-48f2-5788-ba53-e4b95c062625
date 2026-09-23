# 博物馆展签排版工具 —— 运行镜像
FROM node:20-alpine

WORKDIR /usr/src/app

# 依赖随容器启动安装（见 docker-entrypoint.sh）；
# Compose 中将 node_modules 挂载为独立命名卷，首次启动安装、后续直接复用。
COPY package.json ./
COPY server.js ./
COPY docker-entrypoint.sh ./
COPY public ./public

RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["./docker-entrypoint.sh"]
