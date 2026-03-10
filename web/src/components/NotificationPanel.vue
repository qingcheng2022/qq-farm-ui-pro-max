<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import {
  hydrateServerBackedStringPreference,
  normalizeNotificationLastReadDate,
  persistServerBackedStringPreference,
} from '@/utils/view-preferences'

const props = defineProps<{
  /** card = 登录页卡片模式, sidebar = 侧边栏弹窗模式 */
  mode?: 'card' | 'sidebar'
  /** 最多显示条数 */
  limit?: number
}>()

interface NotificationEntry {
  date: string
  title: string
  version: string
  content: string
}

const entries = ref<NotificationEntry[]>([])
const loading = ref(false)
const expandedIdx = ref<number>(0) // 默认展开第一条
const lastReadDate = ref('')
const NOTIFICATION_LAST_READ_STORAGE_KEY = 'last_read_notification_date'
const NOTIFICATION_SYNC_NOTE = '通知已读状态会跟随当前登录账号同步到服务器；离线时仍会先用本机缓存兜底。'

const displayLimit = computed(() => props.limit || (props.mode === 'card' ? 3 : 10))

function getNotificationCardClass(idx: number) {
  return expandedIdx.value === idx
    ? 'notification-panel-card notification-panel-card--active'
    : 'notification-panel-card notification-panel-card--idle'
}

/** 获取通知数据 */
async function fetchNotifications() {
  loading.value = true
  try {
    const res = await api.get('/api/notifications', { params: { limit: displayLimit.value } })
    if (res.data.ok) {
      entries.value = res.data.data || []
    }
  }
  catch {
    // 静默失败，通知非关键路径
  }
  finally {
    loading.value = false
  }
}

/** 切换展开/折叠 */
function toggle(idx: number) {
  expandedIdx.value = expandedIdx.value === idx ? -1 : idx
}

/** 标记已读（存到 localStorage） */
async function hydrateLastReadDate() {
  lastReadDate.value = await hydrateServerBackedStringPreference({
    payloadKey: 'notificationLastReadDate',
    localKey: NOTIFICATION_LAST_READ_STORAGE_KEY,
    normalize: normalizeNotificationLastReadDate,
  })
}

/** 标记已读（优先同步服务端，本地作为兜底） */
async function markAsRead() {
  if (entries.value.length === 0)
    return
  const latestDate = normalizeNotificationLastReadDate(entries.value[0]!.date, '')
  if (!latestDate || latestDate === lastReadDate.value)
    return
  lastReadDate.value = await persistServerBackedStringPreference({
    payloadKey: 'notificationLastReadDate',
    localKey: NOTIFICATION_LAST_READ_STORAGE_KEY,
    value: latestDate,
    normalize: normalizeNotificationLastReadDate,
  })
}

onMounted(async () => {
  await Promise.all([fetchNotifications(), hydrateLastReadDate()])
  await markAsRead()
})

defineExpose({ fetchNotifications })
</script>

<template>
  <div class="notification-panel">
    <!-- 加载中 -->
    <div v-if="loading && !entries.length" class="glass-text-muted py-4 text-center text-sm">
      <div class="i-svg-spinners-90-ring-with-bg inline-block text-lg" />
    </div>

    <!-- 空状态 -->
    <div v-else-if="!entries.length" class="glass-text-muted py-4 text-center text-sm">
      暂无更新公告
    </div>

    <!-- 通知列表 -->
    <div v-else class="space-y-2">
      <p class="notification-panel-note rounded-xl px-3 py-2 text-xs leading-5">
        {{ NOTIFICATION_SYNC_NOTE }}
      </p>
      <div
        v-for="(entry, idx) in entries"
        :key="entry.date + idx"
        class="overflow-hidden rounded-lg transition-all"
        :class="getNotificationCardClass(idx)"
      >
        <!-- 条目头部（可点击展开） -->
        <button
          class="notification-panel-toggle w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
          @click="toggle(idx)"
        >
          <!-- 展开指示器 -->
          <div
            class="i-carbon-chevron-right glass-text-muted text-xs transition-transform"
            :class="expandedIdx === idx ? 'rotate-90' : ''"
          />
          <!-- 日期 -->
          <span class="glass-text-muted text-xs tabular-nums">{{ entry.date }}</span>
          <!-- 版本徽章 -->
          <span
            v-if="entry.version"
            class="notification-panel-version rounded-full px-1.5 py-0.5 text-[10px] font-medium"
          >
            {{ entry.version }}
          </span>
          <!-- 标题 -->
          <span class="glass-text-main flex-1 truncate text-sm font-medium">
            {{ entry.title }}
          </span>
          <!-- 最新标记 -->
          <span
            v-if="idx === 0"
            class="notification-panel-latest rounded-full px-1.5 py-0.5 text-[10px] font-medium"
          >
            最新
          </span>
        </button>

        <!-- 展开内容 -->
        <div v-if="expandedIdx === idx && entry.content" class="notification-panel-content px-4 py-3">
          <pre class="glass-text-muted whitespace-pre-wrap text-xs leading-relaxed">{{ entry.content }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notification-panel {
  color: var(--ui-text-1);
}

.notification-panel-note,
.notification-panel-card,
.notification-panel-content {
  border-color: var(--ui-border-subtle) !important;
  border-style: solid;
  border-width: 1px;
}

.notification-panel-note {
  background: color-mix(in srgb, var(--ui-status-info) 8%, var(--ui-bg-surface)) !important;
  color: color-mix(in srgb, var(--ui-status-info) 74%, var(--ui-text-1)) !important;
}

.notification-panel-card--idle,
.notification-panel-content {
  background: color-mix(in srgb, var(--ui-bg-surface) 70%, transparent) !important;
}

.notification-panel-card--active {
  background: var(--ui-brand-soft-10) !important;
}

.notification-panel-toggle:hover {
  background: color-mix(in srgb, var(--ui-bg-surface-raised) 84%, transparent) !important;
}

.notification-panel-version {
  background: color-mix(in srgb, var(--ui-status-info) 10%, transparent) !important;
  color: color-mix(in srgb, var(--ui-status-info) 78%, var(--ui-text-1)) !important;
}

.notification-panel-latest {
  background: var(--ui-brand-soft-12) !important;
  color: color-mix(in srgb, var(--ui-brand-700) 76%, var(--ui-text-1)) !important;
}

.notification-panel-content {
  border-left: none !important;
  border-right: none !important;
  border-bottom: none !important;
}
</style>
