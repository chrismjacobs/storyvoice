// Auto-play viewer: load page -> play audio (skip if silent) -> hold for dwell -> advance
const { createApp, ref, computed, onMounted, onBeforeUnmount } = Vue;

const ListenViewer = {
  props: {
    narrationId: { type: Number, required: true },
    bookTitle: { type: String, required: true },
  },
  template: `
    <div class="stage">
      <h1>{{ bookTitle }}</h1>
      <p class="stage-status">{{ title }} — Page {{ currentIndex + 1 }} of {{ pages.length }}</p>

      <img v-if="currentPage" class="stage-image" :src="currentPage.image_url" :alt="'Page ' + (currentIndex + 1)">

      <div class="progress-track">
        <div class="progress-fill" :style="{ width: (progress * 100) + '%' }"></div>
      </div>

      <div class="stage-controls">
        <button @click="goBack" :disabled="currentIndex === 0">Back</button>
        <button @click="togglePlay">{{ isPlaying ? 'Pause' : 'Play' }}</button>
        <button @click="skip" :disabled="currentIndex >= pages.length - 1">Skip</button>
      </div>
    </div>
  `,
  setup(props) {
    const pages = ref([]);
    const title = ref("");
    const currentIndex = ref(0);
    const isPlaying = ref(false);
    const progress = ref(0);

    let audioEl = null;
    let dwellStart = null;
    let dwellDurationMs = 0;
    let dwellFrame = null;
    let dwellTimeout = null;

    const currentPage = computed(() => pages.value[currentIndex.value] || null);

    async function loadData() {
      const res = await fetch(`/narrations/${props.narrationId}/listen/data`);
      const data = await res.json();
      pages.value = data.pages;
      title.value = data.title;
    }

    function clearTimers() {
      if (dwellFrame) cancelAnimationFrame(dwellFrame);
      if (dwellTimeout) clearTimeout(dwellTimeout);
      dwellFrame = null;
      dwellTimeout = null;
    }

    function stopAudio() {
      if (audioEl) {
        audioEl.pause();
        audioEl.onended = null;
        audioEl = null;
      }
    }

    function haltPlayback() {
      clearTimers();
      stopAudio();
    }

    function togglePlay() {
      if (isPlaying.value) {
        isPlaying.value = false;
        haltPlayback();
      } else {
        isPlaying.value = true;
        runPage();
      }
    }

    function goBack() {
      haltPlayback();
      progress.value = 0;
      if (currentIndex.value > 0) currentIndex.value -= 1;
      if (isPlaying.value) runPage();
    }

    function skip() {
      haltPlayback();
      progress.value = 0;
      advance();
    }

    function advance() {
      if (currentIndex.value < pages.value.length - 1) {
        currentIndex.value += 1;
        if (isPlaying.value) runPage();
      } else {
        isPlaying.value = false;
      }
    }

    function runPage() {
      haltPlayback();
      progress.value = 0;
      const page = currentPage.value;
      if (!page) return;

      if (page.status === "recorded" && page.audio_url) {
        audioEl = new Audio(page.audio_url);
        audioEl.onended = () => runDwell(page);
        audioEl.play();
      } else {
        runDwell(page);
      }
    }

    function runDwell(page) {
      dwellDurationMs = Math.max(page.dwell_seconds, 0) * 1000;
      dwellStart = performance.now();

      if (dwellDurationMs === 0) {
        progress.value = 1;
        advance();
        return;
      }

      function step(now) {
        const elapsed = now - dwellStart;
        progress.value = Math.min(elapsed / dwellDurationMs, 1);
        if (elapsed < dwellDurationMs) {
          dwellFrame = requestAnimationFrame(step);
        }
      }
      dwellFrame = requestAnimationFrame(step);
      dwellTimeout = setTimeout(() => {
        progress.value = 1;
        advance();
      }, dwellDurationMs);
    }

    onMounted(loadData);
    onBeforeUnmount(haltPlayback);

    return { pages, title, currentIndex, currentPage, isPlaying, progress, togglePlay, goBack, skip };
  },
};

createApp({}).component("listen-viewer", ListenViewer).mount("#viewer-app");
