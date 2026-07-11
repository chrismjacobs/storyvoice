// Auto-play viewer: load page -> play audio (skip if silent) -> hold for dwell -> advance
const { createApp, ref, computed, onMounted, onBeforeUnmount, watch, nextTick } = Vue;

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

      <div class="thumb-strip" ref="thumbStripEl">
        <button
          v-for="(p, idx) in pages"
          :key="p.page_number"
          type="button"
          class="thumb-item"
          :class="[p.status, { active: idx === currentIndex }]"
          @click="jumpToPage(idx)"
        >
          <img :src="p.image_url" :alt="'Page ' + p.page_number" loading="lazy">
          <span class="thumb-status" :class="p.status"></span>
          <span class="thumb-page-number">{{ p.page_number }}</span>
        </button>
      </div>
    </div>
  `,
  setup(props) {
    const pages = ref([]);
    const title = ref("");
    const currentIndex = ref(0);
    const isPlaying = ref(false);
    const progress = ref(0);
    const thumbStripEl = ref(null);

    // iOS Safari only allows programmatic .play() on a <audio> element that has
    // already played once inside a direct user gesture. Creating a fresh Audio()
    // per page (as auto-advance does, from a timer/onended callback with no
    // gesture in the call stack) gets silently blocked after the first page. A
    // single element, reused for every page, stays "unlocked" for the session.
    let sharedAudio = null;
    let progressFrame = null;
    let dwellTimeout = null;
    let phaseElapsedBeforeMs = 0; // ms already accounted for from prior phase(s) of this page
    let totalDurationMs = 0;

    const currentPage = computed(() => pages.value[currentIndex.value] || null);

    function getSharedAudio() {
      if (!sharedAudio) sharedAudio = new Audio();
      return sharedAudio;
    }

    async function loadData() {
      const res = await fetch(`/narrations/${props.narrationId}/listen/data`);
      const data = await res.json();
      pages.value = data.pages;
      title.value = data.title;
    }

    function clearTimers() {
      if (progressFrame) cancelAnimationFrame(progressFrame);
      if (dwellTimeout) clearTimeout(dwellTimeout);
      progressFrame = null;
      dwellTimeout = null;
    }

    function stopAudio() {
      if (sharedAudio) {
        sharedAudio.pause();
        sharedAudio.onended = null;
      }
    }

    function haltPlayback() {
      clearTimers();
      stopAudio();
    }

    // Animates progress.value continuously across the whole page (speech +
    // dwell) rather than resetting to 0 when dwell begins. phaseDurationMs is
    // this phase's own length; phaseElapsedBeforeMs carries over time already
    // spent in an earlier phase of the same page.
    function tickProgress(phaseDurationMs) {
      const phaseStart = performance.now();
      function step(now) {
        const phaseElapsed = Math.min(now - phaseStart, phaseDurationMs);
        const totalElapsed = phaseElapsedBeforeMs + phaseElapsed;
        progress.value = totalDurationMs > 0 ? Math.min(totalElapsed / totalDurationMs, 1) : 1;
        if (phaseElapsed < phaseDurationMs) {
          progressFrame = requestAnimationFrame(step);
        }
      }
      progressFrame = requestAnimationFrame(step);
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

    function jumpToPage(idx) {
      haltPlayback();
      progress.value = 0;
      currentIndex.value = idx;
      if (isPlaying.value) runPage();
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
      phaseElapsedBeforeMs = 0;

      const page = currentPage.value;
      if (!page) return;

      const hasAudio = page.status === "recorded" && Boolean(page.audio_url);
      const audioMs = hasAudio ? Math.max(page.duration_ms || 0, 0) : 0;
      const dwellMs = Math.max(page.dwell_seconds, 0) * 1000;
      totalDurationMs = audioMs + dwellMs;

      if (hasAudio) {
        const audio = getSharedAudio();
        audio.src = page.audio_url;
        audio.onended = () => {
          if (progressFrame) cancelAnimationFrame(progressFrame);
          phaseElapsedBeforeMs = audioMs;
          runDwell(dwellMs);
        };
        audio.play().catch(() => {
          // Playback can still be blocked in some browsers/states outside a
          // gesture; skip straight to dwell so auto-advance keeps moving
          // rather than getting stuck silently.
          if (progressFrame) cancelAnimationFrame(progressFrame);
          phaseElapsedBeforeMs = audioMs;
          runDwell(dwellMs);
        });
        tickProgress(audioMs || 1);
      } else {
        runDwell(dwellMs);
      }
    }

    function runDwell(dwellMs) {
      if (dwellMs === 0) {
        progress.value = 1;
        advance();
        return;
      }

      tickProgress(dwellMs);
      dwellTimeout = setTimeout(() => {
        progress.value = 1;
        advance();
      }, dwellMs);
    }

    function scrollActiveThumbIntoView() {
      nextTick(() => {
        const active = thumbStripEl.value && thumbStripEl.value.querySelector(".thumb-item.active");
        if (active) active.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
      });
    }

    watch(currentIndex, scrollActiveThumbIntoView);

    onMounted(loadData);
    onBeforeUnmount(haltPlayback);

    return {
      pages,
      title,
      currentIndex,
      currentPage,
      isPlaying,
      progress,
      togglePlay,
      goBack,
      skip,
      jumpToPage,
      thumbStripEl,
    };
  },
};

createApp({}).component("listen-viewer", ListenViewer).mount("#viewer-app");
