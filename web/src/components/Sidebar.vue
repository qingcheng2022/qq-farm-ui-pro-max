<script setup lang="ts">
import { useDateFormat, useIntervalFn, useMediaQuery, useNow } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import api from '@/api'
import AccountModal from '@/components/AccountModal.vue'
import NotificationModal from '@/components/NotificationModal.vue'
import RemarkModal from '@/components/RemarkModal.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'

import { menuRoutes } from '@/router/menu'
import { useAccountStore } from '@/stores/account'
import { useAppStore } from '@/stores/app'
import { useFarmToolsStore } from '@/stores/farmTools'
import { useStatusStore } from '@/stores/status'

import { useAvatar } from '@/utils/avatar'
import { hydrateServerBackedStringPreference, normalizeNotificationLastReadDate } from '@/utils/view-preferences'

const { getAvatarUrl, markFailed } = useAvatar()

const accountStore = useAccountStore()
const statusStore = useStatusStore()
const appStore = useAppStore()
const route = useRoute()
const { accounts, currentAccount } = storeToRefs(accountStore)
const { status, realtimeConnected } = storeToRefs(statusStore)
const { sidebarOpen } = storeToRefs(appStore)
const farmToolsStore = useFarmToolsStore()
const { isAvailable: isFarmToolsAvailable } = storeToRefs(farmToolsStore)
const ACCOUNT_SELECTION_BROWSER_PREF_NOTE = '当前账号选择会跟随当前登录账号同步到服务器；如果网络异常，本机仍会先用本地缓存兜底。'

// 响应式检测是否为宽屏（xl 断点 ≥ 1280px）
const isDesktop = useMediaQuery('(min-width: 1280px)')

// 计算侧边栏的 transform 样式
// 宽屏下始终不设位移，窄屏下由 sidebarOpen 控制滑入/滑出
const sidebarTransform = computed(() => {
  if (isDesktop.value)
    return 'none'
  return sidebarOpen.value ? 'translateX(0)' : 'translateX(-100%)'
})

const showAccountDropdown = ref(false)
const showAccountModal = ref(false)
const showRemarkModal = ref(false)
const showNotificationModal = ref(false)
const accountToEdit = ref<any>(null)
const wsErrorNotifiedAt = ref<Record<string, number>>({})
const hasUnread = ref(false)
// 防抖标志：弹窗刚关闭后一段时间内忽略 wsError 触发的自动弹窗
// 解决扫码成功后因 restartWorker 异步过程触发 wsError 导致弹窗再次打开的问题
let justClosedModal = false
let justClosedTimer: ReturnType<typeof setTimeout> | null = null
// 结构化防抖：记录最近一次成功保存账号的时间戳，用于 wsError 过滤
let lastAccountSavedAt = 0
// QR 登录进行中标志：保存账号后 15 秒内忽略所有 wsError
let qrLoginInProgress = false
let qrLoginTimer: ReturnType<typeof setTimeout> | null = null

const systemConnected = ref(true)
const serverUptimeBase = ref(0)
const serverVersion = ref('')
const lastPingTime = ref(Date.now())
const now = useNow()
const formattedTime = useDateFormat(now, 'YYYY-MM-DD HH:mm:ss')

async function checkConnection() {
  try {
    const res = await api.get('/api/ping')
    systemConnected.value = true
    if (res.data.ok && res.data.data) {
      if (res.data.data.uptime) {
        serverUptimeBase.value = res.data.data.uptime
        lastPingTime.value = Date.now()
      }
      if (res.data.data.version) {
        serverVersion.value = res.data.data.version
      }
    }
    const accountRef = currentAccount.value?.id || currentAccount.value?.uin
    if (accountRef && !realtimeConnected.value) {
      statusStore.connectRealtime(String(accountRef))
    }
  }
  catch {
    systemConnected.value = false
  }
}

async function refreshStatusFallback() {
  if (realtimeConnected.value)
    return

  const accountRef = currentAccount.value?.id || currentAccount.value?.uin
  if (accountRef) {
    await statusStore.fetchStatus(String(accountRef))
  }
}

