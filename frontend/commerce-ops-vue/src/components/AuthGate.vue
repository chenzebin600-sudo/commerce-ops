<script setup lang="ts">
import { KeyRound, LoaderCircle, ShieldCheck } from "@lucide/vue";
import { ref } from "vue";
import { verifyAccessToken } from "@/services/api";

const emit = defineEmits<{ authenticated: [] }>();
const token = ref("");
const submitting = ref(false);
const errorMessage = ref("");

async function submit() {
  const accessToken = token.value.trim();
  if (!accessToken) {
    errorMessage.value = "请输入访问密钥";
    return;
  }
  submitting.value = true;
  errorMessage.value = "";
  try {
    await verifyAccessToken(accessToken);
    emit("authenticated");
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "访问密钥错误";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-panel" aria-labelledby="auth-title">
      <div class="auth-brand">
        <span class="auth-brand-mark">CO</span>
        <div>
          <strong>Commerce Ops</strong>
          <span>跨境电商运营工作台</span>
        </div>
      </div>
      <div class="auth-icon"><ShieldCheck :size="25" /></div>
      <span class="panel-kicker">SECURE ACCESS</span>
      <h1 id="auth-title">进入运营工作台</h1>
      <p>输入主服务配置的访问密钥，验证后即可继续使用。</p>
      <form @submit.prevent="submit">
        <label for="access-token">访问密钥</label>
        <el-input id="access-token" v-model="token" type="password" size="large" show-password autocomplete="current-password" placeholder="请输入访问密钥">
          <template #prefix><KeyRound :size="17" /></template>
        </el-input>
        <p v-if="errorMessage" class="auth-error" role="alert">{{ errorMessage }}</p>
        <el-button native-type="submit" type="primary" size="large" :disabled="submitting" class="auth-submit">
          <LoaderCircle v-if="submitting" :size="17" class="spin" />
          {{ submitting ? "正在验证" : "验证并进入" }}
        </el-button>
      </form>
      <small>密钥仅保存在当前浏览器会话中。</small>
    </section>
  </main>
</template>
