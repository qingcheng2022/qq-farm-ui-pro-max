<script setup lang="ts">
import type { AnalyticsViewState } from '@/utils/view-preferences'
import { useStorage } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import api from '@/api'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import { useAccountStore } from '@/stores/account'
import { useStatusStore } from '@/stores/status'
import { DEFAULT_ANALYTICS_VIEW_STATE, fetchViewPreferences, normalizeAnalyticsViewState, saveViewPreferences } from '@/utils/view-preferences'

const accountStore = useAccountStore()
const statusStore = useStatusStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { status, realtimeConnected } = storeToRefs(statusStore)

const loading = ref(false)
const list = ref<any[]>([])
const sortKey = useStorage<AnalyticsViewState['sortKey']>('analytics_sort_key', DEFAULT_ANALYTICS_VIEW_STATE.sortKey)
const imageErrors = ref<Record<string | number, boolean>>({})
const strategyPanelCollapsed = useStorage('analytics_strategy_collapsed', false)
const ANALYTICS_BROWSER_PREF_NOTE = '排序方式和“展开 / 收起推荐”会跟随当前登录用户同步到服务器；本机缓存只作首屏兜底。'
let analyticsViewSyncTimer: ReturnType<typeof setTimeout> | null = null
let analyticsViewHydrating = false
let analyticsViewSyncEnabled = false
const strategyLevel = ref(0)
const strategyLevelMode = ref<'account' | 'manual'>('account')
const liveAccountLevel = ref<number | null>(null)
const analyticsViewSignature = computed(() => JSON.stringify(buildAnalyticsViewState()))

// 策略推荐定义 (参考 PR 版 Analytics.vue)
const strategies = [
  { key: 'max_exp', label: '经验/时', metric: 'expPerHour', color: 'purple', icon: 'i-carbon-growth', unit: 'EXP', desc: '每小时经验收益最高' },
  { key: 'max_profit', label: '利润/时', metric: 'profitPerHour', color: 'amber', icon: 'i-carbon-money', unit: '金币', desc: '每小时净利润最高' },
  { key: 'max_fert_exp', label: '普肥经验/时', metric: 'normalFertilizerExpPerHour', color: 'blue', icon: 'i-carbon-flash', unit: 'EXP', desc: '使用普通化肥后经验最高' },
  { key: 'max_fert_profit', label: '普肥利润/时', metric: 'normalFertilizerProfitPerHour', color: 'green', icon: 'i-carbon-piggy-bank', unit: '金币', desc: '使用普通化肥后利润最高' },
]

function normalizeLevel(value: any) {
  const level = Number(value)
  return Number.isFinite(level) && level > 0 ? Math.floor(level) : 0
}

const sortOptions = [
  { value: 'exp', label: '经验/小时' },
  { value: 'fert', label: '普通肥经验/小时' },
  { value: 'profit', label: '利润/小时' },
  { value: 'fert_profit', label: '普通肥利润/小时' },
  { value: 'level', label: '等级' },
]

const currentAccountLevel = computed(() => normalizeLevel(currentAccount.value?.level))
const effectiveAccountLevel = computed(() => liveAccountLevel.value ?? currentAccountLevel.value)

const strategyCandidates = computed(() => {
  if (strategyLevel.value <= 0)
    return list.value
  return list.value.filter((item: any) => {
    if (item.level === null || item.level === undefined || item.level === '')
      return true
    const lv = Number(item.level)
    return Number.isFinite(lv) && lv <= strategyLevel.value
  })
})

const bestPlantsByStrategy = computed<Record<string, any | null>>(() => {
  const result: Record<string, any | null> = {}
  for (const strategy of strategies) {
    let best: any | null = null
    let bestMetric = Number.NEGATIVE_INFINITY
    for (const item of strategyCandidates.value) {
      const metricValue = Number(item?.[strategy.metric])
      if (!Number.isFinite(metricValue) || metricValue <= bestMetric)
        continue
      best = item
      bestMetric = metricValue
    }
    result[strategy.key] = best
  }
  return result
})

