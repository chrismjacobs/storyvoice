from datetime import datetime, timezone

from flask_login import UserMixin
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import check_password_hash, generate_password_hash

db = SQLAlchemy()


def utcnow():
    return datetime.now(timezone.utc)


class User(UserMixin, db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    display_name = db.Column(db.String(120), nullable=False)
    is_admin = db.Column(db.Boolean, nullable=False, default=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    narrations = db.relationship("Narration", back_populates="user", cascade="all, delete-orphan")

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)


class Book(db.Model):
    __tablename__ = "books"

    LANGUAGE_CHOICES = ("english", "chinese", "japanese", "other")
    LANGUAGE_LABELS = {"english": "English", "chinese": "Chinese", "japanese": "Japanese", "other": "Other"}

    AGE_LEVEL_CHOICES = ("under_5", "5_7", "7_plus")
    AGE_LEVEL_LABELS = {"under_5": "Under 5", "5_7": "5-7", "7_plus": "7+"}

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(255), nullable=False)
    page_count = db.Column(db.Integer, nullable=False, default=0)
    thumbnail_key = db.Column(db.String(500))
    original_pdf_key = db.Column(db.String(500))
    language = db.Column(db.String(20), nullable=False, default="english")
    age_level = db.Column(db.String(20), nullable=False, default="5_7")
    uploaded_by = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)

    uploader = db.relationship("User")
    narrations = db.relationship("Narration", back_populates="book", cascade="all, delete-orphan")

    def page_image_key(self, page_number):
        return f"books/{self.id}/pages/{page_number}.webp"

    def language_label(self):
        return self.LANGUAGE_LABELS[self.language]

    def age_level_label(self):
        return self.AGE_LEVEL_LABELS[self.age_level]


class Narration(db.Model):
    __tablename__ = "narrations"

    VISIBILITY_CHOICES = ("private", "shared", "public")

    id = db.Column(db.Integer, primary_key=True)
    book_id = db.Column(db.Integer, db.ForeignKey("books.id"), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    title = db.Column(db.String(255))
    visibility = db.Column(db.String(20), nullable=False, default="private")
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)

    book = db.relationship("Book", back_populates="narrations")
    user = db.relationship("User", back_populates="narrations")
    pages = db.relationship(
        "NarrationPage",
        back_populates="narration",
        cascade="all, delete-orphan",
        order_by="NarrationPage.page_number",
    )

    def display_title(self):
        return self.title or f"{self.user.display_name}'s version"

    def is_visible_to(self, user):
        if self.visibility == "public":
            return True
        if user is None or not user.is_authenticated:
            return False
        if self.visibility == "shared":
            return True
        return self.user_id == user.id

    def progress(self):
        total = self.book.page_count
        done = sum(1 for p in self.pages if p.status != "pending")
        return done, total

    def is_complete(self):
        done, total = self.progress()
        return total > 0 and done == total


class NarrationPage(db.Model):
    __tablename__ = "narration_pages"
    __table_args__ = (db.UniqueConstraint("narration_id", "page_number", name="uq_narration_page"),)

    STATUS_CHOICES = ("pending", "recorded", "silent")

    id = db.Column(db.Integer, primary_key=True)
    narration_id = db.Column(db.Integer, db.ForeignKey("narrations.id"), nullable=False)
    page_number = db.Column(db.Integer, nullable=False)
    status = db.Column(db.String(20), nullable=False, default="pending")
    audio_key = db.Column(db.String(500))
    duration_ms = db.Column(db.Integer)
    dwell_seconds = db.Column(db.Numeric(5, 2), nullable=False, default=1)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)

    narration = db.relationship("Narration", back_populates="pages")

    def audio_object_key(self):
        return f"narrations/{self.narration_id}/{self.page_number}.mp3"
