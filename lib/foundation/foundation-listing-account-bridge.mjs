function safeSession(value) {
  const session = value && typeof value === "object" ? value : {};
  return {
    connected: Boolean(session.connected ?? session.ok ?? true),
    username: session.username ? String(session.username) : null,
    accountHost: session.accountHost || session.account_host || null,
    connectedAt: session.connectedAt || session.connected_at || null,
    scope: session.scope && typeof session.scope === "object" ? session.scope : null,
  };
}

function listingConnectionError(error) {
  const upstreamCode = String(error?.code || "").trim();
  const exposesSafeMabangCause = upstreamCode.startsWith("MABANG_");
  const upstreamStatus = Number(error?.status);
  const status = Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus < 600
    ? upstreamStatus
    : 502;
  const message = exposesSafeMabangCause
    ? String(error?.message || "Mabang Listing account connection failed.").slice(0, 500)
    : "Mabang Listing account connection failed.";
  return Object.assign(new Error(message), {
    code: exposesSafeMabangCause ? upstreamCode : "FOUNDATION_LISTING_CONNECTION_FAILED",
    status,
    cause: error,
  });
}

export class FoundationListingAccountBridge {
  constructor({
    foundationRepository,
    accountRegistry,
    accountRepository,
    decryptSecret,
    connectListing,
  }) {
    if (typeof decryptSecret !== "function") {
      throw new TypeError("Credential decryptor is required");
    }
    if (typeof connectListing !== "function") {
      throw new TypeError("Listing connector is required");
    }
    this.foundationRepository = foundationRepository;
    this.accountRegistry = accountRegistry;
    this.accountRepository = accountRepository;
    this.decryptSecret = decryptSecret;
    this.connectListing = connectListing;
  }

  async connect(accountId, { accountHost = null } = {}) {
    const account = await this.foundationRepository.getAccount(accountId);
    if (!account || account.status !== "active") {
      throw Object.assign(new Error("The integration account is unavailable."), {
        code: "FOUNDATION_ACCOUNT_UNAVAILABLE",
      });
    }
    if (
      account.sourceSystem !== "mabang"
      || account.credentialRefType !== "mabang_account_profile"
      || !account.credentialRefId
    ) {
      throw Object.assign(new Error("This account cannot provide Mabang Listing credentials."), {
        code: "FOUNDATION_LISTING_CREDENTIAL_BINDING_UNSUPPORTED",
      });
    }
    const profile = await this.accountRepository.get(account.credentialRefId, {
      includeSecret: true,
    });
    if (!profile?.username || !profile?.encryptedPassword) {
      throw Object.assign(new Error("The selected Mabang credentials are incomplete."), {
        code: "FOUNDATION_LISTING_CREDENTIALS_MISSING",
      });
    }

    const password = this.decryptSecret(profile.encryptedPassword);
    if (!password) {
      throw Object.assign(new Error("The selected Mabang password is unavailable."), {
        code: "FOUNDATION_LISTING_CREDENTIALS_MISSING",
      });
    }
    let connected;
    try {
      connected = await this.connectListing({
        username: profile.username,
        password,
        accountHost,
      });
    } catch (error) {
      throw listingConnectionError(error);
    }

    await this.accountRegistry.activateCapabilities(account.id, [
      "listing.read",
      "listing.write",
    ], {
      credentialSource: "mabang_account_profile",
      connectionMode: "memory_only",
    });
    return {
      accountId: account.id,
      sourceSystem: account.sourceSystem,
      session: safeSession(connected),
      secretPersisted: false,
    };
  }
}

