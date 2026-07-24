// Plain picture browser: page images only, no narration/audio. No Vue needed here —
// this screen is just image + prev/next + thumbnails, so keep it near-static per CLAUDE.md.
document.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("pictures-app");
  if (!root) return;

  const bookId = root.dataset.bookId;
  const statusEl = document.getElementById("pictures-status");
  const imageEl = document.getElementById("pictures-image");
  const prevBtn = document.getElementById("pictures-prev");
  const nextBtn = document.getElementById("pictures-next");
  const expandBtn = document.getElementById("pictures-expand");
  const thumbsEl = document.getElementById("pictures-thumbs");

  let pages = [];
  let currentIndex = 0;

  function render() {
    const page = pages[currentIndex];
    if (!page) return;

    imageEl.src = page.image_url;
    imageEl.alt = "Page " + page.page_number;
    imageEl.hidden = false;
    statusEl.textContent = `Page ${currentIndex + 1} of ${pages.length}`;

    prevBtn.disabled = currentIndex <= 0;
    nextBtn.disabled = currentIndex >= pages.length - 1;

    thumbsEl.querySelectorAll(".thumb-item").forEach((el, idx) => {
      el.classList.toggle("active", idx === currentIndex);
    });
    const active = thumbsEl.querySelector(".thumb-item.active");
    if (active) active.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });

    if (window.StoryvoiceZoomStage && window.StoryvoiceZoomStage.isOpen()) {
      window.StoryvoiceZoomStage.update({
        imageUrl: page.image_url,
        alt: imageEl.alt,
        hasPrev: currentIndex > 0,
        hasNext: currentIndex < pages.length - 1,
      });
    }
  }

  function goTo(idx) {
    if (idx < 0 || idx >= pages.length) return;
    currentIndex = idx;
    render();
  }

  function openExpanded() {
    const page = pages[currentIndex];
    if (!page || !window.StoryvoiceZoomStage) return;
    window.StoryvoiceZoomStage.open({
      imageUrl: page.image_url,
      alt: imageEl.alt,
      hasPrev: currentIndex > 0,
      hasNext: currentIndex < pages.length - 1,
      onPrev: () => goTo(currentIndex - 1),
      onNext: () => goTo(currentIndex + 1),
    });
  }

  function buildThumbs() {
    thumbsEl.innerHTML = "";
    pages.forEach((page, idx) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "thumb-item";
      button.addEventListener("click", () => goTo(idx));

      const img = document.createElement("img");
      img.src = page.image_url;
      img.alt = "Page " + page.page_number;
      img.loading = "lazy";

      const pageNumber = document.createElement("span");
      pageNumber.className = "thumb-page-number";
      pageNumber.textContent = page.page_number;

      button.appendChild(img);
      button.appendChild(pageNumber);
      thumbsEl.appendChild(button);
    });
  }

  prevBtn.addEventListener("click", () => goTo(currentIndex - 1));
  nextBtn.addEventListener("click", () => goTo(currentIndex + 1));
  expandBtn.addEventListener("click", openExpanded);
  imageEl.addEventListener("click", openExpanded);

  fetch(`/books/${bookId}/pictures/data`)
    .then((res) => res.json())
    .then((data) => {
      pages = data.pages;
      if (!pages.length) {
        statusEl.textContent = "This book has no pages.";
        return;
      }
      buildThumbs();
      render();
    })
    .catch(() => {
      statusEl.textContent = "Could not load pages — try refreshing.";
    });
});