async function handleAccountSaved() {
  await accountStore.fetchAccounts()
  await refreshStatusFallback()
  showAccountModal.value = false
  showRemarkModal.value = false
  accountToEdit.value = null
  // 记录保存时间戳（结构化防抖，用于 wsError 过滤）
  lastAccountSavedAt = Date.now()
  // 扫码成功后设置全局冷却，15 秒内完全忽略 wsError（覆盖 restartWorker 的完整异步过程 + WS 400 重试窗口）
  qrLoginInProgress = true
  if (qrLoginTimer) {
    clearTimeout(qrLoginTimer)
  }
  qrLoginTimer = setTimeout(() => {
    qrLoginInProgress = false
  }, 15000)
  // 设置防抖，8 秒内忽略 wsError 弹窗（覆盖 restartWorker 的 stop+start+connect+login 异步过程）
  justClosedModal = true
  if (justClosedTimer) {
    clearTimeout(justClosedTimer)
  }
  justClosedTimer = setTimeout(() => {
    justClosedModal = false
  }, 8000)
}

function closeAccountModal() {
  showAccountModal.value = false
  accountToEdit.value = null
  justClosedModal = true
  if (justClosedTimer) {
    clearTimeout(justClosedTimer)
  }
  justClosedTimer = setTimeout(() => {
    justClosedModal = false
  }, 8000)
}

function openRemarkModal(acc: any) {
  accountToEdit.value = acc
  showRemarkModal.value = true
  showAccountDropdown.value = false
}

onMounted(async () => {
  await appStore.fetchUIConfig()
  await accountStore.fetchAccounts()
  checkConnection()
  loadCurrentUser()
  checkUnread()
  farmToolsStore.checkAvailability()
})

onBeforeUnmount(() => {
  statusStore.disconnectRealtime()
})

// 监听路由变化，重新加载用户信息
watch(() => route.fullPath, () => {
  loadCurrentUser()
}, { immediate: false })

useIntervalFn(checkConnection, 30000)
useIntervalFn(() => {
  refreshStatusFallback()
  accountStore.fetchAccounts()
}, 10000)

watch(() => currentAccount.value?.id || currentAccount.value?.uin || '', () => {
  const accountRef = currentAccount.value?.id || currentAccount.value?.uin
  statusStore.connectRealtime(String(accountRef || ''))
  refreshStatusFallback()
}, { immediate: true })

watch(() => status.value?.wsError, (wsError: any) => {
  if (!wsError || Number(wsError.code) !== 400 || !currentAccount.value)
    return

  // 防抖：弹窗刚关闭后的 8 秒内不自动弹出，避免扫码成功后重复弹窗
  if (justClosedModal)
    return
  // QR 登录冷却期内忽略所有 wsError（15 秒全局冷却，覆盖 restartWorker + WS 重连窗口）
  if (qrLoginInProgress)
    return
  // 结构化防抖：距离上次保存账号 < 10 秒，忽略 wsError（覆盖 restartWorker 的完整异步过程）
  if (lastAccountSavedAt > 0 && (Date.now() - lastAccountSavedAt) < 10000)
    return
  // 如果弹窗已经打开，不重复触发
  if (showAccountModal.value)
    return

  const errAt = Number(wsError.at) || 0
  const accId = String(currentAccount.value.id || currentAccount.value.uin || '')
  const lastNotified = wsErrorNotifiedAt.value[accId] || 0
  if (errAt <= lastNotified)
    return

  wsErrorNotifiedAt.value[accId] = errAt
  accountToEdit.value = currentAccount.value
  showAccountModal.value = true
}, { deep: true })

const uptime = computed(() => {
  const diff = Math.floor(serverUptimeBase.value + (now.value.getTime() - lastPingTime.value) / 1000)
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  const s = diff % 60
  return `${h}h ${m}m ${s}s`
})

const displayName = computed(() => {
  const acc = currentAccount.value
  if (!acc)
    return '选择账号'

  // 1. 优先显示实时状态中的昵称 (如果有且不是未登录)
  const liveName = status.value?.status?.name
  if (liveName && liveName !== '未登录') {
    return liveName
  }

  // 2. 其次显示账号存储的备注名称 (name)
  if (acc.name)
    return acc.name

  // 3. 显示同步的昵称 (nick)
  if (acc.nick)
    return acc.nick

  // 4. 最后显示UIN
  return acc.uin
})

