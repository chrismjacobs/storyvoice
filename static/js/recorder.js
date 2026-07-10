// Record panel: idle -> hearing_model -> countdown -> recording -> reviewing -> (keep|redo|silent) -> advance
const { createApp, ref, computed, onMounted, onBeforeUnmount, watch } = Vue;

const RecorderPanel = {
  props: {
    narrationId: { type: Number, required: true },
    pageCount: { type: Number, required: true },
    bookTitle: { type: String, required: true },
  },
  template: `
    <div class="stage">
      <h1>{{ bookTitle }}</h1>

      <label v-if="modelCandidates.length">
        Model narration
        <select v-model="modelId">
          <option :value="null">None</option>
          <option v-for="m in modelCandidates" :key="m.id" :value="m.id">{{ m.label }}</option>
        </select>
      </label>

      <p class="stage-status">Page {{ currentPageNumber }} of {{ pageCount }} — {{ currentPage ? currentPage.status : '…' }}</p>

      <img v-if="currentPage" class="stage-image" :src="currentPage.image_url" :alt="'Page ' + currentPageNumber">

      <div v-if="phase === 'countdown'" class="countdown">{{ countdownValue }}</div>
      <p v-if="phase === 'hearing_model'" class="stage-status">Playing model…</p>
      <p v-if="phase === 'recording'" class="stage-status">Recording…</p>
      <p v-if="phase === 'reviewing'" class="stage-status">Review your take</p>
      <p v-if="errorMessage" class="stage-status flash-error">{{ errorMessage }}</p>

      <div class="stage-controls">
        <button
          v-if="phase === 'idle'"
          :disabled="!hasModelClip"
          @click="hearModel"
        >Hear model</button>

        <button v-if="phase === 'idle'" @click="startRecordFlow">Record</button>
        <button v-if="phase === 'recording'" @click="stopRecordingNow">Stop</button>

        <button v-if="phase === 'reviewing'" @click="playTake">Play back</button>
        <button v-if="phase === 'reviewing'" @click="keepTake" :disabled="saving">Keep</button>
        <button v-if="phase === 'reviewing'" @click="redoTake">Redo</button>

        <button v-if="phase === 'idle'" @click="markSilent" :disabled="saving">Mark silent</button>
      </div>

      <label v-if="currentPage" class="dwell-input">
        Dwell seconds
        <input type="number" min="0" step="0.5" v-model.number="dwellDraft" @change="saveDwell">
      </label>

      <div class="page-nav">
        <button :disabled="currentPageNumber <= 1" @click="goToPage(currentPageNumber - 1)">Previous</button>
        <button :disabled="currentPageNumber >= pageCount" @click="goToPage(currentPageNumber + 1)">Next</button>
      </div>
    </div>
  `,
  setup(props) {
    const pages = ref([]);
    const modelPages = ref({});
    const modelCandidates = ref(window.MODEL_CANDIDATES || []);
    const modelId = ref(modelCandidates.value.length ? modelCandidates.value[0].id : null);

    const currentPageNumber = ref(1);
    const phase = ref("idle"); // idle | hearing_model | countdown | recording | reviewing
    const countdownValue = ref(2);
    const saving = ref(false);
    const errorMessage = ref("");
    const dwellDraft = ref(1);

    let modelAudio = null;
    let mediaStream = null;
    let mediaRecorder = null;
    let recordedChunks = [];
    let takeBlob = null;
    let reviewAudio = null;
    let countdownTimer = null;

    const currentPage = computed(() => pages.value.find((p) => p.page_number === currentPageNumber.value));
    const hasModelClip = computed(() => Boolean(modelPages.value[currentPageNumber.value]));

    async function loadData() {
      const url = new URL(`/narrations/${props.narrationId}/record/data`, window.location.origin);
      if (modelId.value) url.searchParams.set("model_id", modelId.value);
      const res = await fetch(url);
      const data = await res.json();
      pages.value = data.pages;
      modelPages.value = data.model_pages;
      if (currentPage.value) dwellDraft.value = currentPage.value.dwell_seconds;
    }

    watch(modelId, loadData);
    watch(currentPageNumber, () => {
      if (currentPage.value) dwellDraft.value = currentPage.value.dwell_seconds;
    });

    function goToPage(n) {
      resetToIdle();
      currentPageNumber.value = n;
    }

    function resetToIdle() {
      stopModelAudio();
      stopRecordingTrack();
      phase.value = "idle";
      countdownValue.value = 2;
      takeBlob = null;
      errorMessage.value = "";
    }

    function stopModelAudio() {
      if (modelAudio) {
        modelAudio.pause();
        modelAudio.currentTime = 0;
        modelAudio = null;
      }
    }

    function stopRecordingTrack() {
      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
      }
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
    }

    function hearModel() {
      const url = modelPages.value[currentPageNumber.value];
      if (!url) return;
      phase.value = "hearing_model";
      modelAudio = new Audio(url);
      modelAudio.onended = () => {
        modelAudio = null;
        phase.value = "idle";
      };
      modelAudio.play();
    }

    async function startRecordFlow() {
      errorMessage.value = "";
      // Hard sequencing rule: model playback must fully stop before the mic goes hot.
      stopModelAudio();

      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        errorMessage.value = "Microphone permission is required to record.";
        return;
      }

      // Never start the countdown before the permission promise resolves.
      runCountdown();
    }

    function runCountdown() {
      phase.value = "countdown";
      countdownValue.value = 2;
      countdownTimer = setInterval(() => {
        countdownValue.value -= 1;
        if (countdownValue.value <= 0) {
          clearInterval(countdownTimer);
          countdownTimer = null;
          beginRecording();
        }
      }, 1000);
    }

    function beginRecording() {
      phase.value = "recording";
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(mediaStream);
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };
      mediaRecorder.onstop = () => {
        takeBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/webm" });
        stopRecordingTrack();
        phase.value = "reviewing";
      };
      mediaRecorder.start();
    }

    function stopRecordingNow() {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    }

    function playTake() {
      if (!takeBlob) return;
      if (reviewAudio) reviewAudio.pause();
      reviewAudio = new Audio(URL.createObjectURL(takeBlob));
      reviewAudio.play();
    }

    async function keepTake() {
      if (!takeBlob) return;
      saving.value = true;
      errorMessage.value = "";
      try {
        const formData = new FormData();
        formData.append("audio", takeBlob, "take.webm");
        const res = await fetch(`/narrations/${props.narrationId}/pages/${currentPageNumber.value}/clip`, {
          method: "POST",
          body: formData,
        });
        if (!res.ok) throw new Error("Upload failed");
        const data = await res.json();
        applyPageUpdate({ status: data.status, duration_ms: data.duration_ms, audio_url: data.audio_url });
        advanceAfterKeep();
      } catch (err) {
        errorMessage.value = "Could not save that take — try again.";
      } finally {
        saving.value = false;
      }
    }

    function redoTake() {
      takeBlob = null;
      phase.value = "idle";
    }

    async function markSilent() {
      saving.value = true;
      try {
        const res = await fetch(`/narrations/${props.narrationId}/pages/${currentPageNumber.value}/silent`, {
          method: "POST",
        });
        const data = await res.json();
        applyPageUpdate({ status: data.status, dwell_seconds: data.dwell_seconds, audio_url: null, duration_ms: null });
        dwellDraft.value = data.dwell_seconds;
        advanceAfterKeep();
      } finally {
        saving.value = false;
      }
    }

    function applyPageUpdate(patch) {
      const page = pages.value.find((p) => p.page_number === currentPageNumber.value);
      if (page) Object.assign(page, patch);
    }

    function advanceAfterKeep() {
      resetToIdle();
      if (currentPageNumber.value < props.pageCount) {
        currentPageNumber.value += 1;
      }
    }

    async function saveDwell() {
      if (!currentPage.value) return;
      await fetch(`/narrations/${props.narrationId}/pages/${currentPageNumber.value}/dwell`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dwell_seconds: dwellDraft.value }),
      });
      applyPageUpdate({ dwell_seconds: dwellDraft.value });
    }

    onMounted(loadData);
    onBeforeUnmount(() => {
      stopModelAudio();
      stopRecordingTrack();
    });

    return {
      pages,
      modelCandidates,
      modelId,
      currentPageNumber,
      currentPage,
      phase,
      countdownValue,
      saving,
      errorMessage,
      dwellDraft,
      hasModelClip,
      hearModel,
      startRecordFlow,
      playTake,
      keepTake,
      redoTake,
      markSilent,
      saveDwell,
      goToPage,
      stopRecordingNow,
      pageCount: props.pageCount,
    };
  },
};

createApp({}).component("recorder-panel", RecorderPanel).mount("#recorder-app");
