import type { CapabilityPolicyAuthorizer } from "../core/capability-policy-authorizer.ts";
import type {
  CapabilityLeaseRequest,
  CapabilityPolicyDecision,
} from "../core/schemas.ts";

export interface PrototypePolicyAuthorizerOptions {
  allowedRepo: string;
  allowedSecretRef: string;
  branchPrefix: string;
  policyId: string;
}

const MIN_EXPIRY_SECONDS = 60;
const MAX_EXPIRY_SECONDS = 3600;

const isAllowedExpiry = (value: number): boolean =>
  Number.isInteger(value) &&
  Number.isFinite(value) &&
  value >= MIN_EXPIRY_SECONDS &&
  value <= MAX_EXPIRY_SECONDS;

export class PrototypePolicyAuthorizer implements CapabilityPolicyAuthorizer {
  private readonly options: PrototypePolicyAuthorizerOptions;

  constructor(options: PrototypePolicyAuthorizerOptions) {
    this.options = options;
  }

  authorize(input: CapabilityLeaseRequest): Promise<CapabilityPolicyDecision> {
    if (input.capability !== "github.openPullRequest") {
      return Promise.resolve(
        this.denied("capability_denied", "Unsupported capability.")
      );
    }

    if (input.repo !== this.options.allowedRepo) {
      return Promise.resolve(
        this.denied(
          "capability_denied",
          "Repository is outside the prototype allowlist."
        )
      );
    }

    if (input.secretRef !== this.options.allowedSecretRef) {
      return Promise.resolve(
        this.denied(
          "missing_secret_approval",
          "Secret reference is not approved for this capability."
        )
      );
    }

    if (!input.branch.startsWith(this.options.branchPrefix)) {
      return Promise.resolve(
        this.denied(
          "capability_denied",
          "Branch is outside the approved prototype prefix."
        )
      );
    }

    if (!isAllowedExpiry(input.expiresInSeconds)) {
      return Promise.resolve(
        this.denied(
          "capability_denied",
          "Capability lease expiry is outside the approved prototype bounds."
        )
      );
    }

    return Promise.resolve({
      expiresAt: new Date(
        Date.now() + input.expiresInSeconds * 1000
      ).toISOString(),
      policyId: this.options.policyId,
      status: "approved",
    });
  }

  private denied(
    code: "capability_denied" | "missing_secret_approval",
    message: string
  ): CapabilityPolicyDecision {
    return {
      blocker: {
        approvalRef: `approval:${this.options.policyId}`,
        code,
        message,
        redacted: true,
      },
      policyId: this.options.policyId,
      status: "denied",
    };
  }
}
