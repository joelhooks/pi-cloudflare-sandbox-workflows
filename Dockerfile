FROM docker.io/cloudflare/sandbox:0.11.0

ARG PI_VERSION=0.78.0

USER root

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION}

ENV PI_CODING_AGENT_DIR=/workspace/.pi/agent \
    PI_CODING_AGENT_SESSION_DIR=/workspace/.pi/agent/sessions \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0 \
    TERM=xterm-256color

WORKDIR /workspace

RUN mkdir -p /workspace/.pi/agent/sessions \
  && chmod -R 700 /workspace/.pi \
  && printf '%s\n' \
    'export PI_CODING_AGENT_DIR=/workspace/.pi/agent' \
    'export PI_CODING_AGENT_SESSION_DIR=/workspace/.pi/agent/sessions' \
    'export PI_SKIP_VERSION_CHECK=1' \
    'export PI_TELEMETRY=0' \
    'export TERM=xterm-256color' \
    'cd /workspace' \
    'echo ""' \
    'echo "Pi workflow sandbox ready."' \
    'echo "Agent lanes run here and push receipts to Cloudflare Artifacts."' \
    'echo ""' \
    > /root/.bashrc

EXPOSE 8080