const connectionStatus = computed(() => {
  if (!systemConnected.value) {
    return {
      text: '系统离线',
      color: 'bg-red-500',
      pulse: false,
    }
  }

  if (!currentAccount.value?.id) {
    return {
      text: '请添加账号',
      color: 'status-dot-muted',
      pulse: false,
    }
  }

  const isConnected = status.value?.connection?.connected
  if (isConnected) {
    return {
      text: '运行中',
      color: 'bg-primary-500',
      pulse: true,
    }
  }

  return {
    text: '未连接',
    color: 'status-dot-muted', // muted by design token
    pulse: false,
  }
})

// 用户信息
const currentUser = ref<any>(null)

function loadCurrentUser() {
  try {
    const userStr = localStorage.getItem('current_user')
    if (userStr) {
      currentUser.value = JSON.parse(userStr)
    }
  }
  catch (e) {
    console.error('加载用户信息失败:', e)
  }
}

const isAdmin = computed(() => {
  return currentUser.value?.role === 'admin'
})

// 监听 localStorage 变化（跨标签页同步）
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'current_user' && e.newValue) {
      try {
        currentUser.value = JSON.parse(e.newValue)
      }
      catch (err) {
        console.error('解析用户信息失败:', err)
      }
    }
  })
}

/**
 * 检查是否有未读通知
 */
async function checkUnread() {
  try {
    const [res, lastRead] = await Promise.all([
      api.get('/api/notifications', { params: { limit: 1 } }),
      hydrateServerBackedStringPreference({
        payloadKey: 'notificationLastReadDate',
        localKey: 'last_read_notification_date',
        normalize: normalizeNotificationLastReadDate,
      }),
    ])
    if (res.data.ok && res.data.data?.length > 0) {
      const latestDate = res.data.data[0].date
      hasUnread.value = latestDate !== lastRead
    }
  }
  catch {
    // 静默失败
  }
}

function openNotifications() {
  showNotificationModal.value = true
  hasUnread.value = false
}

// 过滤菜单项：管理员可以看到所有菜单，普通用户看不到 adminOnly 的菜单
const navItems = computed(() => menuRoutes
  .filter((item: any) => {
    // 管理员可以看到所有菜单，普通用户看不到 adminOnly 的菜单
    if (item.adminOnly) {
      return isAdmin.value
    }
    return true
  })
  .map(item => ({
    path: item.path ? `/${item.path}` : '/',
    label: item.label,
    icon: item.icon,
  })))

function selectAccount(acc: any) {
  accountStore.setCurrentAccount(acc)
  showAccountDropdown.value = false
}

const version = __APP_VERSION__

watch(
  () => route.path,
  () => {
    // Close sidebar on route change (mobile only)
    if (window.innerWidth < 1280)
      appStore.closeSidebar()
  },
)

function onNavClick() {
  if (window.innerWidth < 1280) {
    appStore.closeSidebar()
  }
}

const supportQqGroup = computed(() => appStore.supportQqGroup)
const copyrightText = computed(() => appStore.copyrightText)
</script>

