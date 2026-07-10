from flask import Blueprint, abort, jsonify, redirect, render_template, request, url_for
from flask_login import current_user, login_required

import media
from models import Book, Narration, NarrationPage, db

narrations_bp = Blueprint("narrations", __name__)


def _visible_or_404(narration):
    if not narration.is_visible_to(current_user):
        abort(404)
    return narration


@narrations_bp.route("/books/<int:book_id>/narrations", methods=["POST"])
@login_required
def create(book_id):
    book = Book.query.get_or_404(book_id)
    title = request.form.get("title", "").strip() or None

    narration = Narration(book_id=book.id, user_id=current_user.id, title=title, visibility="private")
    db.session.add(narration)
    db.session.flush()

    for page_number in range(1, book.page_count + 1):
        db.session.add(NarrationPage(narration_id=narration.id, page_number=page_number, status="pending"))

    db.session.commit()
    return redirect(url_for("narrations.record", narration_id=narration.id))


@narrations_bp.route("/narrations/<int:narration_id>/record")
@login_required
def record(narration_id):
    narration = Narration.query.get_or_404(narration_id)
    if narration.user_id != current_user.id:
        abort(403)

    candidates = [
        n
        for n in narration.book.narrations
        if n.id != narration.id and n.is_visible_to(current_user)
    ]
    candidates.sort(key=lambda n: n.progress()[0], reverse=True)

    return render_template(
        "record.html",
        narration=narration,
        book=narration.book,
        model_candidates=candidates,
    )


@narrations_bp.route("/narrations/<int:narration_id>/record/data")
@login_required
def record_data(narration_id):
    narration = Narration.query.get_or_404(narration_id)
    if narration.user_id != current_user.id:
        abort(403)

    pages = []
    for page in narration.pages:
        pages.append(
            {
                "page_number": page.page_number,
                "status": page.status,
                "duration_ms": page.duration_ms,
                "dwell_seconds": float(page.dwell_seconds),
                "image_url": media.presign_get(narration.book.page_image_key(page.page_number)),
                "audio_url": media.presign_get(page.audio_object_key()) if page.status == "recorded" else None,
            }
        )

    model_id = request.args.get("model_id", type=int)
    model_pages = {}
    if model_id:
        model = Narration.query.get_or_404(model_id)
        _visible_or_404(model)
        if model.book_id == narration.book_id:
            for page in model.pages:
                if page.status == "recorded":
                    model_pages[page.page_number] = media.presign_get(page.audio_object_key())

    return jsonify({"pages": pages, "model_pages": model_pages})


@narrations_bp.route("/narrations/<int:narration_id>/pages/<int:page_number>/clip", methods=["POST"])
@login_required
def upload_clip(narration_id, page_number):
    narration = Narration.query.get_or_404(narration_id)
    if narration.user_id != current_user.id:
        abort(403)

    page = NarrationPage.query.filter_by(narration_id=narration.id, page_number=page_number).first_or_404()

    audio_file = request.files.get("audio")
    if not audio_file:
        abort(400)

    raw_bytes = audio_file.read()

    # Temporary debug aid: keep the exact raw upload so odd device-specific
    # recordings (e.g. iOS Safari) can be inspected after the fact. Overwritten
    # on every take for a page, so this doesn't accumulate.
    media.put_bytes(
        f"narrations/{narration.id}/{page_number}.debug.raw",
        raw_bytes,
        audio_file.mimetype or "application/octet-stream",
    )

    debug_context = f"narration={narration.id} page={page_number} mimetype={audio_file.mimetype}"
    mp3_bytes, duration_ms = media.transcode_to_mp3(raw_bytes, debug_context=debug_context)
    media.put_bytes(page.audio_object_key(), mp3_bytes, "audio/mpeg")

    page.status = "recorded"
    page.audio_key = page.audio_object_key()
    page.duration_ms = duration_ms
    page.dwell_seconds = page.dwell_seconds or 1
    db.session.commit()

    return jsonify(
        {
            "status": page.status,
            "duration_ms": page.duration_ms,
            "audio_url": media.presign_get(page.audio_key),
        }
    )


@narrations_bp.route("/narrations/<int:narration_id>/pages/<int:page_number>/silent", methods=["POST"])
@login_required
def mark_silent(narration_id, page_number):
    narration = Narration.query.get_or_404(narration_id)
    if narration.user_id != current_user.id:
        abort(403)

    page = NarrationPage.query.filter_by(narration_id=narration.id, page_number=page_number).first_or_404()
    page.status = "silent"
    page.audio_key = None
    page.duration_ms = None
    page.dwell_seconds = 6
    db.session.commit()

    return jsonify({"status": page.status, "dwell_seconds": float(page.dwell_seconds)})


@narrations_bp.route("/narrations/<int:narration_id>/pages/<int:page_number>/dwell", methods=["POST"])
@login_required
def set_dwell(narration_id, page_number):
    narration = Narration.query.get_or_404(narration_id)
    if narration.user_id != current_user.id:
        abort(403)

    page = NarrationPage.query.filter_by(narration_id=narration.id, page_number=page_number).first_or_404()
    dwell_seconds = request.get_json(silent=True) or {}
    value = dwell_seconds.get("dwell_seconds")
    if value is None or float(value) < 0:
        abort(400)

    page.dwell_seconds = value
    db.session.commit()
    return jsonify({"dwell_seconds": float(page.dwell_seconds)})


@narrations_bp.route("/narrations/<int:narration_id>", methods=["PATCH"])
@login_required
def update(narration_id):
    narration = Narration.query.get_or_404(narration_id)
    if narration.user_id != current_user.id:
        abort(403)

    body = request.get_json(silent=True) or {}
    if "visibility" in body:
        if body["visibility"] not in Narration.VISIBILITY_CHOICES:
            abort(400)
        narration.visibility = body["visibility"]
    if "title" in body:
        narration.title = body["title"].strip() or None

    db.session.commit()
    return jsonify({"visibility": narration.visibility, "title": narration.title})


@narrations_bp.route("/narrations/<int:narration_id>/listen")
@login_required
def listen(narration_id):
    narration = Narration.query.get_or_404(narration_id)
    _visible_or_404(narration)
    return render_template("listen.html", narration=narration, book=narration.book)


@narrations_bp.route("/narrations/<int:narration_id>/listen/data")
@login_required
def listen_data(narration_id):
    narration = Narration.query.get_or_404(narration_id)
    _visible_or_404(narration)

    pages = []
    for page in narration.pages:
        pages.append(
            {
                "page_number": page.page_number,
                "status": page.status,
                "duration_ms": page.duration_ms,
                "dwell_seconds": float(page.dwell_seconds),
                "image_url": media.presign_get(narration.book.page_image_key(page.page_number)),
                "audio_url": media.presign_get(page.audio_key) if page.status == "recorded" and page.audio_key else None,
            }
        )

    return jsonify({"pages": pages, "title": narration.display_title()})
