# Pinned to the stable @cloudflare/sandbox 0.11.0 image used by this prototype.
# Do not chase temporary PR build tags here; the proof needs reproducible substrate behavior.
FROM docker.io/cloudflare/sandbox:0.11.0

USER root

# THROWAWAY PROTOTYPE IMAGE
# Sandbox only prepares/pins approved payload files in Artifacts.
# It must never receive GitHub App material or installation tokens.
RUN npm install -g --ignore-scripts pnpm@11.1.2 tsx@4.20.6

WORKDIR /workspace

RUN printf '%s\n' \
  'cd /workspace' \
  'echo ""' \
  'echo "🐀 cloud-capability-lease-broker-spike sandbox"' \
  'echo "Payload generation only. GitHub capability execution stays in Worker/DO."' \
  'echo ""' \
  > /root/.bashrc

EXPOSE 8080
