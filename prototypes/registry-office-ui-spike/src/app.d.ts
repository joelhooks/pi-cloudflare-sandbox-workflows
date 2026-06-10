import type { RegistryBinding } from "$lib/registry.server";

declare global {
  namespace App {
    interface Platform {
      env?: {
        REGISTRY_WORKER?: RegistryBinding;
      };
    }
  }
}
