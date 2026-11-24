FROM node:22-alpine

WORKDIR /app

COPY index.mjs ./

RUN mkdir -p /data && chown node:node /data

ENV REMOTE_STORAGE_HOST=0.0.0.0
ENV REMOTE_STORAGE_PORT=8787
ENV DATA_DIR=/data

USER node

EXPOSE 8787

CMD ["node", "index.mjs"]
