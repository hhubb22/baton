FROM node:26-bookworm-slim AS web
WORKDIR /src
RUN npm install --global pnpm@12.11.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml vite.config.ts ./
COPY web/package.json ./web/
RUN pnpm --filter baton-web install --frozen-lockfile --ignore-scripts
COPY web/ ./web/
COPY design/resources/ ./design/resources/
RUN pnpm --dir web build

FROM golang:1.27-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/internal/webui/dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -o /out/baton-server ./cmd/baton-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home baton \
    && install -d -m 0700 -o baton -g baton /var/lib/baton
COPY --from=build /out/baton-server /usr/local/bin/baton-server
USER baton
WORKDIR /var/lib/baton
ENV BATON_HTTP_ADDR=0.0.0.0:8080 \
    BATON_NODE_SIGNING_KEY=/var/lib/baton/node-signing.key
EXPOSE 8080
ENTRYPOINT ["baton-server"]
CMD ["serve"]
