FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY server.js package.json ./

# Jalankan sebagai user non-root
USER node

EXPOSE 8787
CMD ["node", "server.js"]
