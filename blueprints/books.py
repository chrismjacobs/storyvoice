from functools import wraps

from flask import Blueprint, abort, flash, jsonify, redirect, render_template, request, url_for
from flask_login import current_user, login_required

import media
from models import Book, Narration, db

books_bp = Blueprint("books", __name__, url_prefix="/books")


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not current_user.is_authenticated or not current_user.is_admin:
            abort(403)
        return view(*args, **kwargs)

    return wrapped


@books_bp.route("/")
@login_required
def index():
    query = Book.query
    language = request.args.get("language") or ""
    age_level = request.args.get("age_level") or ""

    if language in Book.LANGUAGE_CHOICES:
        query = query.filter_by(language=language)
    if age_level in Book.AGE_LEVEL_CHOICES:
        query = query.filter_by(age_level=age_level)

    books = query.order_by(Book.created_at.desc()).all()
    thumbnails = {book.id: media.presign_get(book.thumbnail_key) for book in books if book.thumbnail_key}
    return render_template(
        "books_index.html",
        books=books,
        thumbnails=thumbnails,
        language_choices=list(Book.LANGUAGE_LABELS.items()),
        age_level_choices=list(Book.AGE_LEVEL_LABELS.items()),
        selected_language=language,
        selected_age_level=age_level,
    )


@books_bp.route("/upload", methods=["GET", "POST"])
@login_required
@admin_required
def upload():
    if request.method == "POST":
        title = request.form.get("title", "").strip()
        pdf_file = request.files.get("pdf")
        language = request.form.get("language", "")
        age_level = request.form.get("age_level", "")

        if (
            not title
            or not pdf_file
            or pdf_file.filename == ""
            or language not in Book.LANGUAGE_CHOICES
            or age_level not in Book.AGE_LEVEL_CHOICES
        ):
            flash("Title, a PDF file, language, and age level are all required.", "error")
            return render_template("book_upload.html", **_upload_form_choices())

        pdf_bytes = pdf_file.read()

        book = Book(title=title, language=language, age_level=age_level, uploaded_by=current_user.id)
        db.session.add(book)
        db.session.flush()  # assign book.id before building S3 keys

        media.put_bytes(f"books/{book.id}/original.pdf", pdf_bytes, "application/pdf")

        page_count = 0
        for page_number, webp_bytes in media.render_pdf_pages(pdf_bytes):
            media.put_bytes(book.page_image_key(page_number), webp_bytes, "image/webp")
            page_count += 1

        book.page_count = page_count
        book.original_pdf_key = f"books/{book.id}/original.pdf"
        book.thumbnail_key = book.page_image_key(1) if page_count else None
        db.session.commit()

        flash(f'"{book.title}" uploaded with {page_count} pages.', "success")
        return redirect(url_for("books.view", book_id=book.id))

    return render_template("book_upload.html", **_upload_form_choices())


def _upload_form_choices():
    return {
        "language_choices": list(Book.LANGUAGE_LABELS.items()),
        "age_level_choices": list(Book.AGE_LEVEL_LABELS.items()),
    }


@books_bp.route("/<int:book_id>")
@login_required
def view(book_id):
    book = Book.query.get_or_404(book_id)
    narrations = [n for n in book.narrations if n.is_visible_to(current_user)]
    narration_data = []
    for narration in narrations:
        done, total = narration.progress()
        narration_data.append({"narration": narration, "done": done, "total": total})
    return render_template("book_view.html", book=book, narration_data=narration_data)


@books_bp.route("/<int:book_id>/delete", methods=["POST"])
@login_required
@admin_required
def delete(book_id):
    book = Book.query.get_or_404(book_id)

    keys = []
    if book.original_pdf_key:
        keys.append(book.original_pdf_key)
    keys.extend(book.page_image_key(n) for n in range(1, book.page_count + 1))
    for narration in book.narrations:
        keys.extend(page.audio_key for page in narration.pages if page.audio_key)

    media.delete_objects(keys)

    title = book.title
    db.session.delete(book)
    db.session.commit()

    flash(f'"{title}" and its narrations were deleted.', "success")
    return redirect(url_for("books.index"))


@books_bp.route("/<int:book_id>/pages/<int:page_number>/image-url")
@login_required
def page_image_url(book_id, page_number):
    book = Book.query.get_or_404(book_id)
    if page_number < 1 or page_number > book.page_count:
        abort(404)
    return jsonify({"url": media.presign_get(book.page_image_key(page_number))})
