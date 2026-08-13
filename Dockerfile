# Stage 1: Build Angular frontend and TypeScript server
FROM node:24-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build:auth

# Stage 2: Production runner
FROM node:24-slim

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/config.json* ./

ENV NODE_ENV=production
ENV PORT=8080
ENV CONFIG_PATH=/app/config.json

EXPOSE 8080

CMD ["node", "dist/server/main.js"]
