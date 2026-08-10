<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { BookOpenCheck, RefreshCw, Rocket, ShieldCheck, TriangleAlert } from "@lucide/vue";
import {
  createKnowledgeRelease,
  loadKnowledgeCandidates,
  loadKnowledgeReleases,
  loadKnowledgeStatus,
  publishKnowledgeRelease,
  reviewKnowledgeCandidate,
  type ProductKnowledgeCandidate,
  type ProductKnowledgeRelease,
  type ProductKnowledgeStatus,
} from "@/services/product-knowledge";

const REVIEWER_STORAGE_KEY = "commerce-ops-product-knowledge-reviewer";
const PUBLISHER_STORAGE_KEY = "commerce-ops-product-knowledge-publisher";

const loading = ref(false);
const status = ref<ProductKnowledgeStatus | null>(null);
const candidates = ref<ProductKnowledgeCandidate[]>([]);
const releases = ref<ProductKnowledgeRelease[]>([]);
const selected = ref<ProductKnowledgeCandidate[]>([]);
const reviewerId = ref(localStorage.getItem(REVIEWER_STORAGE_KEY) || "");
const publisherId = ref(localStorage.getItem(PUBLISHER_STORAGE_KEY) || "");
const filters = reactive({ status: "REVIEW_REQUIRED", targetDomain: "", riskLevel: "" });

const reviewDialogOpen = ref(false);
const reviewTarget = ref<ProductKnowledgeCandidate | null>(null);
const reviewForm = reactive({
  action: "APPROVE",
  scopeType: "COMMON",
  countries: "",
  visibility: "CUSTOMER_VISIBLE",
  consumerScopes: ["CUSTOMER_SERVICE"],
  reviewerRoles: [] as string[],
  acknowledgeRisk: false,
  reasonCode: "",
  comment: "",
  categoryName: "",
});

const releaseDialogOpen = ref(false);
const releaseForm = reactive({
  releaseKey: "customer-service-knowledge",
  consumerScope: "CUSTOMER_SERVICE",
  notes: "",
});

const candidateTotal = computed(() => status.value?.candidates.reduce((sum, item) => sum + item.total, 0) || 0);
const reviewTotal = computed(() => status.value?.candidates
  .filter((item) => item.status === "REVIEW_REQUIRED").reduce((sum, item) => sum + item.total, 0) || 0);
const blockedTotal = computed(() => status.value?.candidates
  .filter((item) => ["MAPPING_REQUIRED", "SOURCE_READ_REQUIRED", "CONFLICT"].includes(item.status))
  .reduce((sum, item) => sum + item.total, 0) || 0);
const publishedTotal = computed(() => status.value?.releases
  .filter((item) => item.status === "PUBLISHED").reduce((sum, item) => sum + item.total, 0) || 0);
const approvedSelected = computed(() => selected.value.filter((item) => item.status === "APPROVED"));

const targetOptions = [
  ["PRODUCT_KNOWLEDGE", "产品知识 / 配件"],
  ["CUSTOMER_SERVICE_POLICY", "客服政策"],
  ["CUSTOMER_SERVICE_PLAYBOOK", "客服话术"],
  ["PRODUCT_CORE", "产品主数据交接"],
  ["PRODUCT_MEDIA", "产品媒体交接"],
  ["GOVERNANCE", "冲突与治理"],
];

function statusType(value: string) {
  if (value === "APPROVED" || value === "PUBLISHED") return "success";
  if (value === "REJECTED" || value === "RETIRED") return "info";
  if (["MAPPING_REQUIRED", "SOURCE_READ_REQUIRED", "CONFLICT"].includes(value)) return "danger";
  return "warning";
}

function statusLabel(value: string) {
  return ({
    REVIEW_REQUIRED: "待审核",
    MAPPING_REQUIRED: "待映射",
    SOURCE_READ_REQUIRED: "待补正文",
    CONFLICT: "冲突待裁决",
    APPROVED: "已审核",
    REJECTED: "已拒绝",
    DRAFT: "草稿",
    PUBLISHED: "已发布",
    RETIRED: "已退役",
  } as Record<string, string>)[value] || value;
}

function contentText(candidate: ProductKnowledgeCandidate) {
  const content = candidate.content;
  const parts = [
    content.text,
    content.question,
    content.reply_template,
    content.issue,
    content.condition,
    content.resolution,
    content.accessory_sku,
    content.accessory_name,
  ].filter((value) => typeof value === "string" && value.trim());
  return parts.join(" · ") || JSON.stringify(content);
}

