<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useStatusStore } from '@/stores/status'
import { adminToken } from '@/utils/auth'
import {
  hydrateServerBackedStringPreference,
  normalizeAppSeenVersion,
  persistServerBackedStringPreference,
} from '@/utils/view-preferences'

// Async lazy load heavy components
const NotificationModal = defineAsyncComponent(() => import('@/components/NotificationModal.vue'))
const AnnouncementDialog = defineAsyncComponent(() => import('@/components/AnnouncementDialog.vue'))
const ToastContainer = defineAsyncComponent(() => import('@/components/ToastContainer.vue'))
const CopyFeedbackPopup = defineAsyncComponent(() => import('@/components/CopyFeedbackPopup.vue'))

const appStore = useAppStore()
const statusStore = useStatusStore()
const route = useRoute()

// 全局更新弹窗逻辑
const currentVersion = __APP_VERSION__
const APP_SEEN_VERSION_STORAGE_KEY = 'app_seen_version'
const seenVersion = ref('')
const showUpdateModal = ref(false)
const hasCustomBackground = computed(() => !!appStore.loginBackground.trim())
const isLoginRoute = computed(() => route.name === 'login')
const showWorkspaceBackground = computed(() => {
  if (!hasCustomBackground.value || isLoginRoute.value)
    return false
  return appStore.backgroundScope === 'login_and_app' || appStore.backgroundScope === 'global'
})
const workspaceBackgroundStyle = computed(() => ({
  backgroundImage: `url(${appStore.loginBackground.trim()})`,
  backgroundSize: 'cover',
  backgroundPosition: 'center',
}))
const workspaceBackgroundMaskStyle = computed(() => ({
  backgroundColor: `color-mix(in srgb, var(--ui-overlay-backdrop) ${appStore.appBackgroundOverlayOpacity}%, transparent)`,
  backdropFilter: `blur(${appStore.appBackgroundBlur}px)`,
  WebkitBackdropFilter: `blur(${appStore.appBackgroundBlur}px)`,
}))

async function hydrateSeenVersionPreference() {
  seenVersion.value = await hydrateServerBackedStringPreference({
    payloadKey: 'appSeenVersion',
    localKey: APP_SEEN_VERSION_STORAGE_KEY,
    normalize: normalizeAppSeenVersion,
  })
}

function markCurrentVersionAsSeen() {
  const normalizedVersion = normalizeAppSeenVersion(currentVersion, '')
  seenVersion.value = normalizedVersion
  void persistServerBackedStringPreference({
    payloadKey: 'appSeenVersion',
    localKey: APP_SEEN_VERSION_STORAGE_KEY,
    value: normalizedVersion,
    normalize: normalizeAppSeenVersion,
  })
}

function syncUpdateModalVisibility() {
  if (seenVersion.value !== currentVersion) {
    showUpdateModal.value = true
    markCurrentVersionAsSeen()
  }
}

onMounted(async () => {
  appStore.fetchUIConfig()
  await hydrateSeenVersionPreference()
  syncUpdateModalVisibility()
})

watch(adminToken, async (newToken, oldToken) => {
  if (!newToken) {
    statusStore.disconnectRealtime()
    return
  }
  if (newToken && !oldToken) {
    await hydrateSeenVersionPreference()
    syncUpdateModalVisibility()
  }
})
</script>

<template>
  <div class="ui-app-root relative z-0 h-screen w-screen overflow-hidden bg-theme-bg transition-colors duration-300 dark:bg-theme-darkbg">
    <div
      v-if="showWorkspaceBackground"
      class="app-scene-background"
      :style="workspaceBackgroundStyle"
    >
      <div class="app-scene-background__mask" :style="workspaceBackgroundMaskStyle" />
      <div class="app-scene-background__vignette" />
    </div>

    <!-- 动态流动光球背景层 -->
    <div class="mesh-bg" :class="{ 'mesh-bg-muted': showWorkspaceBackground }">
      <div class="mesh-orb orb-1" />
      <div class="mesh-orb orb-2" />
      <div class="mesh-orb orb-3" />
    </div>

    <RouterView v-slot="{ Component }" class="relative z-10">
      <template v-if="Component">
        <Suspense>
          <component :is="Component" />
          <template #fallback>
            <div class="h-screen w-screen flex flex-col items-center justify-center bg-theme-bg/80 backdrop-blur-sm dark:bg-theme-darkbg/80">
              <div class="i-carbon-circle-dash mb-4 h-12 w-12 animate-spin text-primary-500" />
              <p class="ui-text-2">
                正在按需分配计算层...
              </p>
            </div>
          </template>
        </Suspense>
      </template>
    </RouterView>
    <CopyFeedbackPopup />
    <ToastContainer class="relative z-50" />
    <!-- 全局首次更新大弹窗 -->
    <NotificationModal
      :show="showUpdateModal"
      class="relative z-50"
      @close="showUpdateModal = false"
    />
    <!-- 管理员公告弹窗（登录后展示，可关闭并记录已读） -->
    <AnnouncementDialog />
  </div>
</template>

<style>
/* Global styles */
body {
  margin: 0;
  font-family:
    'Avenir Next', 'Segoe UI Variable Text', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei UI', sans-serif;
}

.ui-app-root {
  color: var(--ui-text-1);
}

.app-scene-background {
  position: fixed;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  opacity: 1;
  transition: opacity 0.5s ease;
}

.app-scene-background__mask {
  position: absolute;
  inset: 0;
}

.app-scene-background__vignette {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 18% 18%, color-mix(in srgb, var(--ui-text-on-brand) 8%, transparent), transparent 36%),
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--ui-text-on-brand) 8%, transparent),
      transparent 32%,
      color-mix(in srgb, var(--ui-overlay-backdrop) 55%, transparent)
    );
}

.mesh-bg.mesh-bg-muted {
  opacity: 0.24 !important;
  mix-blend-mode: screen;
}
</style>
