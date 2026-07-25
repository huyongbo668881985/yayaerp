FROM node:20-slim

# better-sqlite3 需要编译工具
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

VOLUME ["/app/data"]

CMD ["node", "app.js"]