function sourceText(candidate: ProductKnowledgeCandidate) {
  return [candidate.sourceSheet, candidate.sourceLocation].filter(Boolean).join(" · ") || candidate.sourceId || "—";
}

async function refresh() {
  loading.value = true;
  try {
    const [nextStatus, nextCandidates, nextReleases] = await Promise.all([
      loadKnowledgeStatus(),
      loadKnowledgeCandidates(filters),
      loadKnowledgeReleases({ consumerScope: "CUSTOMER_SERVICE" }),
    ]);
    status.value = nextStatus;
    candidates.value = nextCandidates;
    releases.value = nextReleases;
    selected.value = [];
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "产品知识读取失败");
  } finally {
    loading.value = false;
  }
}

function openReview(candidate: ProductKnowledgeCandidate) {
  reviewTarget.value = candidate;
  reviewForm.action = "APPROVE";
  reviewForm.scopeType = candidate.scopeType === "COUNTRY_OVERRIDE" ? "COUNTRY_OVERRIDE" : "COMMON";
  reviewForm.countries = candidate.countries.join(",");
  reviewForm.visibility = String(candidate.scope.visibility || "CUSTOMER_VISIBLE");
  reviewForm.consumerScopes = candidate.assetType.startsWith("SUPPORT_")
    ? ["CUSTOMER_SERVICE"]
    : (candidate.consumerScopes.length ? [...candidate.consumerScopes] : ["CUSTOMER_SERVICE"]);
  reviewForm.reviewerRoles = [];
  reviewForm.acknowledgeRisk = false;
  reviewForm.reasonCode = "";
  reviewForm.comment = "";
  reviewForm.categoryName = candidate.canonicalCategoryName || "";
  reviewDialogOpen.value = true;
}

async function submitReview() {
  const candidate = reviewTarget.value;
  if (!candidate) return;
  if (!reviewerId.value.trim()) return ElMessage.warning("请填写允许名单中的审核人 ID");
  localStorage.setItem(REVIEWER_STORAGE_KEY, reviewerId.value.trim());
  try {
    await reviewKnowledgeCandidate(candidate.id, {
      action: reviewForm.action,
      expectedContentDigest: candidate.contentDigest,
      reviewerRoles: reviewForm.reviewerRoles,
      acknowledgeRisk: reviewForm.acknowledgeRisk,
      reasonCode: reviewForm.reasonCode || undefined,
      comment: reviewForm.comment || undefined,
      scope: reviewForm.action === "APPROVE" ? {
        scopeType: reviewForm.scopeType,
        countries: reviewForm.countries.split(/[,，\s]+/).map((value) => value.trim().toUpperCase()).filter(Boolean),
        languageCode: candidate.languageCode || "zh-CN",
        consumerScopes: reviewForm.consumerScopes,
        visibility: reviewForm.visibility,
        categoryName: reviewForm.categoryName || undefined,
      } : undefined,
    }, reviewerId.value.trim());
    reviewDialogOpen.value = false;
    ElMessage.success("审核决定已记录；尚未进入正式 Release");
    await refresh();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "审核失败");
  }
}

function openRelease() {
  if (!approvedSelected.value.length) return ElMessage.warning("请先勾选已审核候选");
  releaseDialogOpen.value = true;
}

async function submitRelease() {
  if (!reviewerId.value.trim()) return ElMessage.warning("请填写 Release 创建人 ID");
  localStorage.setItem(REVIEWER_STORAGE_KEY, reviewerId.value.trim());
  try {
    const result = await createKnowledgeRelease({
      releaseKey: releaseForm.releaseKey,
      consumerScope: releaseForm.consumerScope,
      candidateIds: approvedSelected.value.map((item) => item.id),
      notes: releaseForm.notes || undefined,
    }, reviewerId.value.trim());
    releaseDialogOpen.value = false;
    ElMessage.success(result.duplicate ? "相同内容的草稿已存在" : "Release 草稿已创建，等待另一位发布人确认");
    await refresh();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "Release 创建失败");
  }
}

async function publishRelease(release: ProductKnowledgeRelease) {
  if (!publisherId.value.trim()) return ElMessage.warning("请填写允许名单中的发布人 ID");
  localStorage.setItem(PUBLISHER_STORAGE_KEY, publisherId.value.trim());
  try {
    await ElMessageBox.confirm(
      `确认发布 ${release.key} v${release.version}？发布后客服 AI 才能读取其中的已审核内容。`,
      "人工发布确认",
      { confirmButtonText: "确认发布", cancelButtonText: "取消", type: "warning" },
    );
    await publishKnowledgeRelease(release.id, {
      expectedContentDigest: release.contentDigest,
      acknowledgeHumanReview: true,
    }, publisherId.value.trim());
    ElMessage.success("知识 Release 已发布");
    await refresh();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : "发布失败");
  }
}

