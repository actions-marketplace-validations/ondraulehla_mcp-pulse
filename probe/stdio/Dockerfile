# The box a package server runs in: Node 22, mcptop, nothing else. Built from
# the local tarball so the probe inside matches the one the board uses.
FROM node:22-alpine
RUN apk add --no-cache git
COPY mcptop-*.tgz /tmp/
RUN npm install -g /tmp/mcptop-*.tgz && rm /tmp/mcptop-*.tgz && npm cache clean --force
COPY probe.mjs /app/probe.mjs
WORKDIR /work
