"""
CTFd plugin for Kubernetes container challenges.
Bridges CTFd (control plane) with the on‑prem Node.js orchestrator (data plane).
"""
from __future__ import annotations

import requests
from flask import redirect, render_template, request, url_for
from CTFd.models import Challenges, Configs, Flags, db
from CTFd.plugins import register_plugin_assets_directory
from CTFd.plugins.challenges import BaseChallenge, CHALLENGE_CLASSES
from CTFd.utils import get_config
from CTFd.utils.decorators import admins_only, authed_only
from CTFd.utils.user import get_current_user

from .models import ContainerChallenge

# -----------------------------------------------------------------------------
# Challenge type
# -----------------------------------------------------------------------------


class ContainerChallengeClass(BaseChallenge):
    id = "container"
    name = "container"
    templates = {
        "create": "/plugins/k8s-challenges/assets/create.html",
        "update": "/plugins/k8s-challenges/assets/update.html",
        "view": "/plugins/k8s-challenges/assets/view.html",
    }
    scripts = {
        "create": "/plugins/k8s-challenges/assets/create.js",
        "update": "/plugins/k8s-challenges/assets/update.js",
        "view": "/plugins/k8s-challenges/assets/view.js",
    }
    challenge_model = ContainerChallenge

    @classmethod
    def create(cls, request):
        data = request.form or request.get_json() or {}
        data = dict(data)
        extra = data.pop("extra", None) or {}
        data.update(extra)
        data["type"] = "container"
        challenge = cls.challenge_model(**data)
        db.session.add(challenge)
        db.session.commit()
        return challenge

    @classmethod
    def read(cls, challenge):
        row = ContainerChallenge.query.filter_by(id=challenge.id).first()
        if not row:
            row = challenge
        data = {
            "id": challenge.id,
            "name": challenge.name,
            "value": challenge.value,
            "description": challenge.description,
            "connection_info": challenge.connection_info,
            "category": challenge.category,
            "state": challenge.state,
            "max_attempts": challenge.max_attempts,
            "type": challenge.type,
            "type_data": {
                "id": cls.id,
                "name": cls.name,
                "templates": cls.templates,
                "scripts": cls.scripts,
            },
            "image": getattr(row, "image", None),
            "port": getattr(row, "port", 80),
            "connection_type": getattr(row, "connection_type", "http"),
            "memory_limit": getattr(row, "memory_limit", "256Mi"),
            "cpu_limit": getattr(row, "cpu_limit"),
            "timeout": getattr(row, "timeout", 3600),
        }
        return data

    @classmethod
    def update(cls, challenge, request):
        data = request.form or request.get_json() or {}
        data = dict(data)
        extra = data.pop("extra", None) or {}
        data.update(extra)

        container = ContainerChallenge.query.filter_by(id=challenge.id).first()
        if not container:
            return challenge

        for k in ("image", "port", "command", "connection_type", "cpu_limit", "memory_limit", "timeout"):
            if k in data:
                setattr(container, k, data[k])
        for k, v in data.items():
            if hasattr(challenge, k) and k not in ("image", "port", "command", "connection_type", "cpu_limit", "memory_limit", "timeout"):
                setattr(challenge, k, v)
        db.session.commit()
        return challenge

    @classmethod
    def delete(cls, challenge):
        from CTFd.models import ChallengeFiles, Fails, Hints, Solves, Tags
        from CTFd.utils.uploads import delete_file

        Fails.query.filter_by(challenge_id=challenge.id).delete()
        Solves.query.filter_by(challenge_id=challenge.id).delete()
        Flags.query.filter_by(challenge_id=challenge.id).delete()
        for f in ChallengeFiles.query.filter_by(challenge_id=challenge.id).all():
            delete_file(f.id)
        ChallengeFiles.query.filter_by(challenge_id=challenge.id).delete()
        Tags.query.filter_by(challenge_id=challenge.id).delete()
        Hints.query.filter_by(challenge_id=challenge.id).delete()
        ContainerChallenge.query.filter_by(id=challenge.id).delete()
        Challenges.query.filter_by(id=challenge.id).delete()
        db.session.commit()


def _get_config(key, default=""):
    r = Configs.query.filter_by(key=key).first()
    return (r.value or default) if r else default


def _orchestrator_request(method, path, json=None, timeout=30):
    base = _get_config("k8s_orchestrator_url", "").rstrip("/")
    if not base:
        return None, {"error": "Orchestrator URL not configured"}
    key = _get_config("k8s_api_key", "")
    url = f"{base}/api/v1{path}"
    headers = {}
    if key:
        headers["X-API-KEY"] = key
    try:
        if method == "GET":
            r = requests.get(url, headers=headers, timeout=timeout)
        else:
            r = requests.request(method, url, headers=headers, json=json or {}, timeout=timeout)
        return r.status_code, r.json() if r.headers.get("content-type", "").startswith("application/json") else {"error": r.text or str(r.status_code)}
    except Exception as e:
        return 500, {"error": str(e)}