onMounted(refresh);
</script>

<template>
  <main class="knowledge-page" v-loading="loading">
    <header class="page-heading">
      <div>
        <span class="eyebrow">PRODUCT DOMAIN · SHARED KNOWLEDGE</span>
        <h1>产品知识库</h1>
        <p>产品事实、配件、客服政策与话术分域审核；只有已发布 Release 才能供客服或未来上架模块使用。</p>
      </div>
      <el-button :icon="RefreshCw" @click="refresh">刷新</el-button>
    </header>

    <el-alert
      v-if="!status?.ready"
      title="知识库迁移尚未应用"
      description="当前页面保持只读，离线候选不会进入 AI。请先完成测试库迁移演练。"
      type="warning"
      :closable="false"
      show-icon
    />
    <el-alert
      v-else-if="!status.governance.enabled"
      title="审核与发布写入默认关闭"
      description="配置治理开关及审核人/发布人允许名单后才可写入；候选状态不会自动转为批准。"
      type="info"
      :closable="false"
      show-icon
    />

    <section class="metric-grid" aria-label="知识治理概览">
      <article><BookOpenCheck :size="20" /><span>候选总量</span><strong>{{ candidateTotal.toLocaleString() }}</strong></article>
      <article><ShieldCheck :size="20" /><span>待人工审核</span><strong>{{ reviewTotal.toLocaleString() }}</strong></article>
      <article class="danger"><TriangleAlert :size="20" /><span>映射/正文/冲突阻断</span><strong>{{ blockedTotal.toLocaleString() }}</strong></article>
      <article class="success"><Rocket :size="20" /><span>已发布 Release</span><strong>{{ publishedTotal.toLocaleString() }}</strong></article>
    </section>

    <section class="governance-card">
      <div class="section-heading">
        <div><h2>候选审核台</h2><p>逐条核对 Product Core 映射、国家范围、客户可见性、风险与来源证据。</p></div>
        <div class="actor-fields">
          <el-input v-model="reviewerId" placeholder="审核人 ID" aria-label="审核人 ID" />
          <el-button type="primary" plain :disabled="!approvedSelected.length || !status?.governance.enabled" @click="openRelease">
            用已选 {{ approvedSelected.length }} 条建 Release
          </el-button>
        </div>
      </div>
      <div class="filters">
        <el-select v-model="filters.status" clearable placeholder="审核状态" @change="refresh">
          <el-option v-for="value in ['REVIEW_REQUIRED','MAPPING_REQUIRED','SOURCE_READ_REQUIRED','CONFLICT','APPROVED','REJECTED']" :key="value" :label="statusLabel(value)" :value="value" />
        </el-select>
        <el-select v-model="filters.targetDomain" clearable placeholder="目标域" @change="refresh">
          <el-option v-for="option in targetOptions" :key="option[0]" :label="option[1]" :value="option[0]" />
        </el-select>
        <el-select v-model="filters.riskLevel" clearable placeholder="风险" @change="refresh">
          <el-option label="普通" value="NORMAL" /><el-option label="敏感" value="SENSITIVE" /><el-option label="高风险" value="HIGH" />
        </el-select>
      </div>
      <el-table :data="candidates" row-key="id" @selection-change="selected = $event" empty-text="当前筛选无候选">
        <el-table-column type="selection" width="44" :selectable="(row: ProductKnowledgeCandidate) => row.status === 'APPROVED'" />
        <el-table-column label="候选" min-width="185">
          <template #default="{ row }"><strong>{{ row.assetType }}</strong><small>{{ row.assetId }}</small></template>
        </el-table-column>
        <el-table-column label="产品/类目" min-width="170">
          <template #default="{ row }"><span>{{ row.sourceSku || '类目级' }}</span><small>{{ row.canonicalCategoryName || '未映射' }} · {{ row.mappingStatus || '—' }}</small></template>
        </el-table-column>
        <el-table-column label="国家/作用域" width="145">
          <template #default="{ row }"><span>{{ row.countries.join(', ') || 'COMMON' }}</span><small>{{ row.scopeType }}</small></template>
        </el-table-column>
        <el-table-column label="内容摘要" min-width="320" show-overflow-tooltip><template #default="{ row }">{{ contentText(row) }}</template></el-table-column>
        <el-table-column label="来源证据" min-width="180" show-overflow-tooltip><template #default="{ row }">{{ sourceText(row) }}</template></el-table-column>
        <el-table-column label="风险" width="94"><template #default="{ row }"><el-tag :type="row.riskLevel === 'NORMAL' ? 'success' : 'danger'" effect="plain">{{ row.riskLevel }}</el-tag></template></el-table-column>
        <el-table-column label="状态" width="118"><template #default="{ row }"><el-tag :type="statusType(row.status)" effect="plain">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="104" fixed="right">
          <template #default="{ row }"><el-button link type="primary" :disabled="!status?.governance.enabled || row.status === 'APPROVED' || row.status === 'REJECTED'" @click="openReview(row)">审核</el-button></template>
        </el-table-column>
      </el-table>
    </section>

    <section class="governance-card">
      <div class="section-heading">
        <div><h2>Release 发布记录</h2><p>创建与发布必须由不同人员完成；旧发布版会在新版本发布时退役。</p></div>
        <el-input v-model="publisherId" class="publisher-input" placeholder="发布人 ID" aria-label="发布人 ID" />
      </div>
      <el-table :data="releases" row-key="id" empty-text="尚无 Release">
        <el-table-column label="Release" min-width="200"><template #default="{ row }"><strong>{{ row.key }} v{{ row.version }}</strong><small>{{ row.contentDigest.slice(0, 16) }}…</small></template></el-table-column>
        <el-table-column prop="consumerScope" label="消费者视图" width="160" />
        <el-table-column label="内容" min-width="220"><template #default="{ row }">Claim {{ row.counts.claims }} · 配件 {{ row.counts.accessories }} · 政策 {{ row.counts.policies }} · 话术 {{ row.counts.playbooks }}</template></el-table-column>
        <el-table-column label="创建/发布" min-width="190"><template #default="{ row }"><span>{{ row.createdBy }}</span><small>{{ row.publishedBy || '等待另一位发布人' }}</small></template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="statusType(row.status)" effect="plain">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="108" fixed="right"><template #default="{ row }"><el-button v-if="row.status === 'DRAFT'" link type="primary" :disabled="!status?.governance.enabled" @click="publishRelease(row)">人工发布</el-button><span v-else>—</span></template></el-table-column>
      </el-table>
    </section>

    <el-dialog v-model="reviewDialogOpen" title="审核知识候选" width="min(720px, 94vw)">
      <div v-if="reviewTarget" class="review-evidence">
        <strong>{{ reviewTarget.assetType }}</strong><p>{{ contentText(reviewTarget) }}</p><small>{{ sourceText(reviewTarget) }} · 摘要 {{ reviewTarget.contentDigest.slice(0, 20) }}…</small>
      </div>
      <el-form label-position="top">
        <el-form-item label="审核决定"><el-radio-group v-model="reviewForm.action"><el-radio-button value="APPROVE">批准</el-radio-button><el-radio-button value="REJECT">拒绝</el-radio-button><el-radio-button value="RETURN_FOR_MAPPING">退回映射</el-radio-button><el-radio-button value="RETURN_FOR_SOURCE">补来源正文</el-radio-button><el-radio-button value="RETURN_FOR_CONFLICT">冲突裁决</el-radio-button></el-radio-group></el-form-item>
        <template v-if="reviewForm.action === 'APPROVE'">
          <div class="form-grid">
            <el-form-item label="作用域"><el-select v-model="reviewForm.scopeType"><el-option label="多国通用 COMMON" value="COMMON" /><el-option label="国家差异 COUNTRY_OVERRIDE" value="COUNTRY_OVERRIDE" /></el-select></el-form-item>
            <el-form-item label="国家代码（差异项必填）"><el-input v-model="reviewForm.countries" placeholder="TH, MY" :disabled="reviewForm.scopeType === 'COMMON'" /></el-form-item>
            <el-form-item label="客户可见性"><el-select v-model="reviewForm.visibility"><el-option label="可直接引用" value="CUSTOMER_VISIBLE" /><el-option label="需政策校验" value="CUSTOMER_VISIBLE_AFTER_POLICY_VALIDATION" /><el-option label="仅内部" value="INTERNAL_ONLY" /></el-select></el-form-item>
            <el-form-item label="服务类目映射"><el-input v-model="reviewForm.categoryName" placeholder="政策类内容需映射到正式类目" /></el-form-item>
          </div>
          <el-form-item v-if="reviewTarget?.riskLevel !== 'NORMAL'" label="敏感内容门禁">
            <el-checkbox v-model="reviewForm.acknowledgeRisk" label="我已核对金额、赔偿、退款、安全与内部操作边界" />
            <el-checkbox-group v-model="reviewForm.reviewerRoles"><el-checkbox value="COMPLIANCE_REVIEWER" label="以合规审核角色确认" /></el-checkbox-group>
          </el-form-item>
        </template>
        <el-form-item label="原因代码"><el-input v-model="reviewForm.reasonCode" placeholder="可选，例如 SOURCE_OUTDATED" /></el-form-item>
        <el-form-item label="审核备注"><el-input v-model="reviewForm.comment" type="textarea" :rows="3" maxlength="2000" show-word-limit /></el-form-item>
      </el-form>
      <template #footer><el-button @click="reviewDialogOpen = false">取消</el-button><el-button type="primary" @click="submitReview">记录审核决定</el-button></template>
    </el-dialog>

    <el-dialog v-model="releaseDialogOpen" title="创建知识 Release 草稿" width="min(600px, 94vw)">
      <el-alert title="创建草稿不会让 AI 立即读取；必须由另一位允许名单内的发布人再次确认。" type="info" :closable="false" show-icon />
      <el-form label-position="top" class="release-form">
        <el-form-item label="Release Key"><el-input v-model="releaseForm.releaseKey" /></el-form-item>
        <el-form-item label="消费者视图"><el-select v-model="releaseForm.consumerScope"><el-option label="客服 CUSTOMER_SERVICE" value="CUSTOMER_SERVICE" /><el-option label="上架 LISTING" value="LISTING" /><el-option label="营销 MARKETING" value="MARKETING" /><el-option label="内部 INTERNAL" value="INTERNAL" /></el-select></el-form-item>
        <el-form-item label="版本说明"><el-input v-model="releaseForm.notes" type="textarea" :rows="3" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="releaseDialogOpen = false">取消</el-button><el-button type="primary" @click="submitRelease">创建 {{ approvedSelected.length }} 条内容的草稿</el-button></template>
    </el-dialog>
  </main>
