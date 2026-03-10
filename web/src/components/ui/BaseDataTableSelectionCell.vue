<script setup lang="ts">
import BaseCheckbox from '@/components/ui/BaseCheckbox.vue'

type SelectionValue = Array<string | number>

const props = withDefaults(defineProps<{
  modelValue?: SelectionValue
  value?: string | number
  cellClass?: string
}>(), {
  modelValue: () => [],
  value: '',
  cellClass: 'px-4 py-4 align-top',
})

const emit = defineEmits<{
  'update:modelValue': [value: SelectionValue]
}>()

function handleUpdate(value: boolean | SelectionValue) {
  if (Array.isArray(value))
    emit('update:modelValue', value)
}
</script>

<template>
  <td class="ui-data-table-selection-cell" :class="cellClass">
    <BaseCheckbox
      :model-value="props.modelValue"
      :value="value"
      @update:model-value="handleUpdate"
    />
  </td>
</template>
