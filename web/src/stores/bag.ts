import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'

export const useBagStore = defineStore('bag', () => {
  const allItems = ref<any[]>([])
  const loading = ref(false)
  const mallGoods = ref<any[]>([])
  const mallLoading = ref(false)
  const sellPreview = ref<any | null>(null)
  const sellPreviewLoading = ref(false)
  const actionLoading = ref(false)

  const items = computed(() => {
    // Filter out hidden items (e.g. coins, coupons, exp which are shown in dashboard)
    const hiddenIds = new Set([1, 1001, 1002, 1101, 1011, 1012, 3001, 3002])
    return allItems.value.filter((it: any) => !hiddenIds.has(Number(it.id || 0)))
  })

  const dashboardItems = computed(() => {
    const targetIds = new Set([1011, 1012, 3001, 3002])
    return allItems.value.filter((it: any) => targetIds.has(Number(it.id || 0)))
  })

  async function fetchBag(accountId: string) {
    if (!accountId)
      return
    loading.value = true
    try {
      const res = await api.get('/api/bag', {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok && res.data.data) {
        allItems.value = Array.isArray(res.data.data.items) ? res.data.data.items : []
      }
    }
    catch (e) {
      console.error(e)
    }
    finally {
      loading.value = false
    }
  }

  async function fetchMallGoods(accountId: string, slotType = 1) {
    if (!accountId)
      return
    mallLoading.value = true
    try {
      const res = await api.get('/api/mall/goods', {
        headers: { 'x-account-id': accountId },
        params: { slotType },
      })
      if (res.data.ok) {
        mallGoods.value = Array.isArray(res.data.data) ? res.data.data : []
      }
    }
    catch (e) {
      console.error(e)
    }
    finally {
      mallLoading.value = false
    }
  }

  async function fetchSellPreview(accountId: string) {
    if (!accountId)
      return null
    sellPreviewLoading.value = true
    try {
      const res = await api.get('/api/bag/sell-preview', {
        headers: { 'x-account-id': accountId },
      })
      if (res.data.ok) {
        sellPreview.value = res.data.data || null
        return sellPreview.value
      }
      return null
    }
    catch (e) {
      console.error(e)
      return null
    }
    finally {
      sellPreviewLoading.value = false
    }
  }

  async function buyMallGoods(accountId: string, goodsId: number, count = 1) {
    if (!accountId || !goodsId)
      return null
    actionLoading.value = true
    try {
      const res = await api.post('/api/mall/purchase', { goodsId, count }, {
        headers: { 'x-account-id': accountId },
      })
      await Promise.all([
        fetchBag(accountId),
        fetchMallGoods(accountId),
      ])
      return res.data?.data || null
    }
    finally {
      actionLoading.value = false
    }
  }

  async function sellByPolicy(accountId: string) {
    if (!accountId)
      return null
    actionLoading.value = true
    try {
      const res = await api.post('/api/bag/sell', {}, {
        headers: { 'x-account-id': accountId },
      })
      await Promise.all([
        fetchBag(accountId),
        fetchSellPreview(accountId),
      ])
      return res.data?.data || null
    }
    finally {
      actionLoading.value = false
    }
  }

  async function sellSelected(accountId: string, itemIds: number[], respectPolicy = true) {
    if (!accountId || !itemIds.length)
      return null
    actionLoading.value = true
    try {
      const res = await api.post('/api/bag/sell-selected', { itemIds, respectPolicy }, {
        headers: { 'x-account-id': accountId },
      })
      await Promise.all([
        fetchBag(accountId),
        fetchSellPreview(accountId),
      ])
      return res.data?.data || null
    }
    finally {
      actionLoading.value = false
    }
  }

  return {
    items,
    allItems,
    dashboardItems,
    mallGoods,
    sellPreview,
    loading,
    mallLoading,
    sellPreviewLoading,
    actionLoading,
    fetchBag,
    fetchMallGoods,
    fetchSellPreview,
    buyMallGoods,
    sellByPolicy,
    sellSelected,
  }
})
