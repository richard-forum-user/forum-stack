# forum-stack — local Pod Worker via wrangler dev (workerd under the hood).
FROM node:22-bookworm-slim
WORKDIR /app
COPY forum-pod/package*.json ./forum-pod/
RUN cd forum-pod && npm ci
COPY forum-pod ./forum-pod
RUN cd forum-pod && npm run build
COPY forum-pod-airlock ./forum-pod-airlock
RUN cd forum-pod-airlock && npm ci 2>/dev/null || npm install
RUN mkdir -p forum-pod-airlock/dist && cp -r forum-pod/dist/* forum-pod-airlock/dist/
ENV WRANGLER_SEND_METRICS=false
EXPOSE 8787
VOLUME ["/data"]
WORKDIR /app/forum-pod-airlock
CMD ["npx", "wrangler", "dev", "--local", "--ip", "0.0.0.0", "--port", "8787", "--persist-to", "/data"]