const strategySummaryText = computed(() => {
  if (strategyLevelMode.value === 'account') {
    return effectiveAccountLevel.value > 0
      ? `已按当前账号 Lv${effectiveAccountLevel.value} 推荐`
      : '当前账号等级未知，已显示全量推荐'
  }
  return strategyLevel.value > 0
    ? `当前查看 Lv${strategyLevel.value} 以内策略`
    : '未限制等级，已显示全量推荐'
})

const strategyInputValue = computed(() => (strategyLevel.value > 0 ? String(strategyLevel.value) : ''))

function syncStrategyLevelWithAccount(force = false) {
  if (!force && strategyLevelMode.value !== 'account')
    return
  strategyLevel.value = effectiveAccountLevel.value > 0 ? effectiveAccountLevel.value : 0
}

async function refreshAccountLevel() {
  if (!currentAccountId.value) {
    liveAccountLevel.value = null
    syncStrategyLevelWithAccount(true)
    return
  }

  liveAccountLevel.value = null
  syncStrategyLevelWithAccount(true)

  if (realtimeConnected.value)
    return

  try {
    await statusStore.fetchStatus(currentAccountId.value)
    liveAccountLevel.value = normalizeLevel(status.value?.status?.level) || null
  }
  catch (e) {
    console.error('获取分析所需账号等级失败:', e)
    liveAccountLevel.value = null
  }
  finally {
    syncStrategyLevelWithAccount(true)
  }
}

async function loadAnalytics() {
  if (!currentAccountId.value) {
    list.value = []
    return
  }
  loading.value = true
  try {
    const params: Record<string, string | number> = { sort: sortKey.value }
    const res = await api.get(`/api/analytics`, {
      params,
      headers: { 'x-account-id': currentAccountId.value },
    })
    const data = res.data.data
    if (Array.isArray(data)) {
      list.value = data
      // web sort as fallback
      const metricMap: Record<string, string> = {
        exp: 'expPerHour',
        fert: 'normalFertilizerExpPerHour',
        profit: 'profitPerHour',
        fert_profit: 'normalFertilizerProfitPerHour',
        level: 'level',
      }
      const metric = metricMap[sortKey.value]
      if (metric) {
        list.value.sort((a, b) => {
          const av = Number(a[metric])
          const bv = Number(b[metric])
          if (!Number.isFinite(av) && !Number.isFinite(bv))
            return 0
          if (!Number.isFinite(av))
            return 1
          if (!Number.isFinite(bv))
            return -1
          return bv - av
        })
      }
    }
    else {
      list.value = []
    }
  }
  catch (e) {
    console.error(e)
    list.value = []
  }
  finally {
    loading.value = false
  }
}

function buildAnalyticsViewState() {
  return normalizeAnalyticsViewState({
    sortKey: sortKey.value,
    strategyPanelCollapsed: strategyPanelCollapsed.value,
  }, DEFAULT_ANALYTICS_VIEW_STATE)
}

function applyAnalyticsViewState(state: Partial<typeof DEFAULT_ANALYTICS_VIEW_STATE> | null | undefined) {
  const normalized = normalizeAnalyticsViewState(state, DEFAULT_ANALYTICS_VIEW_STATE)
  analyticsViewHydrating = true
  sortKey.value = normalized.sortKey
  strategyPanelCollapsed.value = normalized.strategyPanelCollapsed
  analyticsViewHydrating = false
}

function clearAnalyticsViewSyncTimer() {
  if (analyticsViewSyncTimer) {
    clearTimeout(analyticsViewSyncTimer)
    analyticsViewSyncTimer = null
  }
}

function scheduleAnalyticsViewSync() {
  clearAnalyticsViewSyncTimer()
  const payload = buildAnalyticsViewState()
  analyticsViewSyncTimer = setTimeout(async () => {
    try {
      await saveViewPreferences({
        analyticsViewState: payload,
      })
    }
    catch (error) {
      console.warn('保存图鉴页视图偏好失败', error)
    }
  }, 240)
}

