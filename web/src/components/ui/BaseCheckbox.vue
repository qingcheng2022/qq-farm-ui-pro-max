<script setup lang="ts">
import { computed, useAttrs } from 'vue'

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<{
  modelValue?: boolean | Array<string | number>
  value?: string | number | boolean
  checked?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean | Array<string | number>]
  'change': [event: Event]
}>()

const attrs = useAttrs()

const isChecked = computed(() => {
  if (Array.isArray(props.modelValue))
    return props.modelValue.includes(props.value as string | number)
  if (typeof props.modelValue === 'boolean')
    return props.modelValue
  return props.checked ?? false
})

const inputAttrs = computed<Record<string, any>>(() => ({
  ...attrs,
  class: ['ui-check', attrs.class],
}))

function handleChange(event: Event) {
  const target = event.target as HTMLInputElement

  if (Array.isArray(props.modelValue)) {
    const nextValues = [...props.modelValue]
    const value = props.value as string | number
    const currentIndex = nextValues.findIndex(item => item === value)

    if (target.checked && currentIndex === -1)
      nextValues.push(value)
    else if (!target.checked && currentIndex !== -1)
      nextValues.splice(currentIndex, 1)

    emit('update:modelValue', nextValues)
  }
  else {
    emit('update:modelValue', target.checked)
  }

  emit('change', event)
}
</script>

<template>
  <input
    :checked="isChecked"
    :value="value"
    type="checkbox"
    v-bind="inputAttrs"
    @change="handleChange"
  >
</template>
