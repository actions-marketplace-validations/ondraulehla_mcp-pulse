# The box a package server runs in: Node 22, mcptop, nothing else. Built from
# the local tarball so the probe inside matches the one the board uses.
FROM node:22-alpine
RUN apk add --no-cache git python3 py3-pip && pip install --no-cache-dir --break-system-packages uv
# Managed Pythons for PyPI servers, so an install does not download one each time.
ENV UV_PYTHON_INSTALL_DIR=/opt/uvpy UV_TOOL_DIR=/work/uv UV_TOOL_BIN_DIR=/work/bin
RUN uv python install 3.12 3.13
COPY mcptop-*.tgz /tmp/
RUN npm install -g /tmp/mcptop-*.tgz && rm /tmp/mcptop-*.tgz && npm cache clean --force
COPY probe.mjs /app/probe.mjs
WORKDIR /work
