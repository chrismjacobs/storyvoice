import click
from flask import Flask, redirect, url_for
from flask_login import LoginManager
from flask_migrate import Migrate

from config import Config
from models import User, db

migrate = Migrate()
login_manager = LoginManager()
login_manager.login_view = "auth.login"


def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)

    db.init_app(app)
    migrate.init_app(app, db)
    login_manager.init_app(app)

    from blueprints.auth import auth_bp
    from blueprints.books import books_bp
    from blueprints.narrations import narrations_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(books_bp)
    app.register_blueprint(narrations_bp)

    @app.route("/")
    def index():
        return redirect(url_for("books.index"))

    register_cli(app)

    return app


def register_cli(app):
    @app.cli.command("seed-admin")
    def seed_admin():
        """Create the admin user from ADMIN_EMAIL / ADMIN_PASSWORD env vars."""
        email = app.config["ADMIN_EMAIL"]
        password = app.config["ADMIN_PASSWORD"]
        if not email or not password:
            click.echo("ADMIN_EMAIL / ADMIN_PASSWORD not set, skipping.")
            return
        if User.query.filter_by(username=email).first():
            click.echo(f"Admin user {email} already exists.")
            return
        admin = User(username=email, display_name="Christian", is_admin=True)
        admin.set_password(password)
        db.session.add(admin)
        db.session.commit()
        click.echo(f"Created admin user {email}.")


@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))


app = create_app()

if __name__ == "__main__":
    app.run(debug=True)
