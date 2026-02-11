"""
CTFd plugin for Kubernetes container challenges.
Bridges CTFd (control plane) with the on‑prem Node.js orchestrator (data plane).

Provides two challenge types:
- container: Static value container challenges
- container-dynamic: Dynamic value container challenges (value decreases with solves)
"""
from __future__ import annotations

import math
import requests
from flask import redirect, render_template, request, url_for
from sqlalchemy import inspect
from CTFd.models import Challenges, Configs, Flags, Solves, db
from CTFd.plugins import register_plugin_assets_directory
from CTFd.plugins.challenges import BaseChallenge, CHALLENGE_CLASSES
from CTFd.utils import get_config
from CTFd.utils.decorators import admins_only, authed_only
from CTFd.utils.user import get_current_user

from .models import ContainerChallenge, ContainerDynamicChallenge

# Column names allowed when constructing/updating challenges
# Note: Dynamic challenge uses prefixed column names (container_initial, container_decay, etc.)
# but we map them via properties (initial, decay, etc.) so both work
_CONTAINER_CHALLENGE_COLUMNS = frozenset(
    c.key for c in inspect(ContainerChallenge).mapper.columns
)
_CONTAINER_DYNAMIC_CHALLENGE_COLUMNS = frozenset(
    c.key for c in inspect(ContainerDynamicChallenge).mapper.columns
)


def _to_int(val, default=None):
    """Coerce value to int for form/JSON; return default if empty or invalid."""
    if val is None or val == "":
        return default
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


# -----------------------------------------------------------------------------
# Static Container Challenge Type
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
        data = request.form or request.get_json()
        data = dict(data)
        
        # Merge ctfcli-style extra (e.g. image, port) into top-level
        extra = data.pop("extra", None) or {}
        if isinstance(extra, dict):
            data.update(extra)
        
        # Set challenge type
        data["type"] = "container"
        
        # Base challenge fields expected by CTFd
        data.setdefault("state", "visible")
        data.setdefault("logic", "any")
        
        # Coerce numeric fields (form sends strings)
        if "value" in data:
            data["value"] = _to_int(data["value"])
        if "port" in data:
            data["port"] = _to_int(data["port"], default=80)
        if "timeout" in data:
            data["timeout"] = _to_int(data["timeout"], default=3600)
        
        # Clean up image
        if "image" in data:
            data["image"] = (data.get("image") or "").strip()

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
            "logic": getattr(challenge, "logic", "any"),
            "max_attempts": challenge.max_attempts,
            "type": challenge.type,
            "type_data": {
                "id": cls.id,
                "name": cls.name,
                "templates": cls.templates,
                "scripts": cls.scripts,
            },
            "image": getattr(row, "image", ""),
            "port": getattr(row, "port", 80),
            "command": getattr(row, "command", ""),
            "connection_type": getattr(row, "connection_type", "http"),
            "prefix": getattr(row, "prefix", ""),
            "memory_limit": getattr(row, "memory_limit", "256Mi"),
            "cpu_limit": getattr(row, "cpu_limit", ""),
            "timeout": getattr(row, "timeout", 3600),
        }
        return data

    @classmethod
    def update(cls, challenge, request):
        data = request.form or request.get_json() or {}
        data = dict(data)
        extra = data.pop("extra", None) or {}
        if isinstance(extra, dict):
            data.update(extra)

        container = ContainerChallenge.query.filter_by(id=challenge.id).first()
        if not container:
            return challenge

        container_keys = (
            "image", "port", "command", "connection_type", "prefix", "cpu_limit", "memory_limit", "timeout",
        )
        if "image" in data and (data.get("image") or "").strip():
            container.image = (data["image"] or "").strip()
        for k in ("command", "connection_type", "prefix", "cpu_limit", "memory_limit"):
            if k in data:
                setattr(container, k, data[k])
        if "port" in data:
            container.port = _to_int(data["port"], default=80)
        if "timeout" in data:
            container.timeout = _to_int(data["timeout"], default=3600)

        # Only update base challenge attributes that are actual columns (avoid flags/tags/etc.)
        for k, v in data.items():
            if k not in container_keys and k in _CONTAINER_CHALLENGE_COLUMNS and k != "id":
                if k in ("value", "max_attempts"):
                    v = _to_int(v)
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


