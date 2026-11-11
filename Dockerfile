FROM node:24-bookworm-slim

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json .npmrc ./
RUN npm ci \
    && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/pinterest-session-state.ts ./scripts/pinterest-session-state.ts
RUN npm run build \
    && npm prune --omit=dev \
    && mkdir -p /app/data \
    && chown node:node /app/data

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
USER node
ENTRYPOINT ["node", "dist/main.js"]