<template>
  <aside
    class="sidebar-shell glass-panel fixed inset-y-0 left-0 z-50 h-full w-64 flex flex-col border-r transition-transform duration-300 xl:static"
    :style="{ transform: sidebarTransform }"
  >
    <!-- Brand -->
    <div class="sidebar-brand h-16 flex items-center justify-between border-b px-4">
      <div class="flex items-center gap-2">
        <!-- 窄屏关闭按钮 (移至最左侧) -->
        <button
          class="sidebar-ghost-btn flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 xl:hidden"
          @click="appStore.closeSidebar"
        >
          <div class="i-carbon-close text-lg" />
          <span class="text-xs font-semibold">收起</span>
        </button>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640" class="h-7 w-7 xl:ml-2">
          <defs>
            <linearGradient id="sidebarGrad" x1="0" y1="1" x2="0.3" y2="0">
              <stop offset="0%" stop-color="var(--ui-status-success)" />
              <stop offset="60%" stop-color="var(--ui-status-success)" />
              <stop offset="100%" stop-color="var(--ui-status-success)" stop-opacity="0.7" />
            </linearGradient>
          </defs>
          <path fill="url(#sidebarGrad)" d="M576 96c0 108.1-76.6 198.3-178.4 219.4c-7.9-58.1-34-110.4-72.5-150.9C365.2 104 433.9 64 512 64h32c17.7 0 32 14.3 32 32M64 160c0-17.7 14.3-32 32-32h32c123.7 0 224 100.3 224 224v192c0 17.7-14.3 32-32 32s-32-14.3-32-32V384C164.3 384 64 283.7 64 160" />
          <circle cx="190" cy="220" r="6" fill="white" opacity="0.6" />
          <circle cx="205" cy="195" r="3.5" fill="white" opacity="0.45" />
          <circle cx="470" cy="150" r="5" fill="white" opacity="0.5" />
          <circle cx="490" cy="125" r="3" fill="white" opacity="0.35" />
        </svg>
        <span class="from-primary-600 to-emerald-500 bg-gradient-to-r bg-clip-text px-1 text-lg text-transparent font-bold tracking-widest">
          🌌 御农
        </span>
      </div>
      <!-- 右侧占位，保持整体平衡 -->
      <div class="w-8 xl:hidden" />
    </div>
    <!-- Account Selector -->
    <div class="sidebar-account border-b p-4">
      <div class="group relative">
        <button
          class="sidebar-account-trigger w-full flex items-center justify-between border rounded-xl px-4 py-2.5 outline-none backdrop-blur-sm transition-all duration-200"
          @click="showAccountDropdown = !showAccountDropdown"
        >
          <div class="flex items-center gap-3 overflow-hidden">
            <div class="sidebar-avatar-shell h-8 w-8 flex shrink-0 items-center justify-center overflow-hidden rounded-full">
              <img
                v-if="currentAccount && getAvatarUrl(currentAccount)"
                :src="getAvatarUrl(currentAccount)"
                class="h-full w-full object-cover"
                @error="(e) => markFailed((e.target as HTMLImageElement).src)"
              >
              <div v-else class="i-carbon-user glass-text-muted" />
            </div>
            <div class="min-w-0 flex flex-col items-start">
              <span class="w-full truncate text-left text-sm font-medium">
                {{ displayName }}
              </span>
              <span class="glass-text-muted w-full truncate text-left text-xs">
                {{ currentAccount?.uin || currentAccount?.id || '未选择' }}
              </span>
            </div>
          </div>
          <div
            class="i-carbon-chevron-down glass-text-muted transition-transform duration-200"
            :class="{ 'rotate-180': showAccountDropdown }"
          />
        </button>
        <p class="mt-2 px-1 text-[11px] text-sky-600 leading-5 dark:text-sky-300">
          {{ ACCOUNT_SELECTION_BROWSER_PREF_NOTE }}
        </p>

        <!-- Dropdown Menu -->
        <div
          v-if="showAccountDropdown"
          class="sidebar-account-menu glass-panel absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden border rounded-xl py-1 shadow-xl"
        >
          <div class="custom-scrollbar max-h-60 overflow-y-auto">
            <template v-if="accounts.length > 0">
              <button
                v-for="acc in accounts"
                :key="acc.id || acc.uin"
                class="sidebar-dropdown-item w-full flex items-center gap-3 px-4 py-2 transition-colors"
                :class="{ 'bg-primary-50/50 dark:bg-primary-500/20': currentAccount?.id === acc.id }"
                @click="selectAccount(acc)"
              >
                <div class="sidebar-dropdown-avatar h-6 w-6 flex shrink-0 items-center justify-center overflow-hidden rounded-full">
                  <img
                    v-if="getAvatarUrl(acc)"
                    :src="getAvatarUrl(acc)"
                    class="h-full w-full object-cover"
                    @error="(e) => markFailed((e.target as HTMLImageElement).src)"
                  >
                  <div v-else class="i-carbon-user glass-text-muted" />
                </div>
                <div class="min-w-0 flex flex-1 flex-col items-start">
                  <span class="w-full truncate text-left text-sm font-medium">
                    {{ acc.name || acc.nick || acc.uin }}
                  </span>
                  <span class="glass-text-muted text-xs">{{ acc.uin || acc.id }}</span>
                </div>
                <div class="flex items-center gap-1">
                  <button
                    class="glass-text-muted rounded-full p-1 transition-colors hover:bg-blue-50 hover:text-blue-500 dark:hover:bg-blue-900/20"
                    title="修改备注"
                    @click.stop="openRemarkModal(acc)"
                  >
                    <div class="i-carbon-edit" />
                  </button>
                  <div v-if="currentAccount?.id === acc.id" class="i-carbon-checkmark text-primary-500" />
                </div>
              </button>
            </template>
            <div v-else class="glass-text-muted px-4 py-3 text-center text-sm">
              暂无账号
            </div>
          </div>
          <div class="sidebar-account-menu-footer mt-1 border-t pt-1">
            <button
              class="sidebar-account-action w-full flex items-center gap-2 px-4 py-2 text-sm transition-colors"
              @click="showAccountModal = true; showAccountDropdown = false"
            >
              <div class="i-carbon-add" />
              <span>添加账号</span>
            </button>
            <router-link
              to="/accounts"
              class="sidebar-account-action w-full flex items-center gap-2 px-4 py-2 text-sm transition-colors"
              @click="showAccountDropdown = false"
            >
              <div class="i-carbon-add-alt" />
              <span>管理账号</span>
            </router-link>
          </div>
        </div>
      </div>
    </div>

    <!-- Navigation -->
    <nav class="flex-1 overflow-y-auto px-3 py-4 space-y-1">
      <router-link
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="sidebar-nav-link group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all duration-200"
        :active-class="item.path === '/' ? '' : 'bg-primary-50 dark:bg-primary-900/10 text-primary-600 dark:text-primary-400 font-medium shadow-sm ring-1 ring-primary-500/10'"
        :exact-active-class="item.path === '/' ? 'bg-primary-50 dark:bg-primary-900/10 text-primary-600 dark:text-primary-400 font-medium shadow-sm ring-1 ring-primary-500/10' : ''"
        @click="onNavClick"
      >
        <div class="text-xl transition-transform duration-200 group-hover:scale-110" :class="[item.icon]" />
        <span>{{ item.label }}</span>
      </router-link>
    </nav>

    <!-- 通知入口按钮 -->
    <div class="px-3 pb-2">
      <button
        class="sidebar-entry-btn sidebar-entry-btn--notice w-full flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all duration-200"
        @click="() => { onNavClick(); openNotifications(); }"
      >
        <div class="relative">
          <div class="i-carbon-notification text-xl" />
          <div
            v-if="hasUnread"
            class="absolute h-2.5 w-2.5 animate-pulse rounded-full bg-red-500 ring-2 ring-white -right-1 -top-1 dark:ring-gray-800"
          />
        </div>
        <span>更新公告</span>
      </button>
    </div>

    <!-- 农场工具入口 -->
    <div v-if="isFarmToolsAvailable" class="px-3 pb-2">
      <router-link
        to="/farm-tools"
        class="sidebar-entry-btn sidebar-entry-btn--farm w-full flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all duration-200"
        active-class="bg-emerald-50 dark:bg-emerald-900/10 text-emerald-600 dark:text-emerald-400 font-medium shadow-sm ring-1 ring-emerald-500/10"
        @click="onNavClick"
      >
        <div class="i-carbon-tool-box text-xl" />
        <span>农场工具</span>
      </router-link>
    </div>

    <!-- 帮助中心入口 -->
    <div class="px-3 pb-2">
      <router-link
        to="/help"
        class="sidebar-entry-btn sidebar-entry-btn--help w-full flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all duration-200"
        @click="onNavClick"
      >
        <div class="i-carbon-book text-xl" />
        <span>帮助中心</span>
      </router-link>
    </div>

    <!-- Footer Status -->
    <div class="sidebar-footer mt-auto border-t p-4">
      <div class="glass-text-muted mb-2 flex items-center justify-between text-xs">
        <div class="flex items-center gap-1.5">
          <div
            class="h-2 w-2 rounded-full"
            :class="[connectionStatus.color, { 'animate-pulse': connectionStatus.pulse }]"
          />
          <span>{{ connectionStatus.text }}</span>
        </div>
        <div class="flex items-center gap-2">
          <span>{{ uptime }}</span>
          <ThemeToggle />
        </div>
      </div>
      <div class="sidebar-footer-meta mt-1 flex flex-col gap-0.5 text-xs font-mono">
        <div class="flex items-center justify-between">
          <span>{{ formattedTime }}</span>
        </div>
        <div class="flex items-center justify-between opacity-50">
          <span>Web v{{ version }}</span>
          <span v-if="serverVersion">Core v{{ serverVersion }}</span>
        </div>
        <!-- 侧栏微缩防伪水印 -->
        <div class="sidebar-watermark pointer-events-none mt-1.5 flex select-none items-center justify-between border-t pt-1.5 text-[10px]">
          <span>{{ copyrightText }}</span>
          <span>QQ群: {{ supportQqGroup }}</span>
        </div>
      </div>
    </div>
  </aside>

  <!-- Overlay for mobile when sidebar is open -->
  <div
    v-if="showAccountDropdown"
    class="fixed inset-0 z-40 bg-transparent"
    @click="showAccountDropdown = false"
  />

  <AccountModal
    :show="showAccountModal"
    :edit-data="accountToEdit"
    @close="closeAccountModal"
    @saved="handleAccountSaved"
  />

  <RemarkModal
    :show="showRemarkModal"
    :account="accountToEdit"
    @close="showRemarkModal = false"
    @saved="handleAccountSaved"
  />

  <NotificationModal
    :show="showNotificationModal"
    @close="showNotificationModal = false"
  />
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: var(--ui-scrollbar-thumb);
  border-radius: 2px;
}
.custom-scrollbar:hover::-webkit-scrollbar-thumb {
  background-color: var(--ui-scrollbar-thumb-hover);
}

