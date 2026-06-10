# Prototype: registry-office-ui-spike

Status: active

## Question

Can the real Cloudflare context-pack registry be presented as an office-friendly internal library using SvelteKit + MDSvX, without exposing registry secrets to the browser?

## Run

```bash
pnpm --filter registry-office-ui-spike dev
```

## Success signal

A local SvelteKit UI lists live packages from the deployed registry Worker, shows package/version/job details, and frames the office UX as browse → inspect → copy package ref.

## Capture target

- `.brain/projects/pi-sandbox-workflows.svx`
- `docs/production-vs-prototypes.md`

## Delete/absorb rule

Delete or rewrite after we decide the office-facing registry UX shape. Do not promote this prototype directly.
