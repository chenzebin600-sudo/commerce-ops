const TARGET_MODES = new Set(["OBSERVE_ONLY", "SUGGEST_ONLY", "DRAFT_FILL"]);

function targetMode(value) {
  const aliases = {
    OBSERVE: "OBSERVE_ONLY",
    SUGGEST: "SUGGEST_ONLY",
    DRAFT: "DRAFT_FILL",
  };
  const normalized = String(value || "OBSERVE_ONLY").trim().toUpperCase();
  const mode = aliases[normalized] || normalized;
  if (!TARGET_MODES.has(mode)) throw new TypeError("Target mode must be observe, suggest or draft");
  return mode;
}

function issue(code, message) {
  return { code, message };
}

function modeOf(account) {
  return String(account?.rollout?.currentMode || account?.settings?.automationMode || "OBSERVE_ONLY").toUpperCase();
}

export function evaluateCustomerServiceDeploymentReadiness({
  status,
  accounts = [],
  target = "OBSERVE_ONLY",
  accountId = null,
} = {}) {
  const mode = targetMode(target);
  const blockers = [];
  const warnings = [];
  const automation = status?.replyAutomation || {};
  const knowledge = status?.dependencies?.productKnowledge || {};
  const account = accountId ? accounts.find((item) => item.id === accountId) || null : null;

  if (status?.ready !== true || status?.phase !== "CONTROL_PLANE_READY") {
    blockers.push(issue("CS_SCHEMA_NOT_READY", "客服控制面迁移尚未就绪"));
  }
  if (status?.identityProtectionConfigured !== true) {
    blockers.push(issue("CS_IDENTITY_PROTECTION_REQUIRED", "客服身份摘要与加密配置尚未就绪"));
  }
  if (status?.humanConfirmationRequired !== true || status?.automaticSendEnabled !== false) {
    blockers.push(issue("CS_NO_SEND_CONTRACT_VIOLATION", "系统必须保持人工确认且禁止自动发送"));
  }

  if (mode === "OBSERVE_ONLY") {
    if (automation.enabled === true) blockers.push(issue("CS_AI_MUST_BE_DISABLED_FOR_OBSERVE", "仅观察验收时必须关闭全局 AI"));
    if (automation.draftFillEnabled === true) blockers.push(issue("CS_DRAFT_FILL_MUST_BE_DISABLED_FOR_OBSERVE", "仅观察验收时必须关闭全局输入框回填"));
  } else {
    if (automation.configured !== true) blockers.push(issue("CS_REPLY_AGENT_NOT_CONFIGURED", "回复模型尚未配置"));
    if (automation.enabled !== true) blockers.push(issue("CS_AI_ROLLOUT_DISABLED", "全局 AI 建议开关尚未开启"));
    if (knowledge.ready !== true) blockers.push(issue("CS_PRODUCT_KNOWLEDGE_NOT_READY", "共享产品知识库迁移尚未就绪"));
    if (Number(knowledge.publishedSupportReleaseTotal || 0) < 1) {
      blockers.push(issue("CS_SUPPORT_KNOWLEDGE_RELEASE_REQUIRED", "至少需要一个已审核发布的 SUPPORT 知识版本"));
    }
    if (mode === "SUGGEST_ONLY" && automation.draftFillEnabled === true) {
      blockers.push(issue("CS_DRAFT_FILL_MUST_BE_DISABLED_FOR_SUGGEST", "建议阶段必须保持全局输入框回填关闭"));
    }
    if (mode === "DRAFT_FILL" && automation.draftFillEnabled !== true) {
      blockers.push(issue("CS_DRAFT_FILL_DISABLED", "输入框回填开关尚未开启"));
    }
  }

  if (accountId && !account) {
    blockers.push(issue("CS_ACCOUNT_NOT_FOUND", "指定的乐聊账号不存在"));
  } else if (!accountId) {
    warnings.push(issue("CS_ACCOUNT_NOT_SELECTED", "未指定账号，本次只检查系统级条件"));
  } else if (account) {
    const currentMode = modeOf(account);
    if (mode === "OBSERVE_ONLY" && currentMode !== "OBSERVE_ONLY") {
      blockers.push(issue("CS_ACCOUNT_NOT_OBSERVE_ONLY", "指定账号当前不是仅观察模式"));
    }
    if (mode === "SUGGEST_ONLY") {
      const alreadyReady = currentMode === "SUGGEST_ONLY";
      const canAdvance = currentMode === "OBSERVE_ONLY"
        && account.rollout?.nextMode === "SUGGEST_ONLY"
        && account.rollout?.canAdvance === true;
      if (!alreadyReady && !canAdvance) {
        blockers.push(issue("CS_ACCOUNT_NOT_READY_FOR_SUGGEST", "指定账号尚未满足生成建议阶段的全部条件"));
      }
    }
    if (mode === "DRAFT_FILL") {
      const alreadyReady = currentMode === "DRAFT_FILL";
      const canAdvance = currentMode === "SUGGEST_ONLY"
        && account.rollout?.nextMode === "DRAFT_FILL"
        && account.rollout?.canAdvance === true;
      if (!alreadyReady && !canAdvance) {
        blockers.push(issue("CS_ACCOUNT_NOT_READY_FOR_DRAFT_FILL", "指定账号尚未满足输入框回填阶段的全部条件"));
      }
    }
    for (const code of account.rollout?.blockers || []) {
      if (!blockers.some((item) => item.code === code)) blockers.push(issue(code, "账号放行条件尚未满足"));
    }
  }

  return {
    contractVersion: "CS_DEPLOYMENT_READINESS_V1",
    targetMode: mode,
    accountId: accountId || null,
    accountMode: account ? modeOf(account) : null,
    ready: blockers.length === 0,
    blockers,
    warnings,
    checked: {
      customerServiceReady: status?.ready === true,
      identityProtectionConfigured: status?.identityProtectionConfigured === true,
      automaticSendEnabled: status?.automaticSendEnabled === true,
      replyAgentConfigured: automation.configured === true,
      aiEnabled: automation.enabled === true,
      draftFillEnabled: automation.draftFillEnabled === true,
      productKnowledgeReady: knowledge.ready === true,
      publishedSupportReleaseTotal: Number(knowledge.publishedSupportReleaseTotal || 0),
    },
  };
}

export function normalizeCustomerServiceDeploymentTarget(value) {
  return targetMode(value);
}
