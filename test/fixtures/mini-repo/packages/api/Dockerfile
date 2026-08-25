FROM node:22-slim
WORKDIR /app
COPY packages/api packages/api
COPY packages/shared packages/shared
CMD ["node", "packages/api/src/server.ts"]