# -----------------------------------------------------------------------------
# Dynamic Container Challenge Type
# -----------------------------------------------------------------------------


class ContainerDynamicChallengeClass(BaseChallenge):
    id = "container-dynamic"
    name = "container-dynamic"
    templates = {
        "create": "/plugins/k8s-challenges/assets/create-dynamic.html",
        "update": "/plugins/k8s-challenges/assets/update-dynamic.html",
        "view": "/plugins/k8s-challenges/assets/view-dynamic.html",
    }
    scripts = {
        "create": "/plugins/k8s-challenges/assets/create-dynamic.js",
        "update": "/plugins/k8s-challenges/assets/update-dynamic.js",
        "view": "/plugins/k8s-challenges/assets/view-dynamic.js",
    }
    challenge_model = ContainerDynamicChallenge

    @classmethod
    def calculate_value(cls, challenge):
        """Calculate the current value based on solve count and decay function."""
        row = ContainerDynamicChallenge.query.filter_by(id=challenge.id).first()
        if not row:
            return challenge

        solve_count = Solves.query.filter_by(challenge_id=challenge.id).count()
        initial = row.initial_value
        minimum = row.minimum_value
        decay = max(1, int(row.decay))
        function = row.decay_function or "linear"

        if function == "logarithmic":
            # Logarithmic decay: (((Minimum - Initial) / (Decay²)) × (SolveCount²)) + Initial
            v = (((minimum - initial) / (decay * decay)) * (solve_count * solve_count)) + initial
            value = max(int(math.ceil(v)), minimum)
        else:
            # Linear decay: Initial - (Decay × SolveCount)
            v = initial - (decay * solve_count)
            value = max(int(v), minimum)

        challenge.value = value
        db.session.commit()
        return challenge

    @classmethod
    def create(cls, request):
        data = request.form or request.get_json()
        data = dict(data)
        
        # Merge ctfcli-style extra (e.g. image, port) into top-level
        extra = data.pop("extra", None) or {}
        if isinstance(extra, dict):
            data.update(extra)
        
        # Set challenge type
        data["type"] = "container-dynamic"
        
        # Base challenge fields expected by CTFd
        data.setdefault("state", "visible")
        data.setdefault("logic", "any")
        
        # Coerce numeric fields (form sends strings)
        if "initial_value" in data:
            data["initial_value"] = _to_int(data["initial_value"])
        elif "initial" in data:
            data["initial_value"] = _to_int(data["initial"])
        
        if "decay" in data:
            data["decay"] = _to_int(data["decay"])
        
        if "minimum_value" in data:
            data["minimum_value"] = _to_int(data["minimum_value"])
        elif "minimum" in data:
            data["minimum_value"] = _to_int(data["minimum"])
        
        if "decay_function" in data and data["decay_function"] not in ("linear", "logarithmic"):
            data["decay_function"] = "linear"
        
        if "port" in data:
            data["port"] = _to_int(data["port"], default=80)
        if "timeout" in data:
            data["timeout"] = _to_int(data["timeout"], default=3600)
        
        # Clean up image
        if "image" in data:
            data["image"] = (data.get("image") or "").strip()

        challenge = cls.challenge_model(**data)
        db.session.add(challenge)
        db.session.commit()
        
        return cls.calculate_value(challenge)

    @classmethod
    def read(cls, challenge):
        row = ContainerDynamicChallenge.query.filter_by(id=challenge.id).first()
        if not row:
            row = challenge

        # Calculate current value based on solves
        solve_count = Solves.query.filter_by(challenge_id=challenge.id).count()
        initial = row.initial_value
        minimum = row.minimum_value
        decay = max(1, int(row.decay))
        function = row.decay_function or "linear"

        if function == "logarithmic":
            v = (((minimum - initial) / (decay * decay)) * (solve_count * solve_count)) + initial
            value = max(int(math.ceil(v)), minimum)
        else:
            v = initial - (decay * solve_count)
            value = max(int(v), minimum)

        data = {
            "id": challenge.id,
            "name": challenge.name,
            "value": value,
            "description": challenge.description,
            "connection_info": challenge.connection_info,
            "category": challenge.category,
            "state": challenge.state,
            "logic": getattr(challenge, "logic", "any"),
            "max_attempts": challenge.max_attempts,
            "type": challenge.type,
            "type_data": {
                "id": cls.id,
                "name": cls.name,
                "templates": cls.templates,
                "scripts": cls.scripts,
            },
            "image": getattr(row, "image", ""),
            "port": getattr(row, "port", 80),
            "command": getattr(row, "command", ""),
            "connection_type": getattr(row, "connection_type", "http"),
            "prefix": getattr(row, "prefix", ""),
            "memory_limit": getattr(row, "memory_limit", "256Mi"),
            "cpu_limit": getattr(row, "cpu_limit", ""),
            "timeout": getattr(row, "timeout", 3600),
            "initial_value": initial,
            "decay_function": function,
            "decay": row.decay,
            "minimum_value": minimum,
        }
        return data

    @classmethod
    def update(cls, challenge, request):
        from CTFd.exceptions.challenges import ChallengeUpdateException
        
        data = request.form or request.get_json() or {}
        data = dict(data)
        extra = data.pop("extra", None) or {}
        if isinstance(extra, dict):
            data.update(extra)

        container = ContainerDynamicChallenge.query.filter_by(id=challenge.id).first()
        if not container:
            return challenge

        container_keys = (
            "image", "port", "command", "connection_type", "prefix", "cpu_limit", "memory_limit", "timeout",
            "initial_value", "decay_function", "decay", "minimum_value",
        )
        
        # Update container-specific fields
        if "image" in data and (data.get("image") or "").strip():
            container.image = (data["image"] or "").strip()
        for k in ("command", "connection_type", "prefix", "cpu_limit", "memory_limit"):
            if k in data:
                setattr(container, k, data[k])
        if "port" in data:
            container.port = _to_int(data["port"], default=80)
        if "timeout" in data:
            container.timeout = _to_int(data["timeout"], default=3600)

        # Update dynamic value fields
        for k in ("initial_value", "decay", "minimum_value"):
            if k in data:
                try:
                    value = _to_int(data.get(k))
                    if value is not None:
                        setattr(container, k, value)
                except (ValueError, TypeError):
                    raise ChallengeUpdateException(f"Invalid input for '{k}'")
        
        if "decay_function" in data and data["decay_function"] in ("linear", "logarithmic"):
            container.decay_function = data["decay_function"]

        # Update base challenge value to initial_value if changed
        if "initial_value" in data:
            challenge.value = container.initial_value

        # Only update base challenge attributes that are actual columns
        for k, v in data.items():
            if k not in container_keys and k in _CONTAINER_DYNAMIC_CHALLENGE_COLUMNS and k != "id":
                if k in ("value", "max_attempts"):
                    v = _to_int(v)
                setattr(challenge, k, v)
        
        db.session.commit()
        return cls.calculate_value(challenge)

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
        ContainerDynamicChallenge.query.filter_by(id=challenge.id).delete()
        Challenges.query.filter_by(id=challenge.id).delete()
        db.session.commit()

    @classmethod
    def solve(cls, user, team, challenge, request):
        """Override solve to recalculate value after a solve."""
        super().solve(user, team, challenge, request)
        cls.calculate_value(challenge)


