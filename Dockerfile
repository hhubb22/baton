FROM node:26-bookworm-slim AS build
WORKDIR /src
RUN npm install --global pnpm@12.11.2
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @baton/server build

FROM node:26-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home baton \
    && install -d -m 0700 -o baton -g baton /var/lib/baton
COPY --from=build /src/apps/server/dist/server.cjs /opt/baton/server.cjs
COPY --from=build /src/apps/server/dist/web /opt/baton/web
COPY --from=build /src/apps/server/dist/migrations /opt/baton/migrations
USER baton
WORKDIR /var/lib/baton
ENV NODE_ENV=production \
    BATON_HTTP_ADDR=0.0.0.0:8080 \
    BATON_NODE_SIGNING_KEY=/var/lib/baton/node-signing.key
EXPOSE 8080
ENTRYPOINT ["node", "/opt/baton/server.cjs"]
CMD ["serve"]