.sidebar-shell {
  border-color: var(--ui-border-subtle);
}

.sidebar-brand,
.sidebar-account {
  border-color: var(--ui-border-subtle);
}

.sidebar-ghost-btn {
  color: var(--ui-text-2);
}

.sidebar-ghost-btn:hover {
  background: var(--ui-bg-surface);
  color: var(--ui-text-1);
}

.sidebar-account-trigger {
  border-color: transparent;
  background: color-mix(in srgb, var(--ui-bg-surface) 60%, transparent);
}

.sidebar-account-trigger:hover {
  border-color: var(--ui-border-subtle);
  background: color-mix(in srgb, var(--ui-bg-surface-raised) 72%, transparent);
}

.sidebar-account-menu {
  border-color: var(--ui-border-subtle);
}

.sidebar-dropdown-item:hover {
  background: color-mix(in srgb, var(--ui-bg-surface-raised) 72%, transparent);
}

.sidebar-account-menu-footer {
  border-color: var(--ui-border-subtle);
}

.sidebar-account-action {
  color: var(--ui-text-1);
}

.sidebar-account-action:hover {
  background: var(--ui-bg-surface);
}

.sidebar-nav-link {
  color: var(--ui-text-2);
}

.sidebar-nav-link:hover {
  background: var(--ui-bg-surface);
  color: var(--ui-text-1);
}

