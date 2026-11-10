FROM node:24-bookworm-slim

ARG CODEX_VERSION=latest
ARG MICROMAMBA_VERSION=2.9.0-0
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=America/Denver

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        bubblewrap \
        ca-certificates \
        curl \
        git \
        jq \
        less \
        openssh-client \
        procps \
        ripgrep \
        tini \
        tzdata \
    && ln -snf "/usr/share/zoneinfo/${TZ}" /etc/localtime \
    && printf '%s\n' "$TZ" >/etc/timezone \
    && case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
        amd64) micromamba_arch=linux-64 ;; \
        arm64) micromamba_arch=linux-aarch64 ;; \
        *) echo "Unsupported architecture: ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
    esac \
    && micromamba_asset="micromamba-${micromamba_arch}" \
    && micromamba_url="https://github.com/mamba-org/micromamba-releases/releases/download/${MICROMAMBA_VERSION}/${micromamba_asset}" \
    && curl -fsSL "${micromamba_url}" -o /tmp/micromamba \
    && curl -fsSL "${micromamba_url}.sha256" -o /tmp/micromamba.sha256 \
    && printf '%s  %s\n' "$(cat /tmp/micromamba.sha256)" /tmp/micromamba | sha256sum -c - \
    && install -m 0755 /tmp/micromamba /usr/local/bin/micromamba \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && rm -f /tmp/micromamba /tmp/micromamba.sha256 \
    && rm -rf /var/lib/apt/lists/*

COPY cx-entrypoint cx-env cx-remote /usr/local/bin/
COPY mcp/ /opt/cx-mcp/
RUN cd /opt/cx-mcp && npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The actual UID/GID is supplied by `docker run`.
RUN chmod 0755 /usr/local/bin/cx-entrypoint /usr/local/bin/cx-env /usr/local/bin/cx-remote \
    && mkdir -p /workspace/main /workspace/cx-external /workspace/remote /cx-env /codex-home /home/codex \
    && chmod 1777 /workspace /cx-env /codex-home /home/codex

ENV HOME=/home/codex
ENV CODEX_HOME=/codex-home
ENV MAMBA_ROOT_PREFIX=/cx-env
ENV PAGER=less
ENV LESS=-FRX
ENV TERM=xterm-256color

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/cx-entrypoint"]
