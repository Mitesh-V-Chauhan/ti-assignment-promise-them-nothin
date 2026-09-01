FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production 2>/dev/null || npm install --production

COPY src/ ./src/

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
