FROM node:20-slim

# better-sqlite3 需要编译工具；rclone 用于把备份快照同步到 Cloudflare R2
RUN apt-get update && apt-get install -y python3 make g++ rclone && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

VOLUME ["/app/data"]

# 安全加固说明：没有用 USER node 降权运行，是刻意的——compose 把宿主机 ./data
# bind mount 进 /app/data，目录属主通常是 root（UID 0）；降权后 node(UID 1000)
# 会对该目录没有写权限，数据库直接起不来。要降权需同时 chown 宿主机目录，
# 属于部署侧变更，改动前需确认服务器上的目录权限。
CMD ["node", "app.js"]
