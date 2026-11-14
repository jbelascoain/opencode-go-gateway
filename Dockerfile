FROM node:24-alpine

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "src/index.mjs"]
