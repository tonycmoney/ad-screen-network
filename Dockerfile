# Stage 1: build the React app
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: compile the TypeScript server
FROM node:22-alpine AS server
WORKDIR /server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
RUN npm run build

# Stage 3: runtime with production dependencies only
FROM node:22-alpine
ENV NODE_ENV=production \
    STATIC_DIR=/app/public \
    PORT=8000
WORKDIR /app
RUN apk upgrade --no-cache
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=server /server/dist ./dist
COPY --from=web /web/dist ./public

USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://localhost:'+(process.env.PORT||8000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
