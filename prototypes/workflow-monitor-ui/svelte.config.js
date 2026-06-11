import adapter from "@sveltejs/adapter-node";

/**
 * SvelteKit config for the local workflow monitor. Uses the Node adapter so the
 * `+server.ts` proxy routes have a real server runtime when built/previewed;
 * day-to-day the app is run with `vite dev` and never deployed.
 *
 * @type {import('@sveltejs/kit').Config}
 */
const config = {
  kit: {
    adapter: adapter(),
  },
};

export default config;
