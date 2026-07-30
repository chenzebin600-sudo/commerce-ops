import {
  FOUNDATION_CAPABILITIES,
  foundationAccountId,
} from "./foundation-contracts.mjs";

const MABANG_CAPABILITIES = Object.freeze([
  "orders.read",
  "inventory.read",
  "images.read",
]);

const MABANG_BINDABLE_CAPABILITIES = Object.freeze([
  "listing.read",
  "listing.write",
]);

export class FoundationAccountRegistry {
  constructor({ repository, now = () => new Date() }) {
    this.repository = repository;
    this.now = now;
  }

  async synchronizeMabangAccounts() {
    const profiles = await this.repository.listMabangProfiles();
    const synchronized = [];
    for (const profile of profiles) {
      const accountId = foundationAccountId("mabang", profile.id);
      const status = Number(profile.enabled) === 0
        ? "disabled"
        : ["failed", "verification_required"].includes(
          String(profile.last_verify_status || "").toLowerCase(),
        )
          ? "verification_required"
          : "active";
      const account = await this.repository.upsertAccount({
        id: accountId,
        sourceSystem: "mabang",
        displayName: profile.name,
        credentialRefType: "mabang_account_profile",
        credentialRefId: profile.id,
        status,
        metadata: {
          usernameHint: `${String(profile.username || "").slice(0, 2)}***`,
          secretCopied: false,
        },
        lastVerifiedAt: profile.last_verified_at || null,
        createdAt: profile.created_at,
      }, this.now());
      for (const capability of MABANG_CAPABILITIES) {
        await this.repository.upsertCapability(accountId, capability, {
          status: status === "disabled" ? "disabled" : "active",
        }, this.now());
      }
      for (const capability of MABANG_BINDABLE_CAPABILITIES) {
        await this.repository.upsertCapability(accountId, capability, {
          status: status === "disabled" ? "disabled" : "requires_binding",
          config: { credentialSource: "mabang_account_profile" },
        }, this.now());
      }
      synchronized.push(account);
    }
    return {
      sourceSystem: "mabang",
      synchronizedCount: synchronized.length,
      capabilities: MABANG_CAPABILITIES,
      bindableCapabilities: MABANG_BINDABLE_CAPABILITIES,
      accounts: synchronized,
    };
  }

  async activateCapabilities(accountId, capabilities, config = {}) {
    for (const capability of capabilities) {
      if (!FOUNDATION_CAPABILITIES.includes(capability)) {
        throw new TypeError(`Unsupported integration capability: ${capability}`);
      }
      await this.repository.upsertCapability(accountId, capability, {
        status: "active",
        config,
      }, this.now());
    }
    return this.repository.getAccount(accountId);
  }

  async resolve({ sourceSystem, capability, accountId = null }) {
    if (!FOUNDATION_CAPABILITIES.includes(capability)) {
      throw new TypeError(`Unsupported integration capability: ${capability}`);
    }
    const accounts = await this.repository.listAccounts({
      sourceSystem,
      capability,
      status: "active",
    });
    if (accountId) {
      const exact = accounts.find((account) => account.id === accountId);
      if (!exact) {
        throw Object.assign(new Error("Requested integration account is unavailable."), {
          code: "FOUNDATION_ACCOUNT_CAPABILITY_UNAVAILABLE",
          accountId,
          capability,
        });
      }
      return exact;
    }
    if (accounts.length === 1) return accounts[0];
    if (accounts.length === 0) {
      throw Object.assign(new Error("No active integration account provides this capability."), {
        code: "FOUNDATION_ACCOUNT_CAPABILITY_UNAVAILABLE",
        sourceSystem,
        capability,
      });
    }
    throw Object.assign(new Error("Multiple integration accounts match; select one explicitly."), {
      code: "FOUNDATION_ACCOUNT_SELECTION_REQUIRED",
      sourceSystem,
      capability,
      accountIds: accounts.map((account) => account.id),
    });
  }
}