def _account_id():
    user = get_current_user()
    if not user:
        return None
    if get_config("user_mode") == "teams" and getattr(user, "team_id", None):
        return str(user.team_id)
    return str(user.id)


def _container_api(app):
    @app.route("/api/v1/container/start", methods=["POST"])
    @authed_only
    def _start():
        aid = _account_id()
        if not aid:
            return {"success": False, "error": "Not authenticated"}, 401
        data = request.get_json() or {}
        cid = data.get("challenge_id")
        if not cid:
            return {"success": False, "error": "challenge_id required"}, 400
        row = ContainerChallenge.query.filter_by(id=int(cid)).first()
        if not row or row.type != "container":
            return {"success": False, "error": "Challenge not found or not a container challenge"}, 404
        flag = Flags.query.filter_by(challenge_id=row.id).first()
        flag_val = (flag.content or "") if flag else ""
        body = {
            "challenge_id": str(row.id),
            "team_id": aid,
            "image": row.image,
            "type": "web" if (row.connection_type or "http").lower() == "http" else "tcp",
            "duration": int(row.timeout or 3600),
            "internal_port": int(row.port or 80),
            "memory_limit": row.memory_limit or "256Mi",
            "cpu_limit": row.cpu_limit or None,
            "env_vars": {"FLAG": flag_val},
        }
        code, out = _orchestrator_request("POST", "/deploy", json=body)
        if code in (200, 201):
            return {"success": True, "data": out}
        return {"success": False, "error": out.get("error", "Orchestrator error")}, max(400, code)

    @app.route("/api/v1/container/status", methods=["GET"])
    @authed_only
    def _status():
        aid = _account_id()
        if not aid:
            return {"success": False, "error": "Not authenticated"}, 401
        cid = request.args.get("challenge_id")
        if not cid:
            return {"success": False, "error": "challenge_id required"}, 400
        code, out = _orchestrator_request("GET", f"/status?team_id={aid}&challenge_id={cid}")
        if code == 200:
            return {"success": True, "data": out}
        return {"success": False, "error": out.get("error", "Orchestrator error")}, max(400, code)

    @app.route("/api/v1/container/stop", methods=["POST"])
    @authed_only
    def _stop():
        aid = _account_id()
        if not aid:
            return {"success": False, "error": "Not authenticated"}, 401
        data = request.get_json() or {}
        cid = data.get("challenge_id")
        if not cid:
            return {"success": False, "error": "challenge_id required"}, 400
        code, out = _orchestrator_request("POST", "/terminate", json={"team_id": aid, "challenge_id": str(cid)})
        if code == 200:
            return {"success": True, "data": out}
        return {"success": False, "error": out.get("error", "Orchestrator error")}, max(400, code)

    @app.route("/api/v1/container/renew", methods=["POST"])
    @authed_only
    def _renew():
        aid = _account_id()
        if not aid:
            return {"success": False, "error": "Not authenticated"}, 401
        data = request.get_json() or {}
        cid = data.get("challenge_id")
        if not cid:
            return {"success": False, "error": "challenge_id required"}, 400
        body = {"team_id": aid, "challenge_id": str(cid), "restart": bool(data.get("restart"))}
        if data.get("duration"):
            body["duration"] = int(data["duration"])
        code, out = _orchestrator_request("POST", "/renew", json=body)
        if code == 200:
            return {"success": True, "data": out}
        return {"success": False, "error": out.get("error", "Orchestrator error")}, max(400, code)


def _admin_routes(app):
    from flask import Blueprint
    from flask_wtf.csrf import generate_csrf

    bp = Blueprint("k8s_config", __name__, template_folder="templates")

    @bp.route("/admin/plugins/k8s-challenges", methods=["GET", "POST"])
    @admins_only
    def _admin():
        if request.method == "POST":
            u = (request.form.get("orchestrator_url") or "").strip()
            k = (request.form.get("api_key") or "").strip()
            for name, v in (("k8s_orchestrator_url", u), ("k8s_api_key", k)):
                r = Configs.query.filter_by(key=name).first()
                if r:
                    r.value = v
                else:
                    db.session.add(Configs(key=name, value=v))
            db.session.commit()
            return redirect(url_for("k8s_config._admin"))
        u = _get_config("k8s_orchestrator_url", "")
        k = _get_config("k8s_api_key", "")
        return render_template(
            "k8s_admin_config.html",
            orchestrator_url=u,
            api_key=k,
            csrf_token=generate_csrf(),
        )

    app.register_blueprint(bp)


def load(app):
    app.db.create_all()
    CHALLENGE_CLASSES["container"] = ContainerChallengeClass
    register_plugin_assets_directory(app, base_path="/plugins/k8s-challenges/assets/")
    _container_api(app)
    _admin_routes(app)
