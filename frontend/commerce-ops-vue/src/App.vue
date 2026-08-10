<script setup lang="ts">
import { onMounted, ref } from "vue";
import AuthGate from "@/components/AuthGate.vue";
import OpsShell from "@/layouts/OpsShell.vue";
import { getAuthenticationStatus, logout } from "@/services/api";

type AccessState = "checking" | "authenticated" | "required";
const standaloneShopee = new URLSearchParams(window.location.search).get("standalone") === "shopee";
const accessState = ref<AccessState>(standaloneShopee ? "authenticated" : "checking");
const authenticationEnabled = ref(false);

async function checkAccess() {
  accessState.value = "checking";
  try {
    const status = await getAuthenticationStatus();
    authenticationEnabled.value = status.authenticationEnabled;
    accessState.value = status.authenticated ? "authenticated" : "required";
  } catch {
    accessState.value = "required";
  }
}

async function signOut() {
  await logout();
  accessState.value = "required";
}

onMounted(() => {
  if (!standaloneShopee) checkAccess();
});
</script>

<template>
  <main v-if="accessState === 'checking'" class="app-loading" aria-live="polite">
    <span class="app-loading-mark">CO</span>
    <strong>正在连接运营工作台…</strong>
  </main>
  <AuthGate v-else-if="accessState === 'required'" @authenticated="checkAccess" />
  <OpsShell v-else :authentication-enabled="authenticationEnabled" @logout="signOut" />
</template>