</template>

<style scoped>
.knowledge-page { display: grid; gap: 18px; color: var(--ops-text-primary); }
.page-heading, .section-heading { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; }
.page-heading h1 { margin: 4px 0 6px; font-size: 30px; letter-spacing: -.04em; }
.page-heading p, .section-heading p { margin: 0; color: var(--ops-text-secondary); line-height: 1.6; }
.eyebrow { color: var(--ops-primary); font-size: 12px; font-weight: 750; letter-spacing: .1em; }
.metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.metric-grid article { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; align-items: center; padding: 16px; background: var(--ops-surface); border: 1px solid var(--ops-border); border-radius: 12px; }
.metric-grid article svg { color: var(--ops-primary); grid-row: span 2; }
.metric-grid article span { color: var(--ops-text-secondary); font-size: 13px; }
.metric-grid article strong { font-size: 24px; letter-spacing: -.03em; }
.metric-grid .danger svg { color: #dc2626; } .metric-grid .success svg { color: #0f766e; }
.governance-card { background: var(--ops-surface); border: 1px solid var(--ops-border); border-radius: 14px; padding: 18px; min-width: 0; }
.section-heading { margin-bottom: 14px; align-items: center; }
.section-heading h2 { margin: 0 0 4px; font-size: 18px; }
.actor-fields { display: flex; gap: 10px; min-width: 390px; }
.publisher-input { width: 220px; }
.filters { display: flex; gap: 10px; margin-bottom: 12px; }
.filters .el-select { width: 190px; }
:deep(.el-table strong), :deep(.el-table small) { display: block; }
:deep(.el-table small) { color: var(--ops-text-secondary); margin-top: 4px; line-height: 1.35; }
.review-evidence { padding: 12px 14px; border: 1px solid var(--ops-border); background: var(--ops-surface-muted); border-radius: 10px; margin-bottom: 16px; }
.review-evidence p { margin: 8px 0; line-height: 1.55; max-height: 130px; overflow: auto; }
.review-evidence small { color: var(--ops-text-secondary); }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
.release-form { margin-top: 14px; }
@media (max-width: 1150px) { .metric-grid { grid-template-columns: repeat(2, 1fr); } .section-heading { align-items: flex-start; } .actor-fields { min-width: 0; } }
@media (max-width: 720px) { .page-heading, .section-heading, .actor-fields { flex-direction: column; } .metric-grid { grid-template-columns: 1fr; } .filters { display: grid; grid-template-columns: 1fr; } .filters .el-select, .publisher-input { width: 100%; } .form-grid { grid-template-columns: 1fr; } .governance-card { padding: 14px 10px; } }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition-duration: .01ms !important; } }
</style>