async function hydrateAnalyticsViewState() {
  const localFallback = buildAnalyticsViewState()
  try {
    const payload = await fetchViewPreferences()
    if (payload?.analyticsViewState) {
      applyAnalyticsViewState(payload.analyticsViewState)
      return
    }
    applyAnalyticsViewState(localFallback)
    if (JSON.stringify(localFallback) !== JSON.stringify(DEFAULT_ANALYTICS_VIEW_STATE)) {
      await saveViewPreferences({
        analyticsViewState: localFallback,
      })
    }
  }
  catch (error) {
    console.warn('读取图鉴页视图偏好失败', error)
    applyAnalyticsViewState(localFallback)
  }
}

onMounted(async () => {
  await hydrateAnalyticsViewState()
  refreshAccountLevel()
  loadAnalytics()
  analyticsViewSyncEnabled = true
})

watch(() => currentAccountId.value, () => {
  strategyLevelMode.value = 'account'
  liveAccountLevel.value = null
  refreshAccountLevel()
  loadAnalytics()
})

watch(() => currentAccountLevel.value, () => {
  syncStrategyLevelWithAccount()
})

watch(() => sortKey.value, () => {
  if (analyticsViewHydrating)
    return
  loadAnalytics()
})

watch(analyticsViewSignature, () => {
  if (!analyticsViewSyncEnabled || analyticsViewHydrating)
    return
  scheduleAnalyticsViewSync()
})

onBeforeUnmount(() => {
  clearAnalyticsViewSyncTimer()
})

function useAccountLevelRecommendation() {
  strategyLevelMode.value = 'account'
  syncStrategyLevelWithAccount(true)
}

function updateStrategyLevel(event: Event) {
  const target = event.target as HTMLInputElement
  strategyLevelMode.value = 'manual'
  strategyLevel.value = normalizeLevel(target.value)
}

function formatLv(level: any) {
  if (level === null || level === undefined || level === '' || Number(level) < 0)
    return '未知'
  return String(level)
}

function formatGrowTime(seconds: any) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s <= 0)
    return '0秒'
  if (s < 60)
    return `${s}秒`
  if (s < 3600) {
    const mins = Math.floor(s / 60)
    const secs = s % 60
    return secs > 0 ? `${mins}分${secs}秒` : `${mins}分`
  }
  const hours = Math.floor(s / 3600)
  const mins = Math.floor((s % 3600) / 60)
  return mins > 0 ? `${hours}时${mins}分` : `${hours}时`
}
</script>

