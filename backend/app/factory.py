from __future__ import annotations

import uuid

from flask import Flask, g, jsonify, request
from werkzeug.exceptions import HTTPException

from .routes import api


def create_app() -> Flask:
    app = Flask(__name__)
    app.register_blueprint(api)

    @app.before_request
    def attach_request_id():
        g.request_id = request.headers.get("X-Request-Id") or uuid.uuid4().hex

    @app.after_request
    def add_cors_headers(response):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, Idempotency-Key"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Request-Id"] = getattr(g, "request_id", "")
        return response

    @app.errorhandler(HTTPException)
    def handle_http_error(error: HTTPException):
        return jsonify(
            {
                "code": error.name.upper().replace(" ", "_"),
                "message": error.description,
                "requestId": getattr(g, "request_id", None),
            }
        ), error.code or 500

    @app.errorhandler(Exception)
    def handle_unexpected_error(_error: Exception):
        return jsonify(
            {
                "code": "INTERNAL_SERVER_ERROR",
                "message": "Internal server error",
                "requestId": getattr(g, "request_id", None),
            }
        ), 500

    return app