# -----------------------------------------------------------------------------
# Helper functions for orchestrator communication
# -----------------------------------------------------------------------------


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


def _get_challenge_data(challenge_id):
    """Get challenge data regardless of type (container or container-dynamic)."""
    # Try static first
    row = ContainerChallenge.query.filter_by(id=challenge_id).first()
    if row:
        return row
    # Try dynamic
    row = ContainerDynamicChallenge.query.filter_by(id=challenge_id).first()
    return row


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
        
        row = _get_challenge_data(int(cid))
        if not row or row.type not in ("container", "container-dynamic"):
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
            "env_vars": {"FLAG": flag_val},
        }
        
        # Add cpu_limit only if it's set
        if row.cpu_limit:
            body["cpu_limit"] = row.cpu_limit
        
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

    bp = Blueprint("k8s_config", __name__, template_folder="templates")

    @bp.route("/admin/plugins/k8s-challenges", methods=["GET", "POST"])
    @admins_only
    def _admin():
        if request.method == "POST":
            # Save all configuration values
            config_mapping = {
                "k8s_orchestrator_url": (request.form.get("orchestrator_url") or "").strip(),
                "k8s_api_key": (request.form.get("api_key") or "").strip(),
                "k8s_domain_suffix": (request.form.get("domain_suffix") or "").strip(),
                "k8s_tcp_port_range": (request.form.get("tcp_port_range") or "").strip(),
                "k8s_max_containers_global": request.form.get("max_containers_global", "100"),
                "k8s_max_containers_per_team": request.form.get("max_containers_per_team", "5"),
            }
            
            for name, value in config_mapping.items():
                r = Configs.query.filter_by(key=name).first()
                if r:
                    r.value = value
                else:
                    db.session.add(Configs(key=name, value=value))
            db.session.commit()
            return redirect(url_for("k8s_config._admin"))
        
        # GET request - load current values
        return render_template(
            "k8s_admin_config.html",
            orchestrator_url=_get_config("k8s_orchestrator_url", ""),
            api_key=_get_config("k8s_api_key", ""),
            domain_suffix=_get_config("k8s_domain_suffix", ".sillyctf-challenges.psuccso.org"),
            tcp_port_range=_get_config("k8s_tcp_port_range", "30000-32767"),
            max_containers_global=_get_config("k8s_max_containers_global", "100"),
            max_containers_per_team=_get_config("k8s_max_containers_per_team", "5"),
        )

    @bp.route("/admin/plugins/k8s-challenges/test-connection", methods=["GET"])
    @admins_only
    def _test_connection():
        """Test connection to orchestrator using provided or saved credentials."""
        from flask import jsonify
        
        # Get URL and API key from query params (for testing unsaved values) or from config
        orchestrator_url = (request.args.get("orchestrator_url") or "").strip()
        api_key = (request.args.get("api_key") or "").strip()
        
        # Fall back to saved config if not provided
        if not orchestrator_url:
            orchestrator_url = _get_config("k8s_orchestrator_url", "").rstrip("/")
        else:
            orchestrator_url = orchestrator_url.rstrip("/")
        
        if not api_key:
            api_key = _get_config("k8s_api_key", "")
        
        if not orchestrator_url:
            return jsonify({"success": False, "error": "Orchestrator URL not configured"}), 400
        
        # Test connection by calling /health endpoint
        url = f"{orchestrator_url}/health"
        headers = {}
        if api_key:
            headers["X-API-KEY"] = api_key
        
        try:
            r = requests.get(url, headers=headers, timeout=10)
            if r.status_code == 200:
                response_data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
                return jsonify({
                    "success": True,
                    "message": "Connection successful",
                    "status_code": r.status_code,
                    "response": response_data
                })
            else:
                error_msg = r.text or f"HTTP {r.status_code}"
                return jsonify({
                    "success": False,
                    "error": f"Connection failed: {error_msg}",
                    "status_code": r.status_code
                }), 400
        except requests.exceptions.Timeout:
            return jsonify({"success": False, "error": "Connection timeout - orchestrator did not respond within 10 seconds"}), 400
        except requests.exceptions.ConnectionError as e:
            return jsonify({"success": False, "error": f"Connection error: {str(e)}"}), 400
        except Exception as e:
            return jsonify({"success": False, "error": f"Unexpected error: {str(e)}"}), 500

    app.register_blueprint(bp)


def load(app):
    app.db.create_all()
    CHALLENGE_CLASSES["container"] = ContainerChallengeClass
    CHALLENGE_CLASSES["container-dynamic"] = ContainerDynamicChallengeClass
    register_plugin_assets_directory(app, base_path="/plugins/k8s-challenges/assets/")
    _container_api(app)
    _admin_routes(app)
