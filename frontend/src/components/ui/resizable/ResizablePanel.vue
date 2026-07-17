<script setup lang="ts">
import type { SplitterPanelEmits, SplitterPanelProps } from "reka-ui"
import { ref } from "vue"
import { SplitterPanel, useForwardPropsEmits } from "reka-ui"

const props = defineProps<SplitterPanelProps>()
const emits = defineEmits<SplitterPanelEmits>()

const forwarded = useForwardPropsEmits(props, emits)

// Capture the underlying SplitterPanel so we can expose its imperative API
// (collapse / expand) to a parent template ref. shadcn-vue's default wrapper
// forgets to bind the forwarded ref, which makes programmatic collapse fail.
const panel = ref<InstanceType<typeof SplitterPanel>>()
defineExpose({
  collapse: () => panel.value?.collapse(),
  expand: () => panel.value?.expand(),
  resize: (size: number) => panel.value?.resize(size),
  get isCollapsed() {
    return panel.value?.isCollapsed
  },
})
</script>

<template>
  <SplitterPanel
    ref="panel"
    v-slot="slotProps"
    data-slot="resizable-panel"
    v-bind="forwarded"
  >
    <slot v-bind="slotProps" />
  </SplitterPanel>
</template>
