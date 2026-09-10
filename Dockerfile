FROM node:20-slim

# better-sqlite3 需要编译工具；rclone 用于把备份快照同步到 Cloudflare R2
RUN apt-get update && apt-get install -y python3 make g++ rclone && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# node:20-slim 自带 UID/GID 1000 的 node 用户。镜像内数据目录预先授予写权限，
# Linux bind mount 部署时宿主机 ./data 也必须属于 1000:1000（见 README）。
RUN mkdir -p /app/data && chown -R node:node /app

ENV PORT=3000
EXPOSE 3000

VOLUME ["/app/data"]

USER node
CMD ["node", "app.js"]
