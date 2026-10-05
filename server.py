#!/usr/bin/env python3
"""Mormors lilla röda — a small family cookbook server."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA = ROOT / "data" / "recipes.json"
UPLOADS = PUBLIC / "uploads"
PORT = int(os.environ.get("PORT", "8080"))
PASSWORD_FILE = ROOT / "data" / "password"
MAX_BODY = 8_000_000
EDITOR_TOKENS: dict[str, float] = {}
LOGIN_FAILURES: dict[str, list[float]] = {}
TOKEN_LOCK = threading.Lock()

CATEGORIES = ["Varmrätt", "Förrätt", "Soppa", "Bakverk", "Efterrätt", "Fika"]
YIELD_UNITS = ["portioner", "bitar", "bullar", "bollar", "stycken"]
LOCK = threading.Lock()

def esc(value: object) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def editor_password() -> str:
    from_env = os.environ.get("COOKBOOK_PASSWORD", "").strip()
    if from_env:
        return from_env
    if PASSWORD_FILE.is_file():
        return PASSWORD_FILE.read_text(encoding="utf-8").strip()
    return ""


def password_matches(given: object) -> bool:
    expected = editor_password()
    if not expected or not isinstance(given, str) or not given:
        return False
    return hmac.compare_digest(
        hashlib.sha256(expected.encode()).digest(),
        hashlib.sha256(given.encode()).digest(),
    )


def client_ip(handler: BaseHTTPRequestHandler) -> str:
    return handler.client_address[0]


def login_blocked(ip: str) -> bool:
    now = time.monotonic()
    with TOKEN_LOCK:
        recent = [stamp for stamp in LOGIN_FAILURES.get(ip, []) if now - stamp < 600]
        LOGIN_FAILURES[ip] = recent
        return len(recent) >= 8


def note_login_failure(ip: str) -> None:
    with TOKEN_LOCK:
        LOGIN_FAILURES.setdefault(ip, []).append(time.monotonic())


def issue_token() -> str:
    token = secrets.token_urlsafe(32)
    now = time.monotonic()
    with TOKEN_LOCK:
        expired = [key for key, stamp in EDITOR_TOKENS.items() if now - stamp > 60 * 60 * 12]
        for key in expired:
            del EDITOR_TOKENS[key]
        EDITOR_TOKENS[token] = now
    return token


def token_ok(header: str | None) -> bool:
    if not header or not header.startswith("Bearer "):
        return False
    token = header[7:].strip()
    if not token:
        return False
    now = time.monotonic()
    with TOKEN_LOCK:
        stamp = EDITOR_TOKENS.get(token)
        if stamp is None or now - stamp > 60 * 60 * 12:
            EDITOR_TOKENS.pop(token, None)
            return False
        EDITOR_TOKENS[token] = now
    return True


def load_recipes() -> list[dict]:
    return json.loads(DATA.read_text(encoding="utf-8"))


def write_recipes(recipes: list[dict]) -> None:
    temporary = DATA.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(recipes, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(DATA)


def find_recipe(recipes: list[dict], recipe_id: str) -> dict | None:
    return next((recipe for recipe in recipes if recipe.get("id") == recipe_id), None)


def slugify(title: str) -> str:
    text = title.lower().strip()
    for source, target in (("å", "a"), ("ä", "a"), ("ö", "o"), ("é", "e"), ("ü", "u")):
        text = text.replace(source, target)
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return (text[:48] or "recept")


def unique_id(recipes: list[dict], title: str) -> str:
    base = slugify(title)
    taken = {recipe.get("id") for recipe in recipes}
    if base not in taken:
        return base
    number = 2
    while f"{base}-{number}" in taken:
        number += 1
    return f"{base}-{number}"


def clean_text(value: object, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit].strip()


def whole_number(value: object, low: int, high: int) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < low or value > high:
        return None
    return value


def quantity(value: object) -> float | int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError
    number = round(float(value), 2)
    if number < 0 or number > 100000:
        raise ValueError
    if number.is_integer():
        return int(number)
    return number


def local_image(path: object) -> str:
    if not isinstance(path, str):
        return ""
    if ".." in path or "\\" in path or not path.startswith(("/images/", "/uploads/")):
        return ""
    return path


def save_upload(data_url: object) -> str | None:
    if not isinstance(data_url, str):
        return None
    match = re.fullmatch(r"data:image/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\s]+)", data_url, re.I)
    if not match:
        return None
    try:
        raw = base64.b64decode(match.group(1), validate=True)
    except ValueError:
        return None
    if len(raw) > 5_000_000:
        return None
    if raw.startswith(b"\xff\xd8\xff"):
        extension = "jpg"
    elif raw.startswith(b"\x89PNG\r\n\x1a\n"):
        extension = "png"
    elif raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        extension = "webp"
    else:
        return None
    UPLOADS.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}.{extension}"
    (UPLOADS / name).write_bytes(raw)
    return f"/uploads/{name}"


def remove_upload(url_path: str) -> None:
    if not url_path.startswith("/uploads/"):
        return
    candidate = (PUBLIC / url_path.lstrip("/")).resolve()
    try:
        candidate.relative_to(UPLOADS.resolve())
    except ValueError:
        return
    if candidate.is_file():
        candidate.unlink()


def build_recipe(data: dict, existing: dict | None, recipes: list[dict]) -> tuple[dict | None, str | None]:
    title = clean_text(data.get("title"), 80)
    if not title:
        return None, "Receptet behöver ett namn."
    category = data.get("category")
    if category not in CATEGORIES:
        return None, "Välj en kategori."
    summary = clean_text(data.get("summary"), 280)
    note = clean_text(data.get("note"), 600)
    credit = clean_text(data.get("credit"), 60)
    minutes = whole_number(data.get("minutes"), 1, 43200)
    servings = whole_number(data.get("servings"), 1, 200)
    if minutes is None:
        return None, "Skriv tiden i hela minuter."
    if servings is None:
        return None, "Skriv hur många det räcker till."
    yield_unit = data.get("yieldUnit") or "portioner"
    if yield_unit not in YIELD_UNITS:
        return None, "Välj hur antalet ska räknas."

    raw_ingredients = data.get("ingredients")
    if not isinstance(raw_ingredients, list) or len(raw_ingredients) > 40:
        return None, "Lägg till minst en ingrediens."
    ingredients = []
    for raw in raw_ingredients:
        if not isinstance(raw, dict):
            continue
        item = clean_text(raw.get("item"), 160)
        if not item:
            continue
        unit = clean_text(raw.get("unit"), 16)
        try:
            amount = quantity(raw.get("qty"))
        except ValueError:
            return None, "En mängd ser fel ut."
        ingredients.append({"qty": amount, "unit": unit, "item": item})
    if not ingredients:
        return None, "Lägg till minst en ingrediens."

    raw_steps = data.get("steps")
    if not isinstance(raw_steps, list) or len(raw_steps) > 30:
        return None, "Lägg till minst ett steg."
    steps = [clean_text(step, 1000) for step in raw_steps if clean_text(step, 1000)]
    if not steps:
        return None, "Lägg till minst ett steg."

    if data.get("imageData"):
        image = save_upload(data.get("imageData"))
        if not image:
            return None, "Bilden behöver vara en jpg, png eller webp."
        if existing:
            remove_upload(existing.get("image") or "")
    else:
        image = local_image(data.get("image"))

    recipe = {
        "id": existing["id"] if existing else unique_id(recipes, title),
        "title": title,
        "category": category,
        "summary": summary,
        "note": note,
        "credit": credit,
        "minutes": minutes,
        "servings": servings,
        "yieldUnit": yield_unit,
        "featured": bool(data.get("featured")),
        "image": image,
        "ingredients": ingredients,
        "steps": steps,
    }
    if existing:
        for key in ("photoCredit", "photoLicense", "photoHref"):
            if existing.get(key):
                recipe[key] = existing[key]
    return recipe, None


def lan_addresses() -> list[str]:
    hosts: list[str] = []
    try:
        output = subprocess.check_output(["ip", "-4", "-o", "addr", "show"], text=True, timeout=2)
    except (OSError, subprocess.SubprocessError):
        return hosts
    for line in output.splitlines():
        match = re.search(r"\binet (\d+\.\d+\.\d+\.\d+)/", line)
        if not match:
            continue
        ip = match.group(1)
        if ip.startswith("127."):
            continue
        hosts.append(ip)

    def rank(ip: str) -> tuple[int, str]:
        if ip.startswith(("192.168.", "10.")):
            return (0, ip)
        if ip.startswith("172."):
            return (1, ip)
        return (2, ip)

    return [f"http://{ip}:{PORT}" for ip in sorted(set(hosts), key=rank)[:2]]


def page_for(path: str, host: str) -> bytes:
    recipe = None
    match = re.fullmatch(r"/recept/([a-z0-9-]+)", path)
    if match:
        recipe = find_recipe(load_recipes(), match.group(1))
    if recipe:
        title = f"{recipe['title']} · Mormors lilla röda"
        description = recipe.get("summary") or "Ett recept ur Mormors lilla röda."
        image = recipe.get("image") or "/images/kottbullar.jpg"
    elif path == "/nytt":
        title = "Nytt recept · Mormors lilla röda"
        description = "Lägg till ett recept i familjens kokbok."
        image = "/images/kanelbullar.jpg"
    else:
        title = "Mormors lilla röda"
        description = "Familjens receptsamling, med bilder, mängder och anteckningar."
        image = "/images/kottbullar.jpg"
    html = (PUBLIC / "index.html").read_text(encoding="utf-8")
    html = html.replace("__TITLE__", esc(title))
    html = html.replace("__DESCRIPTION__", esc(description))
    html = html.replace("__IMAGE__", esc(f"http://{host}{image}"))
    html = html.replace("__URL__", esc(f"http://{host}{path or '/'}"))
    return html.encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "MormorsLillaRoda/1.0"

    def setup(self) -> None:
        super().setup()
        self.request.settimeout(60)

    def do_GET(self) -> None:
        path = unquote(urlparse(self.path).path)
        if path == "/favicon.ico":
            path = "/favicon.svg"
        page_path = path.rstrip("/") or "/"
        if path == "/api/recipes":
            self.send_json(load_recipes())
            return
        if path == "/api/info":
            self.send_json({"categories": CATEGORIES, "yieldUnits": YIELD_UNITS, "addresses": lan_addresses()})
            return
        match = re.fullmatch(r"/api/recipes/([a-z0-9-]+)", path)
        if match:
            recipe = find_recipe(load_recipes(), match.group(1))
            if not recipe:
                self.send_json({"error": "Receptet finns inte."}, 404)
                return
            self.send_json(recipe)
            return
        if path.startswith("/api/"):
            self.send_json({"error": "Finns inte."}, 404)
            return
        if re.fullmatch(r"/(?:nytt|recept/[a-z0-9-]+|redigera/[a-z0-9-]+)?", page_path):
            host = self.headers.get("Host", f"localhost:{PORT}")
            body = page_for(page_path, host)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_file(path)

    def editor_authorized(self) -> bool:
        return token_ok(self.headers.get("Authorization"))

    def require_editor(self) -> bool:
        if self.editor_authorized():
            return True
        self.send_json({"error": "Lösenord krävs för att ändra i boken."}, 401)
        return False

    def handle_login(self) -> None:
        data = self.read_json()
        if data is None:
            return
        ip = client_ip(self)
        if login_blocked(ip):
            self.send_json({"error": "För många försök. Vänta en stund och prova igen."}, 429)
            return
        if not password_matches(data.get("password")):
            note_login_failure(ip)
            self.send_json({"error": "Fel lösenord."}, 401)
            return
        self.send_json({"token": issue_token()})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/login":
            self.handle_login()
            return
        if path != "/api/recipes":
            self.send_json({"error": "Finns inte."}, 404)
            return
        if not self.require_editor():
            return
        data = self.read_json()
        if data is None:
            return

        def mutate(recipes: list[dict]) -> dict:
            recipe, error = build_recipe(data, None, recipes)
            if error:
                return {"error": error, "status": 400}
            if recipe["featured"]:
                for other in recipes:
                    other["featured"] = False
            recipes.append(recipe)
            return recipe

        self.mutate_and_reply(mutate)

    def do_PUT(self) -> None:
        match = re.fullmatch(r"/api/recipes/([a-z0-9-]+)", urlparse(self.path).path)
        if not match:
            self.send_json({"error": "Finns inte."}, 404)
            return
        data = self.read_json()
        if data is None:
            return
        if not self.require_editor():
            return
        recipe_id = match.group(1)

        def mutate(recipes: list[dict]) -> dict:
            existing = find_recipe(recipes, recipe_id)
            if not existing:
                return {"error": "Receptet finns inte.", "status": 404}
            recipe, error = build_recipe(data, existing, recipes)
            if error:
                return {"error": error, "status": 400}
            if recipe["featured"]:
                for other in recipes:
                    if other["id"] != recipe_id:
                        other["featured"] = False
            index = recipes.index(existing)
            recipes[index] = recipe
            return recipe

        self.mutate_and_reply(mutate)

    def do_DELETE(self) -> None:
        match = re.fullmatch(r"/api/recipes/([a-z0-9-]+)", urlparse(self.path).path)
        if not match:
            self.send_json({"error": "Finns inte."}, 404)
            return
        if not self.require_editor():
            return
        recipe_id = match.group(1)

        def mutate(recipes: list[dict]) -> dict:
            existing = find_recipe(recipes, recipe_id)
            if not existing:
                return {"error": "Receptet finns inte.", "status": 404}
            recipes.remove(existing)
            remove_upload(existing.get("image") or "")
            return {"ok": True}

        self.mutate_and_reply(mutate)

    def mutate_and_reply(self, mutator) -> None:
        with LOCK:
            recipes = load_recipes()
            result = mutator(recipes)
            status = result.pop("status", None) if isinstance(result, dict) and "status" in result else None
            if status:
                self.send_json(result, status)
                return
            write_recipes(recipes)
        self.send_json(result)

    def read_json(self) -> dict | None:
        length = self.headers.get("Content-Length")
        if length is None or not length.isdigit():
            self.send_json({"error": "Saknar innehåll."}, 411)
            return None
        size = int(length)
        if size > MAX_BODY:
            self.send_json({"error": "Det var för stort att spara."}, 413)
            return None
        try:
            data = json.loads(self.rfile.read(size).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json({"error": "Ogiltigt recept."}, 400)
            return None
        if not isinstance(data, dict):
            self.send_json({"error": "Ogiltigt recept."}, 400)
            return None
        return data

    def send_json(self, data: object, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, url_path: str) -> None:
        relative = url_path.lstrip("/")
        if not relative or relative.endswith("/"):
            self.send_plain(404, "Sidan finns inte.")
            return
        candidate = (PUBLIC / relative).resolve()
        try:
            candidate.relative_to(PUBLIC.resolve())
        except ValueError:
            self.send_plain(404, "Sidan finns inte.")
            return
        if not candidate.is_file():
            self.send_plain(404, "Sidan finns inte.")
            return
        content_type = {
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
            ".gif": "image/gif",
        }.get(candidate.suffix.lower(), "application/octet-stream")
        data = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        cache = "no-cache" if candidate.suffix.lower() in {".css", ".js", ".svg"} else "public, max-age=86400"
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def send_plain(self, status: int, message: str) -> None:
        body = message.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Server(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    DATA.parent.mkdir(parents=True, exist_ok=True)
    UPLOADS.mkdir(parents=True, exist_ok=True)
    if not DATA.exists():
        DATA.write_text("[]\n", encoding="utf-8")
    try:
        load_recipes()
    except json.JSONDecodeError as error:
        print(f"Could not read {DATA}: {error}", file=sys.stderr)
        sys.exit(1)
    try:
        server = Server(("0.0.0.0", PORT), Handler)
    except OSError as error:
        print(f"Could not open port {PORT}: {error}", file=sys.stderr)
        sys.exit(1)
    print("Mormors lilla röda is running.")
    print(f"  On this computer:  http://localhost:{PORT}")
    for address in lan_addresses():
        print(f"  On the same Wi-Fi: {address}")
    print("Leave this window open while the family is using the cookbook.")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()


if __name__ == "__main__":
    main()
