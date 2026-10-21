FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# Store the database and uploads on a volume (Railway sets RAILWAY_VOLUME_MOUNT_PATH automatically).
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.js"]
