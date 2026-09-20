FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORTER_OFFLINE=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY templates ./templates
COPY fixtures ./fixtures
COPY AgentCard.json ./AgentCard.json
COPY skill.json ./skill.json
EXPOSE 8000
CMD ["node", "dist/server.js"]
