# Storyvoice

*Bring voice to stories.*

A self-hosted web app for recording **human voice narration**, page by page, over scanned children's books. One book can hold several narrations — a parent's, then a child's — and users can hear an existing narration as a model before recording their own. Built for personal/family use and quiet sharing with a few interested parents, not as a commercial product (the source books are scans of copyrighted works).

---

## What this is — and is NOT

Before writing any feature, hold this distinction. The audiobook/document-reader ecosystem is enormous and almost all of it is **machine text-to-speech**. Storyvoice is the opposite category.

- **This IS:** per-page *human* voice recording; multiple narrations per book (dad's, son's, other parents'); a listen-to-a-model-then-record loop; a page-based image viewer with auto-advance.
- **This is NOT:** a TTS/read-aloud tool, an audiobook generator, or a synced-highlighting reader. **Never generate audio from text.** Every clip is a real human recording uploaded from the browser.

If a task ever seems to call for TTS, speech synthesis, or "read the text aloud automatically," that is a misread of the app — stop and reconsider.

---

## Tech stack

| Layer | Choice | Hard constraint |
|---|---|---|
| Backend | **Flask** (Python) | App-factory pattern, blueprints |
| Frontend | **Vue 3 via CDN** | **No build step. No SPA. No Vue Router.** Server-rendered Jinja shells, one Vue app per view, loaded from a `<script>` tag. |
| Recording | Browser **MediaRecorder** | Output format is browser-dependent — never trust it (see Media rules) |
| PDF → images | **PyMuPDF (`fitz`)** | Rasterize at upload |
| Audio transcode | **ffmpeg** → MP3 | Via `imageio-ffmpeg`'s bundled binary or a Docker deploy (Render's default Python env has no system ffmpeg) |
| Storage | **AWS S3**, private bucket | Presigned URLs only |
| Database | **Managed Postgres** (Neon/Supabase free tier) | **Not** SQLite on Render — the disk is ephemeral and accounts/metadata would vanish on restart |
| Hosting | **Render** | Separate `production` and `staging` services |

### Frontend guardrail (read twice)

Vue is used **only** as a no-build reactive layer for stateful screens. When you see "Vue," do **not** scaffold Vite, npm, a bundler, or vue-router. Each view is a Jinja-rendered HTML page that pulls Vue from a CDN and mounts one `createApp({...})`. The record panel and the auto-play viewer are the two screens that justify reactivity; everything else can be near-static.

---

## Core architecture decisions

These are the non-obvious calls. Respect them — each exists to avoid a specific failure.

### 1. A book is an ordered list of page images, not a PDF

At upload, render every PDF page to an image with PyMuPDF and store the images in S3. The viewer is then a simple **image carousel**, never a PDF.js embed. This makes fullscreen trivial, pages load fast (scanned books are heavy), the thumbnail is just page 1, and each page image pairs 1:1 with an audio clip. Keep the original PDF in S3 too, so pages can be re-rendered later.

### 2. Cross-device audio: always transcode to MP3

`MediaRecorder` produces `webm/opus` on Chrome/Android but `mp4/AAC` on iOS Safari, and **iOS Safari cannot play webm**. So "record on Android, play on iPad" = silence unless we normalize. On every clip upload, **transcode server-side to MP3 with ffmpeg** and store that. MP3 plays everywhere and fully decouples the recording device from the playback device. Never store the raw MediaRecorder blob as the canonical clip.

### 3. S3 Content-Type must be set explicitly

Audio objects **must** be written with `Content-Type: audio/mpeg`, page images with `image/webp` (or `image/jpeg`). If S3 serves audio as `application/octet-stream`, browsers won't play it inline. This is the second half of the cross-device fix.

### 4. Narrations are first-class, multi-user objects

