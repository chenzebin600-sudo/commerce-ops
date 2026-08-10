import { createPortableRepositoryExecutor } from "../data/portable-repository-executor.mjs";

function parseJson(value, fallback) {
  if (value !== null && typeof value === "object") return value;
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

const AUTOMATION_MODES = new Set(["OBSERVE_ONLY", "SUGGEST_ONLY", "DRAFT_FILL"]);
const QUALITY_DIMENSION_EXPRESSIONS = Object.freeze({
  country: "suggestion.country_code",
  category: "COALESCE(suggestion.category_name,suggestion.category_id)",
  intent: "suggestion.intent_code",
  risk: "suggestion.risk_level",
  account: "conversation.account_id",
  shop: "suggestion.commerce_shop_id",
  model: "suggestion.model",
});

function automationMode(settings) {
  const value = String(settings?.automationMode || "OBSERVE_ONLY").trim().toUpperCase();
  return AUTOMATION_MODES.has(value) ? value : "OBSERVE_ONLY";
}

function accountRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    channel: row.channel,
    displayName: row.display_name,
    status: row.status,
    settings: parseJson(row.settings_json, {}),
    lastObservedAt: row.last_observed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function accountReadinessRow(row) {
  if (!row) return null;
  return {
    account: accountRow(row),
    observedMessageTotal: Number(row.observed_message_total || 0),
    generatedSuggestionTotal: Number(row.generated_suggestion_total || 0),
    reviewedSuggestionTotal: Number(row.reviewed_suggestion_total || 0),
  };
}

const ACCOUNT_ROLLOUT_SELECT = `SELECT account.*,
  (SELECT COUNT(*) FROM cs_messages message
   JOIN cs_conversations conversation ON conversation.id=message.conversation_id
   WHERE conversation.account_id=account.id AND message.direction='INBOUND') observed_message_total,
  (SELECT COUNT(*) FROM cs_suggestions suggestion
   JOIN cs_conversations conversation ON conversation.id=suggestion.conversation_id
   WHERE conversation.account_id=account.id AND suggestion.generation_finished_at IS NOT NULL
     AND suggestion.draft_ciphertext IS NOT NULL) generated_suggestion_total,
  (SELECT COUNT(*) FROM cs_suggestion_reviews review
   JOIN cs_suggestions suggestion ON suggestion.id=review.suggestion_id
   JOIN cs_conversations conversation ON conversation.id=suggestion.conversation_id
   WHERE conversation.account_id=account.id AND review.action IN ('ACCEPT','EDIT')) reviewed_suggestion_total
  FROM cs_channel_accounts account`;

function workerRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    version: row.version || null,
    capabilities: parseJson(row.capabilities_json, []),
    lastHeartbeatAt: row.last_heartbeat_at || null,
    lastErrorCode: row.last_error_code || null,
    metadata: parseJson(row.metadata_json, {}),
  };
}

function leaseRow(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    workerId: row.worker_id,
    status: row.status,
    leasedUntil: row.leased_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function conversationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name || null,
    channel: row.channel || null,
    shopBindingId: row.shop_binding_id || null,
    shopName: row.shop_name || null,
    countryCode: row.country_code || null,
    commerceShopId: row.commerce_shop_id || null,
    shopIdentityStatus: row.shop_identity_status || null,
    customerDisplayCiphertext: row.customer_display_ciphertext,
    status: row.status,
    priority: row.priority,
    unreadCount: Number(row.unread_count || 0),
    latestMessageAt: row.latest_message_at || null,
    currentInboundMessageId: row.current_inbound_message_id || null,
    handledAt: row.handled_at || null,
    assignedUserId: row.assigned_user_id || null,
    version: Number(row.version || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function messageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    contentType: row.content_type,
    contentCiphertext: row.content_ciphertext,
    sentAt: row.sent_at,
    observedAt: row.observed_at,
    createdAt: row.created_at,
  };
}

function suggestionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    triggerMessageId: row.trigger_message_id,
    contextSnapshotId: row.context_snapshot_id || null,
    status: row.status,
    draftCiphertext: row.draft_ciphertext || null,
    languageCode: row.language_code || null,
    provider: row.provider || null,
    model: row.model || null,
    promptVersion: row.prompt_version || null,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    inputTokens: row.input_tokens === null || row.input_tokens === undefined ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens === null || row.output_tokens === undefined ? null : Number(row.output_tokens),
    totalTokens: row.total_tokens === null || row.total_tokens === undefined ? null : Number(row.total_tokens),
    intentCode: row.intent_code || null,
    riskLevel: row.risk_level || null,
    countryCode: row.country_code || null,
    commerceShopId: row.commerce_shop_id || null,
    productModelId: row.product_model_id || null,
    productSkuId: row.product_sku_id || null,
    categoryId: row.category_id || null,
    categoryName: row.category_name || null,
    qualityFlags: parseJson(row.quality_flags_json, []),
    errorCode: row.error_code || null,
    supersededByMessageId: row.superseded_by_message_id || null,
    generationStartedAt: row.generation_started_at || null,
    generationFinishedAt: row.generation_finished_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function repositoryError(code, message, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

export class CustomerServiceRepository {
  constructor({ provider }) {
    if (!provider) throw new TypeError("Database provider is required");
    this.provider = createPortableRepositoryExecutor(provider);
  }

  async isReady() {
    try {
      await this.provider.query("SELECT 1 FROM cs_channel_accounts LIMIT 1");
      await this.provider.query("SELECT 1 FROM cs_conversations LIMIT 1");
      await this.provider.query("SELECT 1 FROM cs_suggestions LIMIT 1");
      return true;
    } catch {
      return false;
    }
  }

  async createAccount(input) {
    await this.provider.execute(
      `INSERT INTO cs_channel_accounts (
         id,channel,display_name,external_account_key_digest,status,settings_json,
         last_observed_at,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?)`,
      [input.id, input.channel, input.displayName, input.externalAccountKeyDigest,
        input.status, JSON.stringify(input.settings || {}), null, input.now, input.now],
    );
    return this.getAccount(input.id);
  }

  async getAccount(id) {
    const result = await this.provider.query(
      "SELECT * FROM cs_channel_accounts WHERE id=? LIMIT 1",
      [String(id || "")],
    );
    return accountRow(result.rows[0]);
  }

  async listAccounts() {
    const result = await this.provider.query(
      "SELECT * FROM cs_channel_accounts ORDER BY display_name,id",
    );
    return result.rows.map(accountRow);
  }

  async listAccountRolloutReadiness() {
    const result = await this.provider.query(`${ACCOUNT_ROLLOUT_SELECT} ORDER BY account.display_name,account.id`);
    return result.rows.map(accountReadinessRow);
  }

  async accountRolloutReadiness(id) {
    const row = (await this.provider.query(
      `${ACCOUNT_ROLLOUT_SELECT} WHERE account.id=? LIMIT 1`,
      [id],
    )).rows[0];
    return accountReadinessRow(row);
  }

  async updateAccountAutomation({ id, mode, actorId, now }) {
    return this.provider.transaction(async (tx) => {
      await tx.execute("UPDATE cs_channel_accounts SET updated_at=updated_at WHERE id=?", [id]);
      const row = (await tx.query(
        "SELECT * FROM cs_channel_accounts WHERE id=? LIMIT 1",
        [id],
      )).rows[0];
      if (!row) return null;
      const settings = parseJson(row.settings_json, {});
      const nextSettings = {
        ...settings,
        automationMode: mode,
        automationUpdatedAt: now,
        automationUpdatedBy: actorId,
      };
      await tx.execute(
        "UPDATE cs_channel_accounts SET settings_json=?,updated_at=? WHERE id=?",
        [JSON.stringify(nextSettings), now, id],
      );
      if (mode === "OBSERVE_ONLY") {
        await tx.execute(
          `UPDATE cs_suggestions SET status='STALE',error_code='ACCOUNT_AUTOMATION_MODE_CHANGED',updated_at=?
           WHERE conversation_id IN (SELECT id FROM cs_conversations WHERE account_id=?)
             AND status IN ('QUEUED','GENERATING')`,
          [now, id],
        );
      }
      if (mode !== "DRAFT_FILL") {
        await tx.execute(
          `UPDATE cs_worker_commands SET status='CANCELED',result_code='ACCOUNT_DRAFT_FILL_DISABLED',
             result_json=?,leased_until=NULL,updated_at=?
           WHERE account_id=? AND command_type='FILL_DRAFT' AND status IN ('PENDING','LEASED')`,
          [JSON.stringify({
            cancellationSource: "ACCOUNT_AUTOMATION_UPDATE",
            reasonCode: "ACCOUNT_DRAFT_FILL_DISABLED",
            automationMode: mode,
            automaticSend: false,
          }), now, id],
        );
      }
      return accountRow({ ...row, settings_json: JSON.stringify(nextSettings), updated_at: now });
    });
  }

  async getShopBinding(id) {
    const row = (await this.provider.query(
      "SELECT * FROM cs_channel_shop_bindings WHERE id=? LIMIT 1", [String(id || "")],
    )).rows[0];
    return row ? {
      id: row.id,
      accountId: row.account_id,
      commerceShopId: row.commerce_shop_id || null,
      shopName: row.shop_name,
      countryCode: row.country_code || null,
      identityStatus: row.identity_status,
      evidence: parseJson(row.evidence_json, {}),
      updatedAt: row.updated_at,
    } : null;
  }

  async confirmShopBinding({ id, commerceShopId, actorId, evidence, now }) {
    const result = await this.provider.execute(
      `UPDATE cs_channel_shop_bindings SET commerce_shop_id=?,identity_status='CONFIRMED',
         evidence_json=?,updated_at=? WHERE id=?`,
      [commerceShopId, JSON.stringify({ ...(evidence || {}), confirmedBy: actorId, confirmedAt: now }), now, id],
    );
    return result.rowCount ? this.getShopBinding(id) : null;
  }

  async registerWorker(input) {
    await this.provider.execute(
      `INSERT INTO cs_worker_nodes (
         id,display_name,status,version,capabilities_json,last_heartbeat_at,last_error_code,
         metadata_json,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         display_name=excluded.display_name,status='ONLINE',version=excluded.version,
         capabilities_json=excluded.capabilities_json,last_heartbeat_at=excluded.last_heartbeat_at,
         last_error_code=NULL,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`,
      [input.id, input.displayName, "ONLINE", input.version, JSON.stringify(input.capabilities || []),
        input.now, null, JSON.stringify(input.metadata || {}), input.now, input.now],
    );
    return this.getWorker(input.id);
  }

  async getWorker(id) {
    const result = await this.provider.query("SELECT * FROM cs_worker_nodes WHERE id=? LIMIT 1", [id]);
    return workerRow(result.rows[0]);
  }

  async acquireAccountLease({ accountId, workerId, presentedTokenDigest, leaseTokenDigest, now, leasedUntil }) {
    return this.provider.transaction(async (tx) => {
      const account = (await tx.query(
        "SELECT id,status FROM cs_channel_accounts WHERE id=? LIMIT 1",
        [accountId],
      )).rows[0];
      if (!account) throw repositoryError("CS_ACCOUNT_NOT_FOUND", "Channel account was not found", 404);
      if (new Set(["DISABLED", "ERROR"]).has(account.status)) {
        throw repositoryError("CS_ACCOUNT_LEASE_DISABLED", "Channel account is not available for a browser lease", 409);
      }
      // Serialize first acquisition even when no lease row exists yet. This
      // harmless no-op update locks the canonical account row in both SQLite
      // and PostgreSQL before the lease is inspected/upserted.
      await tx.execute("UPDATE cs_channel_accounts SET updated_at=updated_at WHERE id=?", [accountId]);
      const worker = (await tx.query(
        "SELECT id,status FROM cs_worker_nodes WHERE id=? LIMIT 1",
        [workerId],
      )).rows[0];
      if (!worker) throw repositoryError("CS_WORKER_NOT_REGISTERED", "Worker is not registered", 404);
      if (worker.status === "DISABLED") {
        throw repositoryError("CS_WORKER_DISABLED", "Worker is disabled", 409);
      }

      const current = (await tx.query(
        "SELECT * FROM cs_worker_account_leases WHERE account_id=? LIMIT 1",
        [accountId],
      )).rows[0];
      const currentLeaseExpiry = Date.parse(current?.leased_until || "");
      const currentActive = current?.status === "ACTIVE"
        && Number.isFinite(currentLeaseExpiry)
        && currentLeaseExpiry > Date.parse(now);
      if (currentActive) {
        const renewal = current.worker_id === workerId
          && Boolean(presentedTokenDigest)
          && current.lease_token_digest === presentedTokenDigest;
        if (!renewal) {
          return {
            acquired: false,
            conflict: true,
            accountId,
            leasedUntil: current.leased_until,
          };
        }
        await tx.execute(
          `UPDATE cs_worker_account_leases SET leased_until=?,updated_at=?
           WHERE account_id=? AND worker_id=? AND status='ACTIVE' AND lease_token_digest=?`,
          [leasedUntil, now, accountId, workerId, presentedTokenDigest],
        );
        return {
          acquired: true,
          renewed: true,
          lease: leaseRow({ ...current, leased_until: leasedUntil, updated_at: now }),
        };
      }

      await tx.execute(
        `INSERT INTO cs_worker_account_leases (
           account_id,worker_id,status,lease_token_digest,leased_until,created_at,updated_at
         ) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(account_id) DO UPDATE SET
           worker_id=excluded.worker_id,status='ACTIVE',lease_token_digest=excluded.lease_token_digest,
           leased_until=excluded.leased_until,updated_at=excluded.updated_at`,
        [accountId, workerId, "ACTIVE", leaseTokenDigest, leasedUntil,
          current?.created_at || now, now],
      );
      return {
        acquired: true,
        renewed: false,
        lease: {
          accountId,
          workerId,
          status: "ACTIVE",
          leasedUntil,
          createdAt: current?.created_at || now,
          updatedAt: now,
        },
      };
    });
  }

  async validateAccountLease({ accountId, workerId, leaseTokenDigest, now }) {
    const row = (await this.provider.query(
      `SELECT * FROM cs_worker_account_leases
       WHERE account_id=? AND worker_id=? AND status='ACTIVE'
         AND lease_token_digest=? AND leased_until>? LIMIT 1`,
      [accountId, workerId, leaseTokenDigest, now],
    )).rows[0];
    return leaseRow(row);
  }

  async releaseAccountLease({ accountId, workerId, leaseTokenDigest, now }) {
    const result = await this.provider.execute(
      `UPDATE cs_worker_account_leases SET status='RELEASED',leased_until=?,updated_at=?
       WHERE account_id=? AND worker_id=? AND status='ACTIVE' AND lease_token_digest=?`,
      [now, now, accountId, workerId, leaseTokenDigest],
    );
    return result.rowCount > 0;
  }

  async heartbeatWorker(input) {
    const result = await this.provider.execute(
      `UPDATE cs_worker_nodes SET status=?,version=COALESCE(?,version),
         capabilities_json=COALESCE(?,capabilities_json),last_heartbeat_at=?,last_error_code=?,
         metadata_json=COALESCE(?,metadata_json),updated_at=? WHERE id=?`,
      [input.status, input.version, input.capabilities ? JSON.stringify(input.capabilities) : null,
        input.now, input.lastErrorCode, input.metadata ? JSON.stringify(input.metadata) : null,
        input.now, input.id],
    );
    if (!result.rowCount) throw repositoryError("CS_WORKER_NOT_REGISTERED", "Worker is not registered", 404);
    return this.getWorker(input.id);
  }

  async ingestObservation(input) {
    return this.provider.transaction(async (tx) => {
      const prior = (await tx.query(
        `SELECT id,event_key,worker_id,sequence_no,payload_digest,result_json
         FROM cs_ingest_events WHERE event_key=? OR (worker_id=? AND sequence_no=?) LIMIT 1`,
        [input.event.eventKey, input.event.workerId, input.event.sequenceNo],
      )).rows[0];
      if (prior) {
        if (prior.payload_digest !== input.event.payloadDigest || prior.event_key !== input.event.eventKey) {
          throw repositoryError(
            "CS_EVENT_IDEMPOTENCY_CONFLICT",
            "Worker event key or sequence was reused with a different payload",
          );
        }
        return { duplicateEvent: true, eventId: prior.id, ...parseJson(prior.result_json, {}) };
      }

      const worker = (await tx.query("SELECT id FROM cs_worker_nodes WHERE id=? LIMIT 1", [input.event.workerId])).rows[0];
      if (!worker) throw repositoryError("CS_WORKER_NOT_REGISTERED", "Worker is not registered", 404);
      const account = (await tx.query(
        "SELECT id,status,settings_json FROM cs_channel_accounts WHERE id=? LIMIT 1",
        [input.event.accountId],
      )).rows[0];
      if (!account) throw repositoryError("CS_ACCOUNT_NOT_FOUND", "Channel account was not found", 404);
      const accountMode = automationMode(parseJson(account.settings_json, {}));
      const suggestionEnabled = !new Set(["PAUSED", "DISABLED", "ERROR"]).has(account.status)
        && accountMode !== "OBSERVE_ONLY";

      await tx.execute(
        `INSERT INTO cs_ingest_events (
           id,event_key,worker_id,account_id,sequence_no,event_type,payload_digest,
           observed_at,processed_at,processing_status,result_json,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [input.event.id, input.event.eventKey, input.event.workerId, input.event.accountId,
          input.event.sequenceNo, input.event.eventType, input.event.payloadDigest,
          input.event.observedAt, null, "RECEIVED", "{}", input.now],
      );

      let shopBindingId = null;
      if (input.shop) {
        const existingShop = (await tx.query(
          "SELECT id FROM cs_channel_shop_bindings WHERE account_id=? AND external_shop_key_digest=? LIMIT 1",
          [input.event.accountId, input.shop.externalShopKeyDigest],
        )).rows[0];
        shopBindingId = existingShop?.id || input.shop.id;
        await tx.execute(
          `INSERT INTO cs_channel_shop_bindings (
             id,account_id,external_shop_key_digest,commerce_shop_id,shop_name,country_code,
             identity_status,evidence_json,first_seen_at,last_seen_at,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(account_id,external_shop_key_digest) DO UPDATE SET
             shop_name=excluded.shop_name,country_code=COALESCE(excluded.country_code,cs_channel_shop_bindings.country_code),
             last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`,
          [shopBindingId, input.event.accountId, input.shop.externalShopKeyDigest, null,
            input.shop.shopName, input.shop.countryCode, "UNRESOLVED", "{}",
            input.event.observedAt, input.event.observedAt, input.now, input.now],
        );
      }

      const existingConversation = (await tx.query(
        `SELECT * FROM cs_conversations
         WHERE account_id=? AND external_conversation_digest=? LIMIT 1`,
        [input.event.accountId, input.conversation.externalConversationDigest],
      )).rows[0];
      const conversationId = existingConversation?.id || input.conversation.id;
      if (!existingConversation) {
        await tx.execute(
          `INSERT INTO cs_conversations (
             id,account_id,shop_binding_id,external_conversation_digest,routing_ciphertext,customer_external_digest,
             customer_display_ciphertext,status,priority,unread_count,latest_message_at,
             current_inbound_message_id,handled_at,assigned_user_id,version,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [conversationId, input.event.accountId, shopBindingId,
            input.conversation.externalConversationDigest, input.conversation.routingCiphertext,
            input.conversation.customerExternalDigest,
            input.conversation.customerDisplayCiphertext, "OPEN", input.conversation.priority,
            0, null, null, null, null, 1, input.now, input.now],
        );
      } else {
        await tx.execute(
          `UPDATE cs_conversations SET shop_binding_id=COALESCE(?,shop_binding_id),
             routing_ciphertext=?,customer_display_ciphertext=?,updated_at=? WHERE id=?`,
          [shopBindingId, input.conversation.routingCiphertext,
            input.conversation.customerDisplayCiphertext, input.now, conversationId],
        );
      }

      const existingMessage = (await tx.query(
        "SELECT id,conversation_id FROM cs_messages WHERE account_id=? AND external_message_digest=? LIMIT 1",
        [input.event.accountId, input.message.externalMessageDigest],
      )).rows[0];
      if (existingMessage) {
        if (existingMessage.conversation_id !== conversationId) {
          throw repositoryError("CS_MESSAGE_IDENTITY_CONFLICT", "Message identity belongs to another conversation");
        }
        await tx.execute(
          "UPDATE cs_messages SET routing_ciphertext=? WHERE id=?",
          [input.message.routingCiphertext, existingMessage.id],
        );
        await tx.execute(
          `INSERT INTO cs_message_observations (
             id,message_id,worker_id,event_id,observation_json,observed_at,created_at
           ) VALUES (?,?,?,?,?,?,?)`,
          [input.observationId, existingMessage.id, input.event.workerId, input.event.id,
            JSON.stringify(input.observation || {}), input.event.observedAt, input.now],
        );
        if (input.panel) {
          await tx.execute(
            `INSERT INTO cs_panel_snapshots (
               id,conversation_id,trigger_message_id,worker_id,snapshot_ciphertext,snapshot_digest,
               completeness_json,observed_at,created_at
             ) VALUES (?,?,?,?,?,?,?,?,?)`,
            [input.panel.id, conversationId, existingMessage.id, input.event.workerId,
              input.panel.snapshotCiphertext, input.panel.snapshotDigest,
              JSON.stringify(input.panel.completeness || {}), input.event.observedAt, input.now],
          );
        }
        const result = { conversationId, messageId: existingMessage.id, duplicateMessage: true, suggestionId: null };
        await tx.execute(
          `UPDATE cs_ingest_events SET processed_at=?,processing_status='PROCESSED',result_json=? WHERE id=?`,
          [input.now, JSON.stringify(result), input.event.id],
        );
        return { duplicateEvent: false, ...result };
      }

      await tx.execute(
        `INSERT INTO cs_messages (
           id,event_id,account_id,conversation_id,external_message_digest,routing_ciphertext,direction,content_type,
           content_ciphertext,content_digest,sent_at,observed_at,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [input.message.id, input.event.id, input.event.accountId, conversationId,
          input.message.externalMessageDigest, input.message.routingCiphertext,
          input.message.direction, input.message.contentType,
          input.message.contentCiphertext, input.message.contentDigest, input.message.sentAt,
          input.event.observedAt, input.now],
      );
      await tx.execute(
        `INSERT INTO cs_message_observations (
           id,message_id,worker_id,event_id,observation_json,observed_at,created_at
         ) VALUES (?,?,?,?,?,?,?)`,
        [input.observationId, input.message.id, input.event.workerId, input.event.id,
          JSON.stringify(input.observation || {}), input.event.observedAt, input.now],
      );

      let suggestionId = null;
      if (input.message.direction === "INBOUND") {
        await tx.execute(
          `UPDATE cs_suggestions SET status='STALE',superseded_by_message_id=?,updated_at=?
           WHERE conversation_id=? AND status IN ('QUEUED','GENERATING','READY')`,
          [input.message.id, input.now, conversationId],
        );
        await tx.execute(
          `UPDATE cs_worker_commands SET status='CANCELED',result_code='SUPERSEDED_BY_NEW_MESSAGE',updated_at=?
           WHERE conversation_id=? AND status IN ('PENDING','LEASED')
             AND command_type IN ('FILL_DRAFT','FOCUS_CONVERSATION','CAPTURE_PANEL')`,
          [input.now, conversationId],
        );
        if (suggestionEnabled) {
          suggestionId = input.suggestionId;
          await tx.execute(
            `INSERT INTO cs_suggestions (
               id,conversation_id,trigger_message_id,context_snapshot_id,status,draft_ciphertext,
               language_code,provider,model,prompt_version,confidence,quality_flags_json,error_code,
               superseded_by_message_id,generation_started_at,generation_finished_at,created_at,updated_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [suggestionId, conversationId, input.message.id, null, "QUEUED", null, null, null,
              null, null, null, "[]", null, null, null, null, input.now, input.now],
          );
        }
      }

      if (input.message.direction === "OUTBOUND") {
        const previousOutbound = (await tx.query(
          `SELECT id,sent_at FROM cs_messages
           WHERE conversation_id=? AND direction='OUTBOUND' AND id<>? AND sent_at<=?
           ORDER BY sent_at DESC,created_at DESC,id DESC LIMIT 1`,
          [conversationId, input.message.id, input.message.sentAt],
        )).rows[0] || null;
        const unansweredInbound = (await tx.query(
          `SELECT id,sent_at FROM cs_messages
           WHERE conversation_id=? AND direction='INBOUND'
             ${previousOutbound ? "AND sent_at>?" : ""} AND sent_at<=?
           ORDER BY sent_at,created_at,id LIMIT 1`,
          previousOutbound
            ? [conversationId, previousOutbound.sent_at, input.message.sentAt]
            : [conversationId, input.message.sentAt],
        )).rows[0] || null;
        const responseLatency = unansweredInbound
          ? Date.parse(input.message.sentAt) - Date.parse(unansweredInbound.sent_at)
          : Number.NaN;
        const responseLatencyMs = Number.isFinite(responseLatency)
          && responseLatency >= 0
          && responseLatency <= 7 * 24 * 60 * 60 * 1_000
          ? responseLatency
          : null;
        const filledActions = (await tx.query(
          `SELECT filled.id,filled.suggestion_id,filled.detail_json,filled.created_at
           FROM cs_send_actions filled
           WHERE filled.conversation_id=? AND filled.action='DRAFT_FILLED' AND filled.outcome='SUCCEEDED'
             AND filled.created_at<=?
             AND (filled.suggestion_id IS NULL OR NOT EXISTS (
               SELECT 1 FROM cs_send_actions observed
               WHERE observed.action='SEND_OBSERVED' AND observed.suggestion_id=filled.suggestion_id
             ))
           ORDER BY filled.created_at DESC,filled.id DESC LIMIT 20`,
          [conversationId, input.event.observedAt],
        )).rows;
        const matchedFill = filledActions.find((row) => (
          parseJson(row.detail_json, {}).draftContentDigest === input.message.contentDigest
        )) || null;
        await tx.execute(
          `INSERT INTO cs_send_actions (
             id,conversation_id,suggestion_id,message_id,action,actor_type,actor_id,outcome,detail_json,created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
          [`${input.message.id}:send-observed`, conversationId, matchedFill?.suggestion_id || null,
            input.message.id, "SEND_OBSERVED", "WORKER", input.event.workerId,
            matchedFill ? "MATCHED_AI_DRAFT" : "HUMAN_OR_UNMATCHED",
            JSON.stringify({
              automaticSend: false,
              matchMethod: matchedFill ? "DRAFT_CONTENT_DIGEST" : null,
              draftFilledActionId: matchedFill?.id || null,
              responseFromMessageId: responseLatencyMs === null ? null : unansweredInbound?.id || null,
              responseLatencyMs,
            }), input.event.observedAt],
        );
      }

      if (input.panel) {
        await tx.execute(
          `INSERT INTO cs_panel_snapshots (
             id,conversation_id,trigger_message_id,worker_id,snapshot_ciphertext,snapshot_digest,
             completeness_json,observed_at,created_at
           ) VALUES (?,?,?,?,?,?,?,?,?)`,
          [input.panel.id, conversationId, input.message.id, input.event.workerId,
            input.panel.snapshotCiphertext, input.panel.snapshotDigest,
            JSON.stringify(input.panel.completeness || {}), input.event.observedAt, input.now],
        );
      }

      const inbound = input.message.direction === "INBOUND";
      await tx.execute(
        `UPDATE cs_conversations SET status=?,unread_count=unread_count+?,latest_message_at=?,
           current_inbound_message_id=COALESCE(?,current_inbound_message_id),handled_at=NULL,
           version=version+1,updated_at=? WHERE id=?`,
        [inbound ? "OPEN" : (existingConversation?.status || "OPEN"), inbound ? 1 : 0,
          input.message.sentAt, inbound ? input.message.id : null, input.now, conversationId],
      );
      await tx.execute(
        `UPDATE cs_channel_accounts SET
           status=CASE WHEN status IN ('PAUSED','DISABLED') THEN status ELSE 'ACTIVE' END,
           last_observed_at=?,updated_at=? WHERE id=?`,
        [input.event.observedAt, input.now, input.event.accountId],
      );
      const result = { conversationId, messageId: input.message.id, duplicateMessage: false, suggestionId };
      await tx.execute(
        `UPDATE cs_ingest_events SET processed_at=?,processing_status='PROCESSED',result_json=? WHERE id=?`,
        [input.now, JSON.stringify(result), input.event.id],
      );
      return { duplicateEvent: false, ...result };
    });
  }

  async listInbox({ accountId = null, status = "OPEN", limit = 100 } = {}) {
    const where = [];
    const parameters = [];
    if (accountId) {
      where.push("conversation.account_id=?");
      parameters.push(accountId);
    }
    if (status && status !== "ALL") {
      where.push("conversation.status=?");
      parameters.push(status);
    }
    parameters.push(limit);
    const result = await this.provider.query(
      `SELECT conversation.*,account.display_name AS account_name,account.channel,
         shop.shop_name,shop.country_code,shop.commerce_shop_id,shop.identity_status shop_identity_status,
         message.content_ciphertext AS latest_content_ciphertext,
         message.content_type AS latest_content_type,
         suggestion.id AS suggestion_id,suggestion.status AS suggestion_status,
         suggestion.draft_ciphertext AS suggestion_draft_ciphertext,
         suggestion.updated_at AS suggestion_updated_at
       FROM cs_conversations conversation
       JOIN cs_channel_accounts account ON account.id=conversation.account_id
       LEFT JOIN cs_channel_shop_bindings shop ON shop.id=conversation.shop_binding_id
       LEFT JOIN cs_messages message ON message.id=conversation.current_inbound_message_id
       LEFT JOIN cs_suggestions suggestion ON suggestion.id=(
         SELECT candidate.id FROM cs_suggestions candidate
         WHERE candidate.conversation_id=conversation.id
         ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1
       )
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY CASE conversation.priority
         WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END,
         conversation.latest_message_at DESC,conversation.id
       LIMIT ?`,
      parameters,
    );
    return result.rows.map((row) => ({
      ...conversationRow(row),
      latestContentCiphertext: row.latest_content_ciphertext || null,
      latestContentType: row.latest_content_type || null,
      suggestion: row.suggestion_id ? {
        id: row.suggestion_id,
        status: row.suggestion_status,
        draftCiphertext: row.suggestion_draft_ciphertext || null,
        updatedAt: row.suggestion_updated_at,
      } : null,
    }));
  }

  async getConversation(id) {
    const header = (await this.provider.query(
      `SELECT conversation.*,account.display_name AS account_name,account.channel,
         shop.shop_name,shop.country_code,shop.commerce_shop_id,shop.identity_status shop_identity_status
       FROM cs_conversations conversation
       JOIN cs_channel_accounts account ON account.id=conversation.account_id
       LEFT JOIN cs_channel_shop_bindings shop ON shop.id=conversation.shop_binding_id
       WHERE conversation.id=? LIMIT 1`,
      [id],
    )).rows[0];
    if (!header) return null;
    const messages = (await this.provider.query(
      "SELECT * FROM cs_messages WHERE conversation_id=? ORDER BY sent_at,created_at,id",
      [id],
    )).rows.map(messageRow);
    const suggestions = (await this.provider.query(
      "SELECT * FROM cs_suggestions WHERE conversation_id=? ORDER BY created_at DESC,id DESC",
      [id],
    )).rows.map(suggestionRow);
    const suggestionIds = suggestions.map((item) => item.id);
    let evidence = [];
    if (suggestionIds.length) {
      const result = await this.provider.query(
        `SELECT * FROM cs_suggestion_evidence
         WHERE suggestion_id IN (${suggestionIds.map(() => "?").join(",")})
         ORDER BY suggestion_id,rank_no,id`,
        suggestionIds,
      );
      evidence = result.rows.map((row) => ({
        id: row.id,
        suggestionId: row.suggestion_id,
        sourceType: row.source_type,
        sourceId: row.source_id || null,
        sourceVersion: row.source_version || null,
        label: row.label,
        excerptCiphertext: row.excerpt_ciphertext || null,
        rank: Number(row.rank_no || 0),
        metadata: parseJson(row.metadata_json, {}),
      }));
    }
    const sendActions = (await this.provider.query(
      `SELECT id,suggestion_id,message_id,action,actor_type,outcome,detail_json,created_at
       FROM cs_send_actions WHERE conversation_id=? ORDER BY created_at,id`,
      [id],
    )).rows.map((row) => ({
      id: row.id,
      suggestionId: row.suggestion_id || null,
      messageId: row.message_id || null,
      action: row.action,
      actorType: row.actor_type,
      outcome: row.outcome,
      detail: parseJson(row.detail_json, {}),
      createdAt: row.created_at,
    }));
    return { conversation: conversationRow(header), messages, suggestions, evidence, sendActions };
  }

  async getContextSource(id) {
    const header = (await this.provider.query(
      `SELECT conversation.*,account.display_name account_name,account.channel,
         shop.shop_name,shop.country_code,shop.commerce_shop_id,shop.identity_status shop_identity_status
       FROM cs_conversations conversation
       JOIN cs_channel_accounts account ON account.id=conversation.account_id
       LEFT JOIN cs_channel_shop_bindings shop ON shop.id=conversation.shop_binding_id
       WHERE conversation.id=? LIMIT 1`,
      [id],
    )).rows[0];
    if (!header) return null;
    const messages = (await this.provider.query(
      `SELECT * FROM (
         SELECT * FROM cs_messages WHERE conversation_id=?
         ORDER BY sent_at DESC,created_at DESC,id DESC LIMIT 20
       ) recent ORDER BY sent_at,created_at,id`,
      [id],
    )).rows.map(messageRow);
    const panel = header.current_inbound_message_id ? (await this.provider.query(
      `SELECT * FROM cs_panel_snapshots
       WHERE conversation_id=? AND trigger_message_id=?
       ORDER BY observed_at DESC,created_at DESC,id DESC LIMIT 1`,
      [id, header.current_inbound_message_id],
    )).rows[0] : null;
    return {
      conversation: conversationRow(header),
      messages,
      panel: panel ? {
        id: panel.id,
        triggerMessageId: panel.trigger_message_id,
        snapshotCiphertext: panel.snapshot_ciphertext,
        snapshotDigest: panel.snapshot_digest,
        completeness: parseJson(panel.completeness_json, {}),
        observedAt: panel.observed_at,
      } : null,
    };
  }

  async saveContextSnapshot(input) {
    return this.provider.transaction(async (tx) => {
      const conversation = (await tx.query(
        "SELECT current_inbound_message_id FROM cs_conversations WHERE id=? LIMIT 1",
        [input.conversationId],
      )).rows[0];
      if (!conversation) return null;
      if (conversation.current_inbound_message_id !== input.triggerMessageId) {
        throw repositoryError(
          "CS_CONTEXT_TRIGGER_STALE",
          "A newer inbound message arrived while the Context snapshot was being built",
        );
      }
      const existing = (await tx.query(
        `SELECT id,context_version,context_digest,evidence_count,missing_fields_json,built_at,expires_at
         FROM cs_context_snapshots
         WHERE conversation_id=? AND trigger_message_id=? AND context_digest=?
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        [input.conversationId, input.triggerMessageId, input.contextDigest],
      )).rows[0];
      if (existing) {
        return {
          id: existing.id,
          duplicate: true,
          contextVersion: existing.context_version,
          contextDigest: existing.context_digest,
          evidenceCount: Number(existing.evidence_count || 0),
          missingFields: parseJson(existing.missing_fields_json, []),
          builtAt: existing.built_at,
          expiresAt: existing.expires_at || null,
        };
      }
      await tx.execute(
        `INSERT INTO cs_context_snapshots (
           id,conversation_id,trigger_message_id,context_ciphertext,context_digest,context_version,
           evidence_count,missing_fields_json,built_at,expires_at,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [input.id, input.conversationId, input.triggerMessageId, input.contextCiphertext,
          input.contextDigest, input.contextVersion, input.evidenceCount,
          JSON.stringify(input.missingFields || []), input.builtAt, input.expiresAt, input.createdAt],
      );
      await tx.execute(
        `UPDATE cs_suggestions SET context_snapshot_id=?,updated_at=?
         WHERE conversation_id=? AND trigger_message_id=? AND status IN ('QUEUED','GENERATING','READY')`,
        [input.id, input.createdAt, input.conversationId, input.triggerMessageId],
      );
      return {
        id: input.id,
        duplicate: false,
        contextVersion: input.contextVersion,
        contextDigest: input.contextDigest,
        evidenceCount: input.evidenceCount,
        missingFields: input.missingFields,
        builtAt: input.builtAt,
        expiresAt: input.expiresAt,
      };
    });
  }

  async getContextSnapshot(id) {
    const row = (await this.provider.query(
      `SELECT snapshot.*,conversation.current_inbound_message_id
       FROM cs_context_snapshots snapshot
       JOIN cs_conversations conversation ON conversation.id=snapshot.conversation_id
       WHERE snapshot.id=? LIMIT 1`,
      [id],
    )).rows[0];
    if (!row) return null;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      triggerMessageId: row.trigger_message_id,
      currentInboundMessageId: row.current_inbound_message_id,
      contextCiphertext: row.context_ciphertext,
      contextDigest: row.context_digest,
      contextVersion: row.context_version,
      evidenceCount: Number(row.evidence_count || 0),
      missingFields: parseJson(row.missing_fields_json, []),
      builtAt: row.built_at,
      expiresAt: row.expires_at || null,
    };
  }

  async getLatestContextSnapshotForConversation(conversationId) {
    const row = (await this.provider.query(
      `SELECT snapshot.id FROM cs_context_snapshots snapshot
       JOIN cs_conversations conversation ON conversation.id=snapshot.conversation_id
       WHERE snapshot.conversation_id=? AND snapshot.trigger_message_id=conversation.current_inbound_message_id
       ORDER BY snapshot.built_at DESC,snapshot.created_at DESC,snapshot.id DESC LIMIT 1`,
      [conversationId],
    )).rows[0];
    return row ? this.getContextSnapshot(row.id) : null;
  }

  async queueReplySuggestion({ id, conversationId, actorId, now }) {
    return this.provider.transaction(async (tx) => {
      const conversation = (await tx.query(
        "SELECT current_inbound_message_id FROM cs_conversations WHERE id=? LIMIT 1",
        [conversationId],
      )).rows[0];
      if (!conversation) return null;
      if (!conversation.current_inbound_message_id) {
        throw repositoryError("CS_REPLY_TRIGGER_MISSING", "Conversation has no current inbound message");
      }
      const active = (await tx.query(
        `SELECT * FROM cs_suggestions WHERE conversation_id=? AND trigger_message_id=?
         AND status IN ('QUEUED','GENERATING') ORDER BY created_at DESC,id DESC LIMIT 1`,
        [conversationId, conversation.current_inbound_message_id],
      )).rows[0];
      if (active) return { ...suggestionRow(active), duplicate: true };
      await tx.execute(
        `UPDATE cs_suggestions SET status='STALE',superseded_by_message_id=?,updated_at=?
         WHERE conversation_id=? AND trigger_message_id=? AND status IN ('READY','FAILED')`,
        [conversation.current_inbound_message_id, now, conversationId, conversation.current_inbound_message_id],
      );
      await tx.execute(
        `UPDATE cs_worker_commands SET status='CANCELED',result_code='MANUAL_REGENERATION',updated_at=?
         WHERE conversation_id=? AND trigger_message_id=? AND status IN ('PENDING','LEASED')
           AND command_type='FILL_DRAFT'`,
        [now, conversationId, conversation.current_inbound_message_id],
      );
      await tx.execute(
        `INSERT INTO cs_suggestions (
           id,conversation_id,trigger_message_id,context_snapshot_id,status,draft_ciphertext,
           language_code,provider,model,prompt_version,confidence,quality_flags_json,error_code,
           superseded_by_message_id,generation_started_at,generation_finished_at,created_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, conversationId, conversation.current_inbound_message_id, null, "QUEUED", null,
          null, null, null, null, null, JSON.stringify(["MANUALLY_REQUEUED"]), null,
          null, null, null, now, now],
      );
      return {
        id,
        conversationId,
        triggerMessageId: conversation.current_inbound_message_id,
        status: "QUEUED",
        actorId,
        duplicate: false,
      };
    });
  }

  async markHandled({ conversationId, actorId, actionId, now }) {
    return this.provider.transaction(async (tx) => {
      const conversation = (await tx.query(
        "SELECT id,status,handled_at FROM cs_conversations WHERE id=? LIMIT 1",
        [conversationId],
      )).rows[0];
      if (!conversation) return null;
      if (conversation.status === "HANDLED") {
        return { id: conversationId, status: "HANDLED", handledAt: conversation.handled_at || null, duplicate: true };
      }
      const previousHandled = (await tx.query(
        `SELECT created_at FROM cs_send_actions
         WHERE conversation_id=? AND action='MARK_HANDLED' AND outcome='SUCCEEDED'
         ORDER BY created_at DESC,id DESC LIMIT 1`,
        [conversationId],
      )).rows[0] || null;
      const firstInbound = (await tx.query(
        `SELECT id,observed_at FROM cs_messages
         WHERE conversation_id=? AND direction='INBOUND'
           ${previousHandled ? "AND observed_at>?" : ""} AND observed_at<=?
         ORDER BY observed_at,created_at,id LIMIT 1`,
        previousHandled
          ? [conversationId, previousHandled.created_at, now]
          : [conversationId, now],
      )).rows[0] || null;
      const handlingLatency = firstInbound ? Date.parse(now) - Date.parse(firstInbound.observed_at) : Number.NaN;
      const handlingLatencyMs = Number.isFinite(handlingLatency)
        && handlingLatency >= 0
        && handlingLatency <= 30 * 24 * 60 * 60 * 1_000
        ? handlingLatency
        : null;
      await tx.execute(
        `UPDATE cs_conversations SET status='HANDLED',unread_count=0,handled_at=?,version=version+1,updated_at=?
         WHERE id=?`,
        [now, now, conversationId],
      );
      await tx.execute(
        `INSERT INTO cs_send_actions (
           id,conversation_id,suggestion_id,message_id,action,actor_type,actor_id,outcome,detail_json,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [actionId, conversationId, null, null, "MARK_HANDLED", "USER", actorId, "SUCCEEDED",
          JSON.stringify({
            semantic: "EXPLICIT_MARK_HANDLED_NOT_CONFIRMED_RESOLUTION",
            handlingFromMessageId: handlingLatencyMs === null ? null : firstInbound?.id || null,
            handlingLatencyMs,
          }), now],
      );
      return { id: conversationId, status: "HANDLED", handledAt: now, duplicate: false };
    });
  }

  async statusSnapshot({ minimumConfidence = 0.72 } = {}) {
    const parsedThreshold = Number(minimumConfidence);
    const confidenceThreshold = Math.max(0, Math.min(1, Number.isFinite(parsedThreshold) ? parsedThreshold : 0.72));
    const [accounts, workers, leases, conversations, suggestions, commands, reviews, reviewReasons, reviewEdits, quality, observedSends, handledActions] = await Promise.all([
      this.provider.query("SELECT status,COUNT(*) AS total FROM cs_channel_accounts GROUP BY status"),
      this.provider.query("SELECT * FROM cs_worker_nodes ORDER BY id"),
      this.provider.query("SELECT * FROM cs_worker_account_leases ORDER BY account_id"),
      this.provider.query("SELECT status,COUNT(*) AS total FROM cs_conversations GROUP BY status"),
      this.provider.query("SELECT status,COUNT(*) AS total FROM cs_suggestions GROUP BY status"),
      this.provider.query("SELECT status,COUNT(*) AS total FROM cs_worker_commands GROUP BY status"),
      this.provider.query(
        `SELECT review.action status,COUNT(*) AS total
         FROM cs_suggestion_reviews review
         WHERE review.action IN ('ACCEPT','EDIT','REJECT')
           AND NOT EXISTS (
             SELECT 1 FROM cs_suggestion_reviews newer
             WHERE newer.suggestion_id=review.suggestion_id
               AND (newer.created_at>review.created_at OR (newer.created_at=review.created_at AND newer.id>review.id))
           )
         GROUP BY review.action`,
      ),
      this.provider.query(
        `SELECT reason_code status,COUNT(*) AS total
         FROM cs_suggestion_reviews
         WHERE reason_code IS NOT NULL
         GROUP BY reason_code`,
      ),
      this.provider.query(
        `SELECT AVG(edit_distance_ratio) AS average_edit_ratio,
           SUM(CASE WHEN edit_distance_ratio>=0.35 THEN 1 ELSE 0 END) AS major_edit_total
         FROM cs_suggestion_reviews
         WHERE action='EDIT' AND edit_distance_ratio IS NOT NULL`,
      ),
      this.provider.query(
        `SELECT COUNT(*) AS generated_total,AVG(confidence) AS average_confidence,
           SUM(CASE WHEN confidence IS NULL OR confidence<? THEN 1 ELSE 0 END) AS below_threshold_total,
           SUM(COALESCE(input_tokens,0)) AS input_tokens,
           SUM(COALESCE(output_tokens,0)) AS output_tokens,
           SUM(COALESCE(total_tokens,0)) AS total_tokens
         FROM cs_suggestions
         WHERE generation_finished_at IS NOT NULL AND draft_ciphertext IS NOT NULL`,
        [confidenceThreshold],
      ),
      this.provider.query(
        `SELECT outcome,detail_json FROM cs_send_actions
         WHERE action='SEND_OBSERVED' ORDER BY created_at DESC,id DESC LIMIT 5000`,
      ),
      this.provider.query(
        `SELECT detail_json FROM cs_send_actions
         WHERE action='MARK_HANDLED' AND outcome='SUCCEEDED'
         ORDER BY created_at DESC,id DESC LIMIT 5000`,
      ),
    ]);
    const counts = (rows) => Object.fromEntries(rows.map((row) => [row.status, Number(row.total || 0)]));
    const reviewCounts = counts(reviews.rows);
    const reviewedTotal = Object.values(reviewCounts).reduce((total, value) => total + value, 0);
    const reviewEditRow = reviewEdits.rows[0] || {};
    const qualityRow = quality.rows[0] || {};
    const sendRows = observedSends.rows || [];
    const responseLatencies = sendRows
      .map((row) => parseJson(row.detail_json, {}).responseLatencyMs)
      .filter((value) => value !== null && value !== undefined)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .sort((left, right) => left - right);
    const percentile = (fraction) => responseLatencies.length
      ? responseLatencies[Math.max(0, Math.ceil(responseLatencies.length * fraction) - 1)]
      : null;
    const matchedAiDraftSendTotal = sendRows.filter((row) => row.outcome === "MATCHED_AI_DRAFT").length;
    const handlingLatencies = (handledActions.rows || [])
      .map((row) => parseJson(row.detail_json, {}).handlingLatencyMs)
      .filter((value) => value !== null && value !== undefined)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .sort((left, right) => left - right);
    const handlingPercentile = (fraction) => handlingLatencies.length
      ? handlingLatencies[Math.max(0, Math.ceil(handlingLatencies.length * fraction) - 1)]
      : null;
    const conversationCounts = counts(conversations.rows);
    const explicitlyDecidedConversationTotal = Number(conversationCounts.OPEN || 0) + Number(conversationCounts.HANDLED || 0);
    return {
      accounts: counts(accounts.rows),
      workers: workers.rows.map(workerRow),
      accountLeases: leases.rows.map(leaseRow),
      conversations: conversationCounts,
      suggestions: counts(suggestions.rows),
      commands: counts(commands.rows),
      quality: {
        generatedTotal: Number(qualityRow.generated_total || 0),
        averageConfidence: qualityRow.average_confidence === null || qualityRow.average_confidence === undefined
          ? null
          : Number(qualityRow.average_confidence),
        belowThresholdTotal: Number(qualityRow.below_threshold_total || 0),
        minimumAutoFillConfidence: confidenceThreshold,
        reviewedTotal,
        reviews: reviewCounts,
        reviewReasons: counts(reviewReasons.rows),
        averageEditRatio: reviewEditRow.average_edit_ratio === null || reviewEditRow.average_edit_ratio === undefined
          ? null
          : Number(reviewEditRow.average_edit_ratio),
        majorEditTotal: Number(reviewEditRow.major_edit_total || 0),
        inputTokens: Number(qualityRow.input_tokens || 0),
        outputTokens: Number(qualityRow.output_tokens || 0),
        totalTokens: Number(qualityRow.total_tokens || 0),
        observedOutboundTotal: sendRows.length,
        matchedAiDraftSendTotal,
        exactAiDraftShare: sendRows.length ? matchedAiDraftSendTotal / sendRows.length : null,
        firstResponseSampleTotal: responseLatencies.length,
        firstResponseP50Ms: percentile(0.5),
        firstResponseP95Ms: percentile(0.95),
        explicitHandledTotal: Number(conversationCounts.HANDLED || 0),
        explicitHandledRate: explicitlyDecidedConversationTotal
          ? Number(conversationCounts.HANDLED || 0) / explicitlyDecidedConversationTotal
          : null,
        handlingSampleTotal: handlingLatencies.length,
        handlingP50Ms: handlingPercentile(0.5),
        handlingP95Ms: handlingPercentile(0.95),
      },
    };
  }

  async qualityBreakdown({ dimension = "intent", accountId = null, minimumConfidence = 0.72, limit = 20 } = {}) {
    const dimensionExpression = QUALITY_DIMENSION_EXPRESSIONS[dimension];
    if (!dimensionExpression) {
      throw repositoryError("CS_QUALITY_DIMENSION_INVALID", "Customer-service quality dimension is invalid", 400);
    }
    const parsedThreshold = Number(minimumConfidence);
    const confidenceThreshold = Math.max(0, Math.min(1, Number.isFinite(parsedThreshold) ? parsedThreshold : 0.72));
    const params = [confidenceThreshold];
    const where = ["suggestion.generation_finished_at IS NOT NULL", "suggestion.draft_ciphertext IS NOT NULL"];
    if (accountId) {
      where.push("conversation.account_id=?");
      params.push(accountId);
    }
    params.push(Math.max(1, Math.min(100, Number(limit) || 20)));
    const rows = (await this.provider.query(
      `SELECT COALESCE(${dimensionExpression},'UNKNOWN') AS dimension_value,
         COUNT(*) AS generated_total,AVG(suggestion.confidence) AS average_confidence,
         SUM(CASE WHEN suggestion.confidence IS NULL OR suggestion.confidence<? THEN 1 ELSE 0 END) AS below_threshold_total,
         SUM(CASE WHEN review.action='ACCEPT' THEN 1 ELSE 0 END) AS accepted_total,
         SUM(CASE WHEN review.action='EDIT' THEN 1 ELSE 0 END) AS edited_total,
         SUM(CASE WHEN review.action='REJECT' THEN 1 ELSE 0 END) AS rejected_total,
         AVG(review.edit_distance_ratio) AS average_edit_ratio,
         SUM(COALESCE(suggestion.total_tokens,0)) AS total_tokens
       FROM cs_suggestions suggestion
       JOIN cs_conversations conversation ON conversation.id=suggestion.conversation_id
       LEFT JOIN cs_suggestion_reviews review ON review.suggestion_id=suggestion.id
         AND NOT EXISTS (
           SELECT 1 FROM cs_suggestion_reviews newer
           WHERE newer.suggestion_id=review.suggestion_id
             AND (newer.created_at>review.created_at OR (newer.created_at=review.created_at AND newer.id>review.id))
         )
       WHERE ${where.join(" AND ")}
       GROUP BY COALESCE(${dimensionExpression},'UNKNOWN')
       ORDER BY generated_total DESC,dimension_value
       LIMIT ?`,
      params,
    )).rows;
    return rows.map((row) => ({
      dimension,
      value: row.dimension_value,
      generatedTotal: Number(row.generated_total || 0),
      averageConfidence: row.average_confidence === null || row.average_confidence === undefined
        ? null : Number(row.average_confidence),
      belowThresholdTotal: Number(row.below_threshold_total || 0),
      acceptedTotal: Number(row.accepted_total || 0),
      editedTotal: Number(row.edited_total || 0),
      rejectedTotal: Number(row.rejected_total || 0),
      averageEditRatio: row.average_edit_ratio === null || row.average_edit_ratio === undefined
        ? null : Number(row.average_edit_ratio),
      totalTokens: Number(row.total_tokens || 0),
    }));
  }

  async claimQueuedSuggestion({ now, createdBefore }) {
    return this.provider.transaction(async (tx) => {
      const candidates = (await tx.query(
        `SELECT suggestion.*,conversation.account_id,conversation.routing_ciphertext conversation_routing_ciphertext,
           conversation.customer_display_ciphertext,conversation.current_inbound_message_id,
           account.status account_status,account.settings_json account_settings_json,
           message.routing_ciphertext message_routing_ciphertext,
           (SELECT observation.worker_id FROM cs_message_observations observation
            WHERE observation.message_id=suggestion.trigger_message_id
            ORDER BY observation.observed_at DESC,observation.created_at DESC,observation.id DESC LIMIT 1) worker_id
         FROM cs_suggestions suggestion
         JOIN cs_conversations conversation ON conversation.id=suggestion.conversation_id
         JOIN cs_channel_accounts account ON account.id=conversation.account_id
         JOIN cs_messages message ON message.id=suggestion.trigger_message_id
         WHERE suggestion.status='QUEUED' AND suggestion.created_at<=?
           AND account.status='ACTIVE'
           AND conversation.current_inbound_message_id=suggestion.trigger_message_id
         ORDER BY CASE conversation.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
           suggestion.created_at,suggestion.id LIMIT 20`,
        [createdBefore],
      )).rows;
      for (const row of candidates) {
        const manual = parseJson(row.quality_flags_json, []).includes("MANUALLY_REQUEUED");
        const configuredMode = automationMode(parseJson(row.account_settings_json, {}));
        if (configuredMode === "OBSERVE_ONLY" && !manual) continue;
        const effectiveMode = configuredMode === "OBSERVE_ONLY" && manual ? "SUGGEST_ONLY" : configuredMode;
        const changed = await tx.execute(
          `UPDATE cs_suggestions SET status='GENERATING',generation_started_at=?,error_code=NULL,updated_at=?
           WHERE id=? AND status='QUEUED'`,
          [now, now, row.id],
        );
        if (!changed.rowCount) continue;
        return {
          ...suggestionRow({ ...row, status: "GENERATING", generation_started_at: now, updated_at: now }),
          accountId: row.account_id,
          automationMode: effectiveMode,
          workerId: row.worker_id || null,
          conversationRoutingCiphertext: row.conversation_routing_ciphertext,
          messageRoutingCiphertext: row.message_routing_ciphertext,
          customerDisplayCiphertext: row.customer_display_ciphertext,
          currentInboundMessageId: row.current_inbound_message_id,
        };
      }
      return null;
    });
  }

  async completeGeneratedSuggestion(input) {
    return this.provider.transaction(async (tx) => {
      const current = (await tx.query(
        `SELECT suggestion.status,suggestion.trigger_message_id,conversation.current_inbound_message_id,
           account.status account_status,account.settings_json account_settings_json
         FROM cs_suggestions suggestion
         JOIN cs_conversations conversation ON conversation.id=suggestion.conversation_id
         JOIN cs_channel_accounts account ON account.id=conversation.account_id
         WHERE suggestion.id=? LIMIT 1`,
        [input.id],
      )).rows[0];
      if (!current) return null;
      if (current.status !== "GENERATING") return { id: input.id, status: current.status, commandCreated: false };
      if (current.trigger_message_id !== current.current_inbound_message_id) {
        await tx.execute(
          `UPDATE cs_suggestions SET status='STALE',superseded_by_message_id=?,updated_at=? WHERE id=?`,
          [current.current_inbound_message_id, input.now, input.id],
        );
        return { id: input.id, status: "STALE", commandCreated: false };
      }
      await tx.execute(
        `UPDATE cs_suggestions SET status='READY',context_snapshot_id=?,draft_ciphertext=?,language_code=?,
           provider=?,model=?,prompt_version=?,confidence=?,input_tokens=?,output_tokens=?,total_tokens=?,
           intent_code=?,risk_level=?,country_code=?,
           commerce_shop_id=?,product_model_id=?,product_sku_id=?,category_id=?,category_name=?,
           quality_flags_json=?,error_code=NULL,generation_finished_at=?,updated_at=?
         WHERE id=? AND status='GENERATING'`,
        [input.contextSnapshotId, input.draftCiphertext, input.languageCode, input.provider,
          input.model, input.promptVersion, input.confidence, input.inputTokens ?? null,
          input.outputTokens ?? null, input.totalTokens ?? null, input.intentCode || null,
          input.riskLevel || null, input.countryCode || null, input.commerceShopId || null,
          input.productModelId || null, input.productSkuId || null, input.categoryId || null,
          input.categoryName || null, JSON.stringify(input.qualityFlags || []), input.now, input.now, input.id],
      );
      await tx.execute("DELETE FROM cs_suggestion_evidence WHERE suggestion_id=?", [input.id]);
      for (const evidence of input.evidence || []) {
        await tx.execute(
          `INSERT INTO cs_suggestion_evidence (
             id,suggestion_id,source_type,source_id,source_version,label,excerpt_ciphertext,rank_no,metadata_json,created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [evidence.id, input.id, evidence.sourceType, evidence.sourceId || null,
            evidence.sourceVersion || null, evidence.label, evidence.excerptCiphertext || null,
            evidence.rank, JSON.stringify(evidence.metadata || {}), input.now],
        );
      }
      let commandCreated = false;
      const accountAllowsAutomaticFill = current.account_status === "ACTIVE"
        && automationMode(parseJson(current.account_settings_json, {})) === "DRAFT_FILL";
      if (input.command && (!input.command.requiresAccountDraftFill || accountAllowsAutomaticFill)) {
        const inserted = await tx.execute(
          `INSERT INTO cs_worker_commands (
             id,idempotency_key,worker_id,account_id,conversation_id,trigger_message_id,suggestion_id,
             command_type,status,payload_ciphertext,available_at,leased_until,attempt_count,result_code,
             result_json,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(idempotency_key) DO NOTHING`,
          [input.command.id, input.command.idempotencyKey, input.command.workerId, input.command.accountId,
            input.command.conversationId, input.command.triggerMessageId, input.id, "FILL_DRAFT", "PENDING",
            input.command.payloadCiphertext, input.now, null, 0, null, "{}", input.now, input.now],
        );
        commandCreated = Boolean(inserted.rowCount);
      }
      return { id: input.id, status: "READY", commandCreated };
    });
  }

  async failGeneratingSuggestion({ id, errorCode, qualityFlags = [], now }) {
    const changed = await this.provider.execute(
      `UPDATE cs_suggestions SET status='FAILED',error_code=?,quality_flags_json=?,
         generation_finished_at=?,updated_at=? WHERE id=? AND status='GENERATING'`,
      [errorCode, JSON.stringify(qualityFlags), now, now, id],
    );
    return Boolean(changed.rowCount);
  }

  async getSuggestionForReview(id) {
    const row = (await this.provider.query(
      `SELECT suggestion.*,conversation.account_id,
         conversation.routing_ciphertext conversation_routing_ciphertext,
         conversation.current_inbound_message_id,
         account.status account_status,account.settings_json account_settings_json,
         message.routing_ciphertext message_routing_ciphertext,
         snapshot.context_digest,snapshot.context_ciphertext,
         (SELECT observation.worker_id FROM cs_message_observations observation
          WHERE observation.message_id=suggestion.trigger_message_id
          ORDER BY observation.observed_at DESC,observation.created_at DESC,observation.id DESC LIMIT 1) worker_id
       FROM cs_suggestions suggestion
       JOIN cs_conversations conversation ON conversation.id=suggestion.conversation_id
       JOIN cs_channel_accounts account ON account.id=conversation.account_id
       JOIN cs_messages message ON message.id=suggestion.trigger_message_id
       LEFT JOIN cs_context_snapshots snapshot ON snapshot.id=suggestion.context_snapshot_id
       WHERE suggestion.id=? LIMIT 1`,
      [id],
    )).rows[0];
    if (!row) return null;
    return {
      ...suggestionRow(row),
      accountId: row.account_id,
      accountStatus: row.account_status,
      automationMode: automationMode(parseJson(row.account_settings_json, {})),
      workerId: row.worker_id || null,
      conversationRoutingCiphertext: row.conversation_routing_ciphertext,
      messageRoutingCiphertext: row.message_routing_ciphertext,
      currentInboundMessageId: row.current_inbound_message_id,
      contextDigest: row.context_digest || null,
      contextCiphertext: row.context_ciphertext || null,
    };
  }

  async reviewSuggestion(input) {
    return this.provider.transaction(async (tx) => {
      const current = (await tx.query(
        `SELECT suggestion.status,suggestion.trigger_message_id,conversation.current_inbound_message_id,
           conversation.account_id
         FROM cs_suggestions suggestion
         JOIN cs_conversations conversation ON conversation.id=suggestion.conversation_id
         WHERE suggestion.id=? LIMIT 1`,
        [input.suggestionId],
      )).rows[0];
      if (!current) return null;
      if (!new Set(["READY", "ACCEPTED", "EDITED"]).has(current.status)) {
        throw repositoryError("CS_SUGGESTION_NOT_REVIEWABLE", "Suggestion is not ready for review");
      }
      if (current.trigger_message_id !== current.current_inbound_message_id) {
        throw repositoryError("CS_SUGGESTION_STALE", "A newer inbound message has replaced this suggestion");
      }
      if (input.command) {
        if (input.draftFillEnabled !== true) {
          throw repositoryError("CS_DRAFT_FILL_DISABLED", "Draft fill is disabled by the system rollout gate");
        }
        await tx.execute("UPDATE cs_channel_accounts SET updated_at=updated_at WHERE id=?", [current.account_id]);
        const account = (await tx.query(
          "SELECT status,settings_json FROM cs_channel_accounts WHERE id=? LIMIT 1",
          [current.account_id],
        )).rows[0];
        if (!account || account.status !== "ACTIVE") {
          throw repositoryError("CS_ACCOUNT_ACTIVE_REQUIRED", "The LiaoLiao account must be active before a draft can be filled");
        }
        if (automationMode(parseJson(account.settings_json, {})) !== "DRAFT_FILL") {
          throw repositoryError("CS_ACCOUNT_DRAFT_FILL_DISABLED", "The LiaoLiao account is not enabled for Draft Fill");
        }
        if (input.command.accountId !== current.account_id) {
          throw repositoryError("CS_COMMAND_ACCOUNT_MISMATCH", "Draft-fill command account does not match the suggestion account");
        }
      }
      await tx.execute(
        `UPDATE cs_worker_commands SET status='CANCELED',result_code='HUMAN_REVIEW_REPLACED_DRAFT',
           leased_until=NULL,updated_at=?
         WHERE suggestion_id=? AND command_type='FILL_DRAFT' AND status IN ('PENDING','LEASED')`,
        [input.now, input.suggestionId],
      );
      await tx.execute(
        `INSERT INTO cs_suggestion_reviews (
           id,suggestion_id,reviewer_id,action,final_text_ciphertext,reason_code,comment_ciphertext,
           edit_distance_ratio,edit_metric_version,edit_metric_approximate,original_length,final_length,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [input.reviewId, input.suggestionId, input.reviewerId, input.action,
          input.finalTextCiphertext || null, input.reasonCode || null, input.commentCiphertext || null,
          input.editMetric?.ratio ?? null, input.editMetric?.metricVersion || null,
          input.editMetric?.approximate ? 1 : 0, input.editMetric?.originalLength ?? null,
          input.editMetric?.finalLength ?? null, input.now],
      );
      await tx.execute(
        `UPDATE cs_suggestions SET status=?,draft_ciphertext=COALESCE(?,draft_ciphertext),
           quality_flags_json=?,updated_at=? WHERE id=?`,
        [input.status, input.finalTextCiphertext || null,
          JSON.stringify(input.qualityFlags || []), input.now, input.suggestionId],
      );
      let commandCreated = false;
      if (input.command) {
        const inserted = await tx.execute(
          `INSERT INTO cs_worker_commands (
             id,idempotency_key,worker_id,account_id,conversation_id,trigger_message_id,suggestion_id,
             command_type,status,payload_ciphertext,available_at,leased_until,attempt_count,result_code,
             result_json,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(idempotency_key) DO NOTHING`,
          [input.command.id, input.command.idempotencyKey, input.command.workerId, input.command.accountId,
            input.command.conversationId, input.command.triggerMessageId, input.suggestionId,
            "FILL_DRAFT", "PENDING", input.command.payloadCiphertext, input.now, null, 0, null, "{}",
            input.now, input.now],
        );
        commandCreated = Boolean(inserted.rowCount);
      }
      return {
        id: input.suggestionId,
        status: input.status,
        reviewId: input.reviewId,
        commandCreated,
      };
    });
  }

  async pullCommands({ workerId, accountId, draftFillEnabled = false, now, leasedUntil, limit }) {
    return this.provider.transaction(async (tx) => {
      await tx.execute("UPDATE cs_channel_accounts SET updated_at=updated_at WHERE id=?", [accountId]);
      const account = (await tx.query(
        "SELECT status,settings_json FROM cs_channel_accounts WHERE id=? LIMIT 1",
        [accountId],
      )).rows[0];
      await tx.execute(
        `UPDATE cs_worker_commands SET
           status=CASE WHEN attempt_count>=3 THEN 'EXPIRED' ELSE 'PENDING' END,
           result_code=CASE WHEN attempt_count>=3 THEN 'LEASE_RETRY_EXHAUSTED' ELSE 'LEASE_EXPIRED_RETRY' END,
           leased_until=NULL,updated_at=?
         WHERE worker_id=? AND account_id=? AND status='LEASED' AND leased_until<?`,
        [now, workerId, accountId, now],
      );
      const configuredMode = automationMode(parseJson(account?.settings_json, {}));
      const cancellationReason = draftFillEnabled !== true
        ? "DRAFT_FILL_DISABLED"
        : account?.status !== "ACTIVE"
          ? "ACCOUNT_NOT_ACTIVE"
          : configuredMode !== "DRAFT_FILL"
            ? "ACCOUNT_DRAFT_FILL_DISABLED"
            : null;
      if (cancellationReason) {
        await tx.execute(
          `UPDATE cs_worker_commands SET status='CANCELED',result_code=?,result_json=?,
             leased_until=NULL,updated_at=?
           WHERE worker_id=? AND account_id=? AND command_type='FILL_DRAFT'
             AND status IN ('PENDING','LEASED')`,
          [cancellationReason, JSON.stringify({
            cancellationSource: "COMMAND_PULL_AUTHORIZATION_RECHECK",
            reasonCode: cancellationReason,
            accountStatus: account?.status || "MISSING",
            automationMode: configuredMode,
            draftFillEnabled: draftFillEnabled === true,
            automaticSend: false,
          }), now, workerId, accountId],
        );
      }
      const candidates = (await tx.query(
        `SELECT * FROM cs_worker_commands
         WHERE worker_id=? AND account_id=? AND status='PENDING' AND available_at<=?
         ORDER BY available_at,id LIMIT ?`,
        [workerId, accountId, now, limit],
      )).rows;
      const leased = [];
      for (const command of candidates) {
        const result = await tx.execute(
          `UPDATE cs_worker_commands SET status='LEASED',leased_until=?,attempt_count=attempt_count+1,updated_at=?
           WHERE id=? AND status='PENDING'`,
          [leasedUntil, now, command.id],
        );
        if (result.rowCount) leased.push({
          ...command,
          status: "LEASED",
          leased_until: leasedUntil,
          attempt_count: Number(command.attempt_count || 0) + 1,
        });
      }
      return leased.map((row) => ({
        id: row.id,
        idempotencyKey: row.idempotency_key,
        accountId: row.account_id,
        conversationId: row.conversation_id || null,
        triggerMessageId: row.trigger_message_id || null,
        suggestionId: row.suggestion_id || null,
        commandType: row.command_type,
        payloadCiphertext: row.payload_ciphertext,
        leasedUntil: row.leased_until,
        attemptCount: Number(row.attempt_count || 0),
      }));
    });
  }

  async completeCommand({ workerId, accountId, commandId, status, resultCode, result, now }) {
    return this.provider.transaction(async (tx) => {
      const command = (await tx.query(
        `SELECT suggestion_id,command_type,conversation_id,trigger_message_id
         FROM cs_worker_commands WHERE id=? AND worker_id=? AND account_id=? AND status='LEASED' LIMIT 1`,
        [commandId, workerId, accountId],
      )).rows[0];
      if (!command) return null;
      const changed = await tx.execute(
        `UPDATE cs_worker_commands SET status=?,result_code=?,result_json=?,leased_until=NULL,updated_at=?
         WHERE id=? AND worker_id=? AND account_id=? AND status='LEASED'`,
        [status, resultCode, JSON.stringify(result || {}), now, commandId, workerId, accountId],
      );
      if (!changed.rowCount) return null;
      if (status === "SUCCEEDED" && command.command_type === "FILL_DRAFT" && command.suggestion_id) {
        await tx.execute(
          `UPDATE cs_suggestions SET status='FILLED',updated_at=?
           WHERE id=? AND status IN ('READY','ACCEPTED','EDITED')`,
          [now, command.suggestion_id],
        );
        await tx.execute(
          `INSERT INTO cs_send_actions (
             id,conversation_id,suggestion_id,message_id,action,actor_type,actor_id,outcome,detail_json,created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
          [`${commandId}:draft-filled`, command.conversation_id, command.suggestion_id,
            command.trigger_message_id || null, "DRAFT_FILLED", "WORKER", workerId, "SUCCEEDED",
            JSON.stringify({
              editorMatched: Boolean(result?.editorMatched),
              conversationMatched: Boolean(result?.conversationMatched),
              draftContentDigest: result?.draftContentDigest || null,
              automaticSend: false,
            }), now],
        );
      }
      return { id: commandId, status, resultCode, suggestionId: command.suggestion_id || null };
    });
  }
}
