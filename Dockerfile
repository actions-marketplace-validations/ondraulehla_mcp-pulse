# mcptop as an MCP server over stdio, for directories that start a server to
# inspect it (Glama) and for anyone who wants it in a container:
#   docker build -t mcptop . && docker run -i --rm mcptop
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/mcptop/package.json packages/mcptop/
COPY site/package.json site/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages/mcptop packages/mcptop
RUN npm run build -w packages/mcptop && (cd packages/mcptop && npm pack --pack-destination /src)

FROM node:22-alpine
COPY --from=build /src/mcptop-*.tgz /tmp/
RUN npm install -g /tmp/mcptop-*.tgz && rm /tmp/mcptop-*.tgz && npm cache clean --force
ENTRYPOINT ["mcptop", "mcp"]