A recording is **not** attached to a book directly — it belongs to a *narration* (one user's set of per-page clips for one book). This one decision makes everything else fall out: son picks dad's narration to hear, then makes his own; auto-advance reads each page's stored duration; the future "other parents" growth is just more narrations with a different visibility flag.

### 5. Everything is login-gated behind presigned URLs

Private bucket, no public objects. The backend issues **short-TTL presigned URLs** (≈1 hour) for PDFs, page images, and audio, only to authenticated users. Because the book scans are the real copyright exposure, keep books member-only always; sharing applies to *narrations*, not to the scans.

### 6. Per-page upload, immediately

Each page's clip uploads the moment the recorder taps **Keep** — not batched at session end. Robust, resumable, and it keeps the "is this book done?" question answerable at any time.

---

## Data model

Book *structure* (page images) is shared across all narrations. Narrations layer voice on top. `narration_pages` carries all per-page recording state.

```
users
  id                pk
  username          unique
  password_hash
  display_name
  is_admin          bool   -- admins can upload books
  created_at

books
  id                pk
  title
  page_count        int
  thumbnail_key      -- S3 key, == page 1 image
  original_pdf_key   -- S3 key of the source PDF (for re-render)
  uploaded_by        fk users
  created_at

narrations
  id                pk
  book_id           fk books
  user_id           fk users        -- who recorded it
  title             -- optional, defaults to user's display_name ("Dad's version")
  visibility        enum: private | shared | public   -- see below
  created_at
  updated_at
  -- no unique(book_id,user_id): a user MAY keep more than one
  --   narration of the same book ("calm version" / "silly version")

narration_pages
  id                pk
  narration_id      fk narrations
  page_number       int             -- 1-indexed
  status            enum: pending | recorded | silent
  audio_key         -- S3 key, null unless status = recorded
  duration_ms       int, null       -- used by auto-advance timing
  dwell_seconds     numeric         -- trailing hold after audio; default 1 (recorded), 6 (silent)
  updated_at
  unique(narration_id, page_number)
```

**Page images** are stored by convention rather than in a table:
`storyvoice/books/{book_id}/pages/{n}.webp`. (A `pages` table would be more robust against per-page render failures — collapse this into one if that ever bites, but convention is fine for short kids' books.)

### Completeness

A narration is **complete** when it has one `narration_pages` row per book page and **none** are `pending`. `silent` counts as done — it's an explicit "this page has no speech" choice, not a gap. This also gives a free progress indicator ("18/24 pages").

### Visibility

`private` (owner only) · `shared` (any logged-in member) · `public` (anyone).
**Build `private` and `shared` first; defer `public`.** A narration is viewable if it is public, OR shared and the viewer is a member, OR owned by the viewer. Books themselves are always member-gated.

---

## S3 layout

```
storyvoice/
  books/{book_id}/original.pdf              Content-Type: application/pdf
  books/{book_id}/pages/{n}.webp            Content-Type: image/webp
  narrations/{narration_id}/{page}.mp3      Content-Type: audio/mpeg
```

Thumbnail = `books/{book_id}/pages/1.webp`. Use per-environment bucket prefixes so staging never touches production media.

---

## Core flows

### A. Upload a book (admin)

1. Receive PDF + title.
2. Store the original PDF to S3.
3. Render every page to a webp with PyMuPDF; upload each; set `Content-Type: image/webp`.
4. Set `page_count`, `thumbnail_key` (page 1), create the `books` row.

Do this synchronously — kids' books are short. (If a very long PDF ever appears, move rendering to a background job; not needed for v1.)

### B. Record mode

Entering record mode takes **two choices**: which narration you're creating/editing, and which narration (if any) you'll hear as the **model**. Default the model to the most complete existing narration for that book; allow "none."

Per page, the loop is:

```
[Hear model]  →  Record  →  Review  →  Keep | Redo | Mark silent  →  advance
```

- **Hear model** — plays the model narration's clip for this page. Greyed out if the model has no clip here.
- **Record** — on tap: request mic permission if needed, **then** run the 2-second countdown (never start the countdown before the permission dialog resolves — on iOS it covers the screen), then hot mic.
- **Review** — play back the take. **Keep** uploads the blob → server transcodes to MP3 → stores `audio_key` + `duration_ms`, sets `status = recorded`. **Redo** loops without uploading (flubbed takes never hit S3). **Mark silent** sets `status = silent`, `audio_key = null`, `dwell_seconds` default 6.
- Each page also exposes a **dwell seconds** input.

**Hard sequencing rule:** model-clip playback must fully stop **before** the mic goes hot, or the model voice bleeds into the recording (especially on a speaker without headphones). Gate it: model stops → countdown → record.

### C. Auto-play (listen mode)

Per page:

```
load page image + clip  →  play audio (skip if silent)  →  hold for dwell_seconds  →  advance
```

- Dwell applies to **recorded** pages too, not just silent ones — a ~1s beat after narration lets a child look at the picture. Silent pages are the special case where dwell is the whole duration.
- Show a **thin progress bar that fills over the dwell duration**, so a silent 6-second page doesn't look frozen and get tapped as "broken." Kid-legible "something is happening, wait."
- Provide manual pause / back / skip; skipping a page advances immediately.

---

## Auth & permissions

- `flask-login` sessions; passwords hashed (Werkzeug or bcrypt).
- Book upload is **admin-only** in v1 (Christian). Members record narrations.
- Enforce visibility on every narration fetch and every presigned-URL issue. Never issue a presigned URL for a narration the viewer isn't allowed to see.

---

## Project structure

```
storyvoice/
  app.py                 app factory
  config.py              env-driven config
  models.py              SQLAlchemy models
  blueprints/
    auth.py              login / logout / register
    books.py             upload, list, view
    narrations.py        create, per-page clip upload, fetch
  media.py               S3 (presign, put), ffmpeg transcode, PyMuPDF render
  templates/             Jinja shells (server-rendered)
  static/js/
    recorder.js          Vue app: record panel state machine
    viewer.js            Vue app: auto-play viewer
  requirements.txt
  Dockerfile             (if using Docker to get ffmpeg)
  CLAUDE.md
  .env                   NOT committed
```

The recorder is a small state machine — `idle → hearing_model → countdown → recording → reviewing → (keep|redo|silent) → advance`. Keep that logic in real Vue methods, not scattered DOM handlers.

---

## Environment & deploy

### Env vars

```
FLASK_SECRET_KEY
DATABASE_URL              managed Postgres (per environment)
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
S3_BUCKET
S3_REGION
S3_PREFIX                e.g. storyvoice-prod / storyvoice-staging
PRESIGN_TTL_SECONDS      default 3600
```

### Render

Two services, **production** and **staging**, each with its own `DATABASE_URL` and `S3_PREFIX`. Start command: `gunicorn app:app`.

**ffmpeg on Render:** the default Python runtime has no system ffmpeg. Either (a) add the `imageio-ffmpeg` package and call its bundled static binary, or (b) deploy via Docker with `apt-get install ffmpeg`. Pick one and keep it consistent across both services. PyMuPDF ships wheels and needs no system dependency.

---

## Do NOT

- Do **not** scaffold Vite, npm, a bundler, or vue-router. Vue 3 via CDN, server-rendered shells, one app per view.
- Do **not** add TTS or synthesize audio. Human voice only.
- Do **not** serve S3 objects publicly or hardcode object URLs. Presigned, short-TTL, authenticated only.
- Do **not** treat the raw MediaRecorder blob as canonical. Always transcode to MP3 and set `Content-Type: audio/mpeg`.
- Do **not** put the database or media on Render's local disk (ephemeral). Postgres + S3 only.
- Do **not** start the record countdown before the mic-permission promise resolves.
- Do **not** let model-clip playback overlap the hot mic.
- Do **not** batch clip uploads — upload per page on Keep.

---

## Glossary

- **Book** — a scanned PDF, stored as an ordered set of page images.
- **Narration** — one user's set of per-page clips for one book (dad's, son's, …).
- **Page status** — `recorded` / `silent` / `pending`; `silent` is a deliberate no-speech choice.
- **Model** — the narration a recorder listens to before recording their own take.
- **Dwell** — seconds to hold on a page after its audio ends before auto-advancing.