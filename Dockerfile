# mcpcost as an MCP server over stdio, for directories that start a server to
# inspect it (Glama) and for anyone who wants it in a container:
#   docker build -t mcpcost . && docker run -i --rm mcpcost
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/mcpcost/package.json packages/mcpcost/
COPY site/package.json site/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages/mcpcost packages/mcpcost
RUN npm run build -w packages/mcpcost && (cd packages/mcpcost && npm pack --pack-destination /src)

FROM node:22-alpine
COPY --from=build /src/mcpcost-*.tgz /tmp/
RUN npm install -g /tmp/mcpcost-*.tgz && rm /tmp/mcpcost-*.tgz && npm cache clean --force
ENTRYPOINT ["mcpcost", "mcp"]