<template>
  <div class="analytics-page ui-page-shell w-full">
    <div class="mb-4 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
      <h2 class="flex items-center gap-2 text-2xl font-bold">
        <div class="i-carbon-catalog" />
        作物图鉴
      </h2>

      <div class="flex items-center gap-2">
        <label class="whitespace-nowrap text-sm font-medium">排序方式:</label>
        <BaseSelect
          v-model="sortKey"
          :options="sortOptions"
          class="w-40"
        />
      </div>
    </div>

    <div class="mb-4 border border-sky-200/70 rounded-xl bg-sky-50/70 px-3 py-2 text-xs text-sky-700 leading-5 dark:border-sky-800/40 dark:bg-sky-900/15 dark:text-sky-200">
      {{ ANALYTICS_BROWSER_PREF_NOTE }}
    </div>

    <div v-if="loading" class="flex justify-center py-12">
      <div class="i-svg-spinners-90-ring-with-bg text-4xl text-blue-500" />
    </div>

    <div v-else-if="!currentAccountId" class="glass-panel glass-text-muted rounded-xl p-8 text-center shadow-md">
      请选择账号后查看数据分析
    </div>

    <!-- 策略推荐面板 (T3 - 参考 PR 版) -->
    <div v-if="!loading && currentAccountId && list.length > 0" class="glass-panel mb-4 overflow-hidden rounded-xl shadow-md">
      <div class="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div class="min-w-0 flex items-center gap-2">
          <div class="i-carbon-trophy text-lg text-yellow-500" />
          <div class="min-w-0">
            <div class="glass-text-main font-bold">
              策略推荐
            </div>
            <div class="glass-text-muted text-xs">
              {{ strategySummaryText }}
            </div>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2" @click.stop>
          <span class="border border-primary-500/20 rounded-full bg-primary-500/10 px-2.5 py-1 text-xs text-primary-600 font-semibold dark:text-primary-400">
            当前账号 {{ effectiveAccountLevel > 0 ? `Lv${effectiveAccountLevel}` : '等级未知' }}
          </span>
          <button
            type="button"
            class="border rounded-full px-3 py-1 text-xs font-medium transition"
            :class="strategyLevelMode === 'account'
              ? 'border-primary-500/25 bg-primary-500/12 text-primary-600 dark:text-primary-400'
              : 'border-white/15 bg-white/5 text-gray-600 hover:border-primary-500/25 hover:text-primary-600 dark:text-gray-300 dark:hover:text-primary-400'"
            @click="useAccountLevelRecommendation"
          >
            跟随当前等级
          </button>
          <div
            v-if="!strategyPanelCollapsed"
            class="flex items-center gap-2 border border-white/15 rounded-full bg-white/5 px-3 py-1.5 dark:bg-black/10"
          >
            <span class="glass-text-muted text-xs">查看等级≤</span>
            <input
              :value="strategyInputValue"
              type="number"
              min="0"
              placeholder="全部"
              class="w-14 bg-transparent text-center text-sm outline-none"
              @input="updateStrategyLevel"
              @click.stop
            >
          </div>
          <button
            type="button"
            class="glass-panel flex items-center gap-1 border border-white/15 rounded-full px-3 py-1.5 text-sm transition hover:border-primary-500/25"
            :aria-expanded="!strategyPanelCollapsed"
            @click="strategyPanelCollapsed = !strategyPanelCollapsed"
          >
            <span class="glass-text-muted text-xs">{{ strategyPanelCollapsed ? '展开推荐' : '收起推荐' }}</span>
            <div
              class="i-carbon-chevron-down glass-text-muted text-lg transition-transform"
              :class="{ 'rotate-180': !strategyPanelCollapsed }"
            />
          </button>
        </div>
      </div>

      <div v-show="!strategyPanelCollapsed" class="border-t border-white/10 p-4">
        <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div
            v-for="strategy in strategies"
            :key="strategy.key"
            class="glass-panel overflow-hidden border border-white/10 rounded-lg p-3 transition-shadow hover:shadow-md"
          >
            <!-- 策略标题 -->
            <div class="mb-2 flex items-center gap-2">
              <div :class="strategy.icon" class="text-base" :style="{ color: `var(--color-${strategy.color}-500, currentColor)` }" />
              <span class="glass-text-main text-sm font-semibold">{{ strategy.label }}</span>
            </div>

            <!-- 推荐作物 -->
            <div v-if="bestPlantsByStrategy[strategy.key]" class="space-y-2">
              <div class="flex items-center gap-2">
                <div class="h-8 w-8 flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-primary-500/10">
                  <img
                    v-if="bestPlantsByStrategy[strategy.key]?.image && !imageErrors[bestPlantsByStrategy[strategy.key]?.seedId]"
                    :src="bestPlantsByStrategy[strategy.key]?.image"
                    class="h-6 w-6 object-contain"
                    loading="lazy"
                    @error="imageErrors[bestPlantsByStrategy[strategy.key]?.seedId] = true"
                  >
                  <div v-else class="i-carbon-sprout text-lg text-primary-500/50" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="glass-text-main truncate text-sm font-bold">
                    {{ bestPlantsByStrategy[strategy.key]?.name }}
                  </div>
                  <div class="glass-text-muted text-[10px]">
                    Lv{{ formatLv(bestPlantsByStrategy[strategy.key]?.level) }}
                  </div>
                </div>
              </div>
              <!-- 效率值 -->
              <div class="glass-panel rounded-md px-2 py-1.5">
                <div class="flex items-baseline justify-between">
                  <span class="glass-text-muted text-xs">{{ strategy.unit }}/时</span>
                  <span class="text-base font-bold" :style="{ color: `var(--color-${strategy.color}-500, currentColor)` }">
                    {{ bestPlantsByStrategy[strategy.key]?.[strategy.metric] }}
                  </span>
                </div>
              </div>
            </div>
            <div v-else class="glass-text-muted py-3 text-center text-xs">
              暂无可种植作物
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="!loading && currentAccountId && list.length === 0" class="glass-panel glass-text-muted rounded-xl p-8 text-center shadow-md">
      暂无数据
    </div>

    <div v-if="!loading && currentAccountId && list.length > 0">
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-3 sm:grid-cols-2 xl:grid-cols-4">
        <div
          v-for="(item, idx) in list"
          :key="idx"
          class="glass-panel group flex flex-col overflow-hidden rounded-xl shadow transition-all hover:shadow-lg hover:-translate-y-1 dark:hover:bg-white/5"
        >
          <!-- 卡片内容主体: 允许点击放大或高亮交互 -->
          <div class="flex flex-1 flex-col cursor-pointer gap-4 bg-transparent p-4 transition">
            <!-- 头部：图鉴图标 + 名称 + 核心状态 -->
            <div class="flex flex-row items-center gap-3">
              <!-- 作物图片 -->
              <div class="relative h-12 w-12 flex shrink-0 items-center justify-center overflow-hidden border border-white/20 rounded-lg bg-primary-500/10 transition-colors dark:border-white/10 dark:bg-black/20 group-hover:bg-primary-500/20">
                <img
                  v-if="item.image && !imageErrors[item.seedId]"
                  :src="item.image"
                  class="h-10 w-10 object-contain drop-shadow-sm transition-transform group-hover:scale-110"
                  loading="lazy"
                  @error="imageErrors[item.seedId] = true"
                >
                <div v-else class="i-carbon-sprout text-2xl text-primary-500/50" />
              </div>

              <!-- 文本信息 -->
              <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between">
                  <div class="glass-text-main truncate text-base font-bold transition-colors group-hover:text-primary-500">
                    {{ item.name }}
                  </div>
                  <div class="glass-text-muted text-[10px] font-mono">
                    ID:{{ item.seedId }}
                  </div>
                </div>
                <div class="mt-1 flex flex-wrap items-center gap-2">
                  <span class="border border-primary-500/20 rounded bg-primary-500/10 px-1.5 py-0.5 text-[10px] text-primary-600 font-semibold dark:text-primary-400">Lv {{ formatLv(item.level) }}</span>
                  <span class="border border-yellow-500/20 rounded bg-yellow-500/10 px-1.5 py-0.5 text-[10px] text-yellow-600 font-semibold dark:text-yellow-400">{{ item.seasons }}季</span>
                  <span class="glass-text-muted ml-auto flex items-center gap-0.5 text-[10px]">
                    <div class="i-carbon-time" />
                    {{ formatGrowTime(item.growTime) }}
                  </span>
                </div>
              </div>
            </div>

            <!-- 数据列 (2x2 网格) -->
            <div class="grid grid-cols-2 mt-auto gap-3 border-t border-gray-200/50 pt-2 text-sm dark:border-white/10">
              <div class="flex flex-col">
                <span class="glass-text-muted mb-0.5 text-[10px] uppercase opacity-80">经验/小时</span>
                <span class="text-purple-600 font-bold leading-none dark:text-purple-400">{{ item.expPerHour }}</span>
              </div>
              <div class="flex flex-col text-right">
                <span class="glass-text-muted mb-0.5 text-[10px] uppercase opacity-80">净利润/小时</span>
                <span class="text-amber-500 font-bold leading-none dark:text-amber-400">{{ item.profitPerHour ?? '-' }}</span>
              </div>
              <div class="flex flex-col">
                <span class="glass-text-muted mb-0.5 text-[10px] uppercase opacity-80">普肥经验/小时</span>
                <span class="text-blue-600 font-bold leading-none dark:text-blue-400">{{ item.normalFertilizerExpPerHour ?? '-' }}</span>
              </div>
              <div class="flex flex-col text-right">
                <span class="glass-text-muted mb-0.5 text-[10px] uppercase opacity-80">普肥净利润/小时</span>
                <span class="text-primary-600 font-bold leading-none dark:text-primary-400">{{ item.normalFertilizerProfitPerHour ?? '-' }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
