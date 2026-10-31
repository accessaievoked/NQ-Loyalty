# One image, two processes: the web app (default) and the background worker
# (docker compose overrides the command for the worker service).
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
EXPOSE 3000
COPY --from=build /app ./
CMD ["npm", "run", "docker-start"]
