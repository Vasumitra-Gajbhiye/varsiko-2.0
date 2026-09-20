FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PILOT_OFFLINE=1
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY tsconfig.json ./
COPY AgentCard.json skill.json ./
COPY cloud-init ./cloud-init
COPY src ./src
EXPOSE 8000
CMD ["node", "src/agent/main.ts"]
