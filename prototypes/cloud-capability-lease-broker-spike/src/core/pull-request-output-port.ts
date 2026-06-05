import type {
  OpenPullRequestCapabilityPayload,
  PullRequestReceipt,
} from "./schemas.ts";
import type { GitHubAppSigningHandle } from "./secret-material-store.ts";

export interface PullRequestOutputPort {
  openPullRequest(
    input: OpenPullRequestCapabilityPayload,
    signingHandle: GitHubAppSigningHandle
  ): Promise<PullRequestReceipt>;
}