.sidebar-entry-btn {
  color: var(--ui-text-2);
}

.sidebar-entry-btn:hover {
  background: var(--ui-bg-surface);
}

.sidebar-entry-btn--notice:hover {
  color: var(--ui-status-warning);
}
.sidebar-entry-btn--farm:hover {
  color: var(--ui-status-success);
}
.sidebar-entry-btn--help:hover {
  color: var(--ui-status-info);
}

.sidebar-footer {
  border-color: var(--ui-border-subtle);
  background: color-mix(in srgb, var(--ui-bg-surface) 60%, transparent);
}

.sidebar-footer-meta {
  color: var(--ui-text-3);
}

.sidebar-watermark {
  border-color: var(--ui-border-subtle);
  color: color-mix(in srgb, var(--ui-text-3) 80%, transparent);
}

.status-dot-muted {
  background-color: var(--ui-text-3);
}

.sidebar-shell
  :is(
    [class*='text-'][class*='gray-400'],
    [class*='text-'][class*='gray-500'],
    [class*='dark:text-'][class*='gray-400']
  ) {
  color: var(--ui-text-2) !important;
}

.sidebar-avatar-shell,
.sidebar-dropdown-avatar {
  background: color-mix(in srgb, var(--ui-bg-surface-raised) 88%, transparent) !important;
  border: 1px solid var(--ui-border-subtle) !important;
}

.sidebar-shell [class*='hover:bg-blue-50'],
.sidebar-shell [class*='dark:hover:bg-blue-900/20'] {
  background: color-mix(in srgb, var(--ui-brand-500) 12%, transparent) !important;
}

.sidebar-shell [class*='hover:text-blue-500'] {
  color: var(--ui-brand-600) !important;
}
</style>
