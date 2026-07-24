// Immersive fullscreen overlay shared by the picture viewer and the listen
// viewer: fills the screen with the current page image and drives its own
// pinch-zoom/pan via Pointer Events instead of native browser pinch-zoom.
// Native pinch-zoom has no way to know a page turn happened, so Safari drags
// the zoomed viewport sideways when the underlying <img> swaps. Owning the
// transform ourselves means every page turn can cleanly reset to fit-screen.
(function () {
  const MAX_SCALE = 4;
  const DOUBLE_TAP_SCALE = 2.5;
  const DOUBLE_TAP_MS = 300;
  const TAP_MOVE_TOLERANCE = 10;
  const SWIPE_THRESHOLD = 50;

  let overlay, imgWrap, imgEl, closeBtn, prevBtn, nextBtn, bottomBar, playBtn, progressTrack, progressFill;

  let scale = 1;
  let tx = 0;
  let ty = 0;
  const pointers = new Map();
  let panStart = null;
  let pinchLastDist = 0;
  let pinchLastMid = null;
  let pinchCenter = null;
  let hadMultiTouch = false;
  let lastTapTime = 0;
  let lastTapPos = null;

  let currentOpts = null;

  function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function applyTransform() {
    imgEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  function clampTranslate() {
    const maxX = Math.max((imgEl.offsetWidth * scale - imgEl.offsetWidth) / 2, 0);
    const maxY = Math.max((imgEl.offsetHeight * scale - imgEl.offsetHeight) / 2, 0);
    tx = clamp(tx, -maxX, maxX);
    ty = clamp(ty, -maxY, maxY);
  }

  function resetZoom(animated) {
    scale = 1;
    tx = 0;
    ty = 0;
    if (animated) {
      imgEl.style.transition = "transform 0.18s ease";
      setTimeout(() => { imgEl.style.transition = ""; }, 180);
    }
    applyTransform();
  }

  function wrapCenter() {
    const rect = imgWrap.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function toggleDoubleTapZoom(pos) {
    const center = wrapCenter();
    if (scale > 1) {
      resetZoom(true);
      return;
    }
    scale = DOUBLE_TAP_SCALE;
    tx = scale * (center.x - pos.x);
    ty = scale * (center.y - pos.y);
    clampTranslate();
    imgEl.style.transition = "transform 0.2s ease";
    applyTransform();
    setTimeout(() => { imgEl.style.transition = ""; }, 200);
  }

  function onPointerDown(e) {
    imgEl.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, downX: e.clientX, downY: e.clientY });

    if (pointers.size === 1) {
      panStart = { x: e.clientX, y: e.clientY, tx, ty };
    } else if (pointers.size === 2) {
      hadMultiTouch = true;
      const [a, b] = [...pointers.values()];
      pinchLastDist = distance(a, b);
      pinchLastMid = midpoint(a, b);
      pinchCenter = wrapCenter();
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const p = pointers.get(e.pointerId);
    p.x = e.clientX;
    p.y = e.clientY;

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const newDist = distance(a, b);
      const newMid = midpoint(a, b);
      const factor = newDist / (pinchLastDist || newDist);
      const newScale = clamp(scale * factor, 1, MAX_SCALE);
      const actualFactor = scale > 0 ? newScale / scale : 1;

      tx = (newMid.x - pinchCenter.x) - actualFactor * (pinchLastMid.x - pinchCenter.x) + actualFactor * tx;
      ty = (newMid.y - pinchCenter.y) - actualFactor * (pinchLastMid.y - pinchCenter.y) + actualFactor * ty;
      scale = newScale;

      pinchLastDist = newDist;
      pinchLastMid = newMid;
      clampTranslate();
      applyTransform();
    } else if (pointers.size === 1 && scale > 1 && panStart) {
      tx = panStart.tx + (e.clientX - panStart.x);
      ty = panStart.ty + (e.clientY - panStart.y);
      clampTranslate();
      applyTransform();
    }
  }

  function onPointerUp(e) {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);

    if (pointers.size === 1) {
      const [remaining] = [...pointers.values()];
      panStart = { x: remaining.x, y: remaining.y, tx, ty };
    } else if (pointers.size === 0) {
      panStart = null;
      // Only fit-to-screen was allowed to pan (see onPointerMove), so a swipe
      // is only recognized when we weren't zoomed in -- otherwise a drag pans
      // the image instead of turning the page, which is what a photo-viewer
      // user expects.
      const wasZoomed = scale > 1.02;
      if (!wasZoomed) {
        resetZoom(true);
      } else {
        clampTranslate();
        applyTransform();
      }

      const dx = p ? p.x - p.downX : 0;
      const dy = p ? p.y - p.downY : 0;
      const moved = Math.hypot(dx, dy);

      if (!hadMultiTouch && p && !wasZoomed && Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) currentOpts && currentOpts.onNext && currentOpts.onNext();
        else currentOpts && currentOpts.onPrev && currentOpts.onPrev();
        lastTapTime = 0;
        lastTapPos = null;
      } else if (!hadMultiTouch && p && moved < TAP_MOVE_TOLERANCE) {
        const now = Date.now();
        const tapPos = { x: p.x, y: p.y };
        const withinTime = now - lastTapTime < DOUBLE_TAP_MS;
        const withinSpace = lastTapPos && Math.hypot(tapPos.x - lastTapPos.x, tapPos.y - lastTapPos.y) < 40;
        if (withinTime && withinSpace) {
          toggleDoubleTapZoom(tapPos);
          lastTapTime = 0;
          lastTapPos = null;
        } else {
          lastTapTime = now;
          lastTapPos = tapPos;
        }
      }
      hadMultiTouch = false;
    }
  }

  function onKeydown(e) {
    if (e.key === "Escape") close();
  }

  function onBackdropClick(e) {
    if (e.target === overlay || e.target === imgWrap) close();
  }

  function build() {
    overlay = document.createElement("div");
    overlay.className = "immersive-overlay";
    overlay.hidden = true;

    closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "immersive-btn immersive-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "✕";

    prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "immersive-btn immersive-nav immersive-prev";
    prevBtn.setAttribute("aria-label", "Previous page");
    prevBtn.textContent = "‹";

    nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "immersive-btn immersive-nav immersive-next";
    nextBtn.setAttribute("aria-label", "Next page");
    nextBtn.textContent = "›";

    imgWrap = document.createElement("div");
    imgWrap.className = "immersive-image-wrap";

    imgEl = document.createElement("img");
    imgEl.className = "immersive-image";
    imgWrap.appendChild(imgEl);

    bottomBar = document.createElement("div");
    bottomBar.className = "immersive-bottom-bar";
    bottomBar.hidden = true;

    progressTrack = document.createElement("div");
    progressTrack.className = "progress-track immersive-progress-track";
    progressFill = document.createElement("div");
    progressFill.className = "progress-fill";
    progressTrack.appendChild(progressFill);

    playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "immersive-btn immersive-play";

    bottomBar.appendChild(progressTrack);
    bottomBar.appendChild(playBtn);

    overlay.appendChild(closeBtn);
    overlay.appendChild(prevBtn);
    overlay.appendChild(nextBtn);
    overlay.appendChild(imgWrap);
    overlay.appendChild(bottomBar);
    document.body.appendChild(overlay);

    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", onBackdropClick);
    prevBtn.addEventListener("click", () => currentOpts && currentOpts.onPrev && currentOpts.onPrev());
    nextBtn.addEventListener("click", () => currentOpts && currentOpts.onNext && currentOpts.onNext());
    playBtn.addEventListener("click", () => currentOpts && currentOpts.onTogglePlay && currentOpts.onTogglePlay());

    imgEl.addEventListener("pointerdown", onPointerDown);
    imgEl.addEventListener("pointermove", onPointerMove);
    imgEl.addEventListener("pointerup", onPointerUp);
    imgEl.addEventListener("pointercancel", onPointerUp);
  }

  function syncAccentColor() {
    // The overlay is appended to <body>, outside the <main> element that
    // carries the per-book --accent custom property inline, so it wouldn't
    // otherwise inherit the book's theme and the progress bar would fall
    // back to the default orange. Copy the current value onto the overlay.
    const mainEl = document.querySelector(".site-main");
    if (!mainEl) return;
    const accent = getComputedStyle(mainEl).getPropertyValue("--accent").trim();
    if (accent) overlay.style.setProperty("--accent", accent);
  }

  function syncNavState() {
    prevBtn.disabled = !currentOpts.hasPrev;
    nextBtn.disabled = !currentOpts.hasNext;
  }

  function setImage(imageUrl, alt) {
    resetZoom(false);
    imgEl.src = imageUrl;
    imgEl.alt = alt || "";
  }

  function open(opts) {
    if (!overlay) build();
    currentOpts = opts;

    syncAccentColor();
    setImage(opts.imageUrl, opts.alt);
    syncNavState();

    const hasAudio = opts.controls === "nav-audio";
    bottomBar.hidden = !hasAudio;
    if (hasAudio) setPlaying(Boolean(opts.isPlaying));

    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add("open"));
    document.documentElement.style.overflow = "hidden";
    document.addEventListener("keydown", onKeydown);
  }

  function update(opts) {
    if (!overlay || overlay.hidden) return;
    currentOpts = Object.assign({}, currentOpts, opts);
    setImage(currentOpts.imageUrl, currentOpts.alt);
    syncNavState();
  }

  function setProgress(fraction) {
    if (!progressFill) return;
    progressFill.style.width = `${clamp(fraction, 0, 1) * 100}%`;
  }

  function setPlaying(isPlaying) {
    if (!playBtn) return;
    playBtn.textContent = isPlaying ? "Pause" : "Play";
    if (currentOpts) currentOpts.isPlaying = isPlaying;
  }

  function isOpen() {
    return Boolean(overlay && !overlay.hidden);
  }

  function close() {
    if (!overlay || overlay.hidden) return;
    overlay.classList.remove("open");
    overlay.hidden = true;
    document.documentElement.style.overflow = "";
    document.removeEventListener("keydown", onKeydown);
    pointers.clear();
    panStart = null;
    if (currentOpts && currentOpts.onClose) currentOpts.onClose();
    currentOpts = null;
  }

  window.StoryvoiceZoomStage = { open, update, close, setProgress, setPlaying, isOpen };
})();
