import base64
import io
import json
import os
import re
import sqlite3
import subprocess
import threading
import time
import unicodedata
from collections import Counter
from pathlib import Path
from typing import List, Optional

import requests
from yt_dlp import YoutubeDL
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

APP_DIR = Path(__file__).resolve().parent
DB_PATH = str(APP_DIR / "db" / "otaku.db")
CANCEL_FILE = str(APP_DIR / ".fetch_cancel_bulk")

# ---------------------------------------------------------------------------
# Data directory resolution
# ---------------------------------------------------------------------------
# Where the archive stores its media (covers, banners, headers, trailers,
# gallery, people/character portraits) and music is resolved from, in order:
#   1. environment variables  OTAKU_DATA_DIR / OTAKU_MUSIC_DIR
#   2. the config file        <install>/.otaku_archive.conf   (see Otaku_Archive.py)
#   3. a portable default     <install>/data   and   <install>/data/music
CONFIG_FILE = str(APP_DIR / ".otaku_archive.conf")


def load_config() -> dict:
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


_config = load_config()

DATA_DIR = os.path.abspath(
    os.environ.get("OTAKU_DATA_DIR")
    or _config.get("data_dir")
    or str(APP_DIR / "data")
)
MUSIC_DIR = os.path.abspath(
    os.environ.get("OTAKU_MUSIC_DIR")
    or _config.get("music_dir")
    or os.path.join(DATA_DIR, "music")
)

COVERS_DIR = os.path.join(DATA_DIR, "covers")
BANNERS_DIR = os.path.join(DATA_DIR, "banners")
METADATA_DIR = os.path.join(DATA_DIR, "metadata")
HEADERS_DIR = os.path.join(DATA_DIR, "headers")
TRAILERS_DIR = os.path.join(DATA_DIR, "trailers")
GALLERY_DIR = os.path.join(DATA_DIR, "gallery")
PEOPLE_DIR = os.path.join(DATA_DIR, "people")
CHARACTERS_DIR = os.path.join(DATA_DIR, "characters")
_MUSIC_ROOT_REAL = os.path.realpath(MUSIC_DIR)

os.makedirs(COVERS_DIR, exist_ok=True)
os.makedirs(BANNERS_DIR, exist_ok=True)
os.makedirs(METADATA_DIR, exist_ok=True)
os.makedirs(HEADERS_DIR, exist_ok=True)
os.makedirs(TRAILERS_DIR, exist_ok=True)
os.makedirs(GALLERY_DIR, exist_ok=True)
os.makedirs(PEOPLE_DIR, exist_ok=True)
os.makedirs(CHARACTERS_DIR, exist_ok=True)
os.makedirs(MUSIC_DIR, exist_ok=True)
os.makedirs(str(APP_DIR / "theme_images"), exist_ok=True)
os.makedirs(str(APP_DIR / "db"), exist_ok=True)

BANNER_WIDTH = 1920
DEFAULT_TITLE = "Otaku Archive"
DEFAULT_SUBTITLE = "anime & manga, corner to corner"
ANILIST_URL = "https://graphql.anilist.co"
DEFAULT_HEADERS = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "User-Agent": "OtakuArchive/1.0 (personal anime & manga tracker)",
}
REQUEST_TIMEOUT = 30
IMAGE_TIMEOUT = 15

app = FastAPI(title="Anime & Manga Archive API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/covers", StaticFiles(directory=COVERS_DIR), name="covers")
app.mount("/banners", StaticFiles(directory=BANNERS_DIR), name="banners")
app.mount("/headers", StaticFiles(directory=HEADERS_DIR), name="headers")
app.mount("/trailers", StaticFiles(directory=TRAILERS_DIR), name="trailers")
app.mount("/gallery", StaticFiles(directory=GALLERY_DIR), name="gallery")
app.mount("/people", StaticFiles(directory=PEOPLE_DIR), name="people")
app.mount("/characters", StaticFiles(directory=CHARACTERS_DIR), name="characters")
app.mount("/theme_images", StaticFiles(directory=str(APP_DIR / "theme_images")), name="theme_images")
app.mount("/ico", StaticFiles(directory=str(APP_DIR / "ico")), name="ico")


# ---------------------------------------------------------------------------
# Settings (DB-backed with defaults)
# ---------------------------------------------------------------------------

def get_setting(key: str, default: str = "") -> str:
    try:
        conn = sqlite3.connect(DB_PATH)
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        conn.close()
        return row[0] if row else default
    except Exception:
        return default


def set_setting(key: str, value: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    conn.commit()
    conn.close()


def delete_setting(key: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM settings WHERE key = ?", (key,))
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Cancel mechanism for bulk fetches
# ---------------------------------------------------------------------------

def set_fetch_cancel(cancel: bool):
    if cancel:
        Path(CANCEL_FILE).touch()
    else:
        try:
            os.remove(CANCEL_FILE)
        except FileNotFoundError:
            pass


def is_fetch_cancelled() -> bool:
    return os.path.exists(CANCEL_FILE)


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _exec_write(cur, sql, params=(), retries: int = 3):
    for attempt in range(retries):
        try:
            cur.execute(sql, params)
            return
        except sqlite3.OperationalError as e:
            if "database is locked" in str(e) and attempt < retries - 1:
                time.sleep(0.3)
            else:
                raise


def init_db():
    conn = get_conn()
    cur = conn.cursor()
    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL DEFAULT 'anime',
            title TEXT NOT NULL,
            alt_titles TEXT DEFAULT '',
            type TEXT DEFAULT '',
            genres TEXT DEFAULT '',
            description TEXT DEFAULT '',
            cover_url TEXT DEFAULT '',
            banner_url TEXT DEFAULT '',
            studio TEXT DEFAULT '',
            season_year INTEGER,
            season TEXT DEFAULT '',
            episode_count INTEGER DEFAULT 0,
            chapter_count INTEGER DEFAULT 0,
            volume_count INTEGER DEFAULT 0,
            duration INTEGER DEFAULT 0,
            anilist_id INTEGER,
            mal_id INTEGER,
            trailer_site TEXT DEFAULT '',
            trailer_id TEXT DEFAULT '',
            trailer_file TEXT DEFAULT '',
            metadata_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_media_anilist ON media(anilist_id) WHERE anilist_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS media_status (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id INTEGER NOT NULL UNIQUE,
            is_favorite INTEGER DEFAULT 0,
            is_watching INTEGER DEFAULT 0,
            plan_to_watch INTEGER DEFAULT 0,
            is_completed INTEGER DEFAULT 0,
            is_dropped INTEGER DEFAULT 0,
            is_on_hold INTEGER DEFAULT 0,
            personal_score REAL,
            started_at TEXT,
            completed_at TEXT,
            notes TEXT DEFAULT '',
            FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id INTEGER NOT NULL,
            number INTEGER NOT NULL,
            title TEXT DEFAULT '',
            kind TEXT DEFAULT 'episode',
            is_done INTEGER DEFAULT 0,
            done_at TEXT,
            notes TEXT DEFAULT '',
            UNIQUE(media_id, kind, number),
            FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS people (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            native_name TEXT DEFAULT '',
            image_url TEXT DEFAULT '',
            anilist_id INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_people_anilist ON people(anilist_id);

        CREATE TABLE IF NOT EXISTS credits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id INTEGER NOT NULL,
            person_id INTEGER NOT NULL,
            kind TEXT DEFAULT 'staff',
            role TEXT DEFAULT '',
            language TEXT DEFAULT '',
            vo_actor_id INTEGER,
            character_role TEXT DEFAULT '',
            position INTEGER DEFAULT 0,
            FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE,
            FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_credits_media ON credits(media_id);

        CREATE TABLE IF NOT EXISTS franchises (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            description TEXT DEFAULT '',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS franchise_media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            franchise_id INTEGER NOT NULL,
            media_id INTEGER NOT NULL,
            position INTEGER NOT NULL,
            FOREIGN KEY(franchise_id) REFERENCES franchises(id) ON DELETE CASCADE,
            FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE,
            UNIQUE(franchise_id, media_id)
        );
        CREATE INDEX IF NOT EXISTS idx_franchise_media_franchise ON franchise_media(franchise_id);

        CREATE TABLE IF NOT EXISTS collections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            description TEXT DEFAULT '',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS collection_media (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            collection_id INTEGER NOT NULL,
            media_id INTEGER NOT NULL,
            FOREIGN KEY(collection_id) REFERENCES collections(id) ON DELETE CASCADE,
            FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE,
            UNIQUE(collection_id, media_id)
        );

        CREATE TABLE IF NOT EXISTS recently_viewed (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id INTEGER NOT NULL UNIQUE,
            viewed_at TEXT NOT NULL,
            FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS media_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id INTEGER NOT NULL,
            file_url TEXT NOT NULL,
            width INTEGER DEFAULT 0,
            height INTEGER DEFAULT 0,
            position INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_media_images_media ON media_images(media_id);

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )
    conn.commit()
    conn.close()


def run_migrations():
    """Add columns/tables that don't exist yet (safe on existing databases)."""
    conn = get_conn()
    cur = conn.cursor()
    cols = {r["name"] for r in cur.execute("PRAGMA table_info(media)").fetchall()}
    for col, decl in [
        ("trailer_site", "TEXT DEFAULT ''"),
        ("trailer_id", "TEXT DEFAULT ''"),
        ("trailer_file", "TEXT DEFAULT ''"),
        ("banner_pos", "INTEGER DEFAULT 50"),
        ("season_episodes", "TEXT DEFAULT ''"),
    ]:
        if col not in cols:
            _exec_write(cur, f"ALTER TABLE media ADD COLUMN {col} {decl}")
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS media_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            media_id INTEGER NOT NULL,
            file_url TEXT NOT NULL,
            width INTEGER DEFAULT 0,
            height INTEGER DEFAULT 0,
            position INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE
        )
        """
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_media_images_media ON media_images(media_id)")
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS media_music (
            media_id INTEGER PRIMARY KEY,
            music_path TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE
        )
        """
    )
    pcols = {r["name"] for r in cur.execute("PRAGMA table_info(people)").fetchall()}
    for col, decl in [
        ("image_pos_x", "INTEGER DEFAULT 50"),
        ("image_pos_y", "INTEGER DEFAULT 50"),
        ("bio", "TEXT DEFAULT ''"),
        ("birth_date", "TEXT DEFAULT ''"),
        ("nationality", "TEXT DEFAULT ''"),
    ]:
        if col not in pcols:
            _exec_write(cur, f"ALTER TABLE people ADD COLUMN {col} {decl}")
    ccols = {r["name"] for r in cur.execute("PRAGMA table_info(credits)").fetchall()}
    for col, decl in [
        ("character_image", "TEXT DEFAULT ''"),
        ("character_pos_x", "INTEGER DEFAULT 50"),
        ("character_pos_y", "INTEGER DEFAULT 50"),
    ]:
        if col not in ccols:
            _exec_write(cur, f"ALTER TABLE credits ADD COLUMN {col} {decl}")
    # Convert legacy AniList-style cast rows (character stored as its own "person"):
    # character info now lives on the credit row, and the credited person is the VA.
    legacy = cur.execute(
        "SELECT c.id, c.person_id, c.vo_actor_id, p.image_url "
        "FROM credits c JOIN people p ON p.id = c.person_id "
        "WHERE c.kind='cast' AND c.vo_actor_id IS NOT NULL AND c.vo_actor_id != c.person_id"
    ).fetchall()
    for lg in legacy:
        _exec_write(
            cur,
            "UPDATE credits SET person_id=?, vo_actor_id=NULL, "
            "character_image=CASE WHEN character_image='' THEN ? ELSE character_image END "
            "WHERE id=?",
            (lg["vo_actor_id"], lg["image_url"], lg["id"]),
        )
    conn.commit()
    conn.close()


def _music_root_real() -> str:
    return _MUSIC_ROOT_REAL


# ---------------------------------------------------------------------------
# Text normalization
# ---------------------------------------------------------------------------

def strip_combining(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c))


def normalize_title(raw: str) -> str:
    if not raw:
        return ""
    t = strip_combining(raw.lower())
    t = unicodedata.normalize("NFC", t)
    t = re.sub(r"[éèêë]", "e", t)
    t = re.sub(r"[àâäãá]", "a", t)
    t = re.sub(r"[ìîïí]", "i", t)
    t = re.sub(r"[òôöõó]", "o", t)
    t = re.sub(r"[ùûüú]", "u", t)
    t = re.sub(r"[ñ]", "n", t)
    t = re.sub(r"[ç]", "c", t)
    t = re.sub(r"['’`´]", "", t)
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


YOUTUBE_ID_RE = re.compile(
    r"(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed/|shorts/|live/)|youtu\.be/)([A-Za-z0-9_-]{6,})"
)


def parse_trailer_url(url: str) -> tuple:
    """Return (site, id) for a trailer URL. Supports YouTube links or a bare video id."""
    url = (url or "").strip()
    if not url:
        return "", ""
    m = YOUTUBE_ID_RE.search(url)
    if m:
        return "youtube", m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{6,}", url):
        return "youtube", url
    return "", ""


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class HealthResponse(BaseModel):
    status: str
    title: str
    subtitle: str


class MediaBase(BaseModel):
    category: str = "anime"
    title: str
    type: str = ""
    genres: str = ""
    description: str = ""
    alt_titles: str = ""
    studio: str = ""
    season_year: Optional[int] = None
    season: str = ""
    episode_count: int = 0
    chapter_count: int = 0
    volume_count: int = 0
    duration: int = 0


class MediaUpdate(MediaBase):
    category: str = "anime"
    trailer_url: str = ""   # optional; parsed to site+id by frontend, cleared when empty
    season_counts: Optional[List[int]] = None  # per-season episode counts (anime only)


class AddBulkRequest(BaseModel):
    category: str = "anime"
    titles: List[str]


class MediaListItem(BaseModel):
    id: int
    category: str
    title: str
    type: str
    genres: str
    cover_url: str
    banner_url: str
    season_year: Optional[int]
    episode_count: int
    chapter_count: int
    volume_count: int
    duration: int
    is_favorite: int
    is_watching: int
    plan_to_watch: int
    is_completed: int
    is_dropped: int
    is_on_hold: int
    personal_score: Optional[float]
    metadata_json: Optional[str]
    done_count: int
    total_entries: int


class MediaDetail(MediaListItem):
    alt_titles: str
    description: str
    studio: str
    season: str
    anilist_id: Optional[int]
    mal_id: Optional[int]
    trailer_site: str = ""
    trailer_id: str = ""
    trailer_file: str = ""
    banner_pos: int = 50
    season_episodes: List[int] = []
    started_at: Optional[str]
    completed_at: Optional[str]
    notes: str
    created_at: str
    updated_at: str


class EntryItem(BaseModel):
    id: int
    media_id: int
    number: int
    kind: str
    title: str
    is_done: int
    done_at: Optional[str]
    notes: str


class EntryUpdate(BaseModel):
    title: str = ""
    is_done: Optional[int] = None
    notes: str = ""


class MusicPathRequest(BaseModel):
    path: str = ""


class StatusUpdate(BaseModel):
    is_favorite: Optional[int] = None
    is_watching: Optional[int] = None
    plan_to_watch: Optional[int] = None
    is_completed: Optional[int] = None
    is_dropped: Optional[int] = None
    is_on_hold: Optional[int] = None
    personal_score: Optional[float] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    notes: Optional[str] = None


class PersonCreate(BaseModel):
    name: str
    native_name: str = ""
    image_url: str = ""
    anilist_id: Optional[int] = None


class CreditCreate(BaseModel):
    person_id: Optional[int] = None
    name: str = ""
    native_name: str = ""
    image_url: str = ""
    image_pos_x: Optional[int] = None
    image_pos_y: Optional[int] = None
    anilist_id: Optional[int] = None
    kind: str = "staff"
    role: str = ""
    language: str = ""
    character_image: str = ""
    character_pos_x: int = 50
    character_pos_y: int = 50
    character_role: str = ""
    vo_actor_id: Optional[int] = None
    va_actor_name: str = ""
    position: int = 0


class CreditUpdate(BaseModel):
    kind: Optional[str] = None
    role: Optional[str] = None
    language: Optional[str] = None
    character_image: Optional[str] = None
    character_pos_x: Optional[int] = None
    character_pos_y: Optional[int] = None
    character_role: Optional[str] = None
    position: Optional[int] = None
    person_id: Optional[int] = None
    va_actor_name: Optional[str] = None


class FranchiseCreate(BaseModel):
    name: str
    description: str = ""


class CollectionCreate(BaseModel):
    name: str
    description: str = ""


class CoverFromUrl(BaseModel):
    url: str


class ImageUrls(BaseModel):
    urls: List[str]


class ApplyMetadata(BaseModel):
    anilist_id: int


class ApiKeyRequest(BaseModel):
    value: str


class DefaultSourceRequest(BaseModel):
    cover_source: str = "anilist"
    screenshot_source: str = "anilist"


# ---------------------------------------------------------------------------
# Image helpers
# ---------------------------------------------------------------------------

def download_image(url: str) -> Optional[object]:
    if not url:
        return None
    try:
        r = requests.get(url, timeout=IMAGE_TIMEOUT, headers={"User-Agent": "OtakuArchive/1.0"})
        if r.status_code != 200:
            return None
        img = Image.open(io.BytesIO(r.content))
        img.load()
        return img
    except Exception:
        return None


def save_resized_cover(img, media_id: int) -> Optional[str]:
    try:
        img = img.convert("RGB")
        path = os.path.join(COVERS_DIR, f"{media_id}.jpg")
        img.save(path, "JPEG", quality=90)
        return f"/covers/{media_id}.jpg"
    except Exception:
        return None


def save_resized_banner(img, media_id: int) -> Optional[str]:
    try:
        img = img.convert("RGB")
        if img.width > BANNER_WIDTH:
            ratio = BANNER_WIDTH / img.width
            img = img.resize((BANNER_WIDTH, int(img.height * ratio)), Image.LANCZOS)
        path = os.path.join(BANNERS_DIR, f"{media_id}.jpg")
        img.save(path, "JPEG", quality=85)
        return f"/banners/{media_id}.jpg"
    except Exception:
        return None


# ---------------------------------------------------------------------------
# AniList client
# ---------------------------------------------------------------------------

def anilist_request(query: str, variables: dict) -> Optional[dict]:
    time.sleep(0.08)
    try:
        r = requests.post(
            ANILIST_URL,
            json={"query": query, "variables": variables},
            headers=DEFAULT_HEADERS,
            timeout=REQUEST_TIMEOUT,
        )
        if r.status_code != 200:
            return None
        data = r.json()
        if "errors" in data:
            return None
        return data.get("data")
    except Exception:
        return None


SEARCH_QUERY = """
query ($search: String, $type: MediaType, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(search: $search, type: $type) {
      id
      type
      format
      title { romaji english native }
      coverImage { extraLarge }
      bannerImage
      seasonYear
      episodes
      chapters
      volumes
    }
  }
}
"""

DETAIL_QUERY = """
query ($id: Int) {
  Media(id: $id) {
    id
    idMal
    type
    format
    title { romaji english native }
    description(asHtml: false)
    averageScore
    status
    episodes
    chapters
    volumes
    duration
    coverImage { extraLarge large }
    bannerImage
    trailer { site id thumbnail }
    seasonYear
    season
    genres
    tags { name }
    studios(isMain: true) { nodes { name } }
    staff(perPage: 60) {
      edges {
        role
        node { id name { full native } image { large } }
      }
    }
    characters(perPage: 40, sort: ROLE) {
      edges {
        role
        node { id name { full native } image { large } }
        voiceActors(language: JAPANESE) {
          id name { full native } image { large } languageV2
        }
      }
    }
    startDate { year month day }
    relations {
      edges {
        relationType
        node {
          id
          type
          format
          episodes
          seasonYear
          startDate { year month day }
          title { romaji english native }
        }
      }
    }
  }
}
"""


def anilist_search(title: str, category: str, per_page: int = 8) -> List[dict]:
    node_type = "ANIME" if category == "anime" else "MANGA"
    data = anilist_request(SEARCH_QUERY, {"search": title, "type": node_type, "perPage": per_page})
    if not data or not data.get("Page"):
        return []
    results = []
    for m in data["Page"].get("media", []):
        t = m.get("title") or {}
        results.append(
            {
                "anilist_id": m["id"],
                "title": t.get("romaji") or t.get("english") or t.get("native") or "",
                "alt_titles": ", ".join([x for x in [t.get("english"), t.get("native")] if x]),
                "type": (m.get("format") or "").title(),
                "cover_url": (m.get("coverImage") or {}).get("extraLarge") or "",
                "banner_url": m.get("bannerImage") or "",
                "season_year": m.get("seasonYear"),
                "episode_count": m.get("episodes") or 0,
                "chapter_count": m.get("chapters") or 0,
                "volume_count": m.get("volumes") or 0,
            }
        )
    return results


def anilist_detail(anilist_id: int) -> Optional[dict]:
    data = anilist_request(DETAIL_QUERY, {"id": anilist_id})
    if not data or not data.get("Media"):
        return None
    m = data["Media"]
    t = m.get("title") or {}
    genres = m.get("genres") or []
    tags = [x["name"] for x in (m.get("tags") or []) if x.get("name")]
    staff_nodes = []
    for e in (m.get("staff") or {}).get("edges") or []:
        n = e.get("node") or {}
        staff_nodes.append(
            {
                "name": (n.get("name") or {}).get("full") or "",
                "native_name": (n.get("name") or {}).get("native") or "",
                "image_url": (n.get("image") or {}).get("large") or "",
                "anilist_id": n.get("id"),
                "role": (e.get("role") or "").strip(),
            }
        )
    char_nodes = []
    for e in (m.get("characters") or {}).get("edges") or []:
        n = e.get("node") or {}
        va_list = e.get("voiceActors") or []
        if isinstance(va_list, dict):
            va_list = va_list.get("edges") or []
        va = {}
        if va_list:
            first = va_list[0]
            va = first.get("node", {}) if isinstance(first, dict) and "node" in first else (first if isinstance(first, dict) else {})
        char_nodes.append(
            {
                "name": (n.get("name") or {}).get("full") or "",
                "native_name": (n.get("name") or {}).get("native") or "",
                "image_url": (n.get("image") or {}).get("large") or "",
                "anilist_id": n.get("id"),
                "character_role": (e.get("role") or "").strip().title(),
                "va_name": (va.get("name") or {}).get("full") or "",
                "va_native": (va.get("name") or {}).get("native") or "",
                "va_image": (va.get("image") or {}).get("large") or "",
                "va_anilist_id": va.get("id"),
            }
        )
    format_type = (m.get("format") or "").title()
    if format_type == "One Shot":
        format_type = "One-shot"
    trailer = m.get("trailer") or {}
    trailer_site = (trailer.get("site") or "").lower()
    trailer_id = trailer.get("id") or ""
    if trailer_site not in ("youtube", "dailymotion"):
        trailer_site, trailer_id = "", ""
    sd = m.get("startDate") or {}
    relations = []
    for e in (m.get("relations") or {}).get("edges") or []:
        n = e.get("node") or {}
        if (n.get("type") or "").lower() != "anime":
            continue
        r_start = n.get("startDate") or {}
        relations.append(
            {
                "anilist_id": n.get("id"),
                "relation_type": e.get("relationType") or "",
                "format": n.get("format"),
                "episodes": n.get("episodes") or 0,
                "season_year": n.get("seasonYear"),
                "start": (r_start.get("year") or 9999, r_start.get("month") or 1, r_start.get("day") or 1),
                "title": (n.get("title") or {}).get("romaji")
                or (n.get("title") or {}).get("english")
                or (n.get("title") or {}).get("native")
                or "",
            }
        )
    return {
        "anilist_id": m["id"],
        "mal_id": m.get("idMal"),
        "title": t.get("romaji") or t.get("english") or t.get("native") or "",
        "alt_titles": ", ".join(
            [x for x in [t.get("english"), t.get("native")] if x and x != t.get("romaji")]
        ),
        "type": format_type,
        "genres": ", ".join(genres),
        "tags": tags,
        "description": (m.get("description") or "").strip(),
        "cover_url": (m.get("coverImage") or {}).get("extraLarge") or (m.get("coverImage") or {}).get("large") or "",
        "banner_url": m.get("bannerImage") or "",
        "studio": ", ".join([s["name"] for s in (m.get("studios") or {}).get("nodes", [])]),
        "season_year": m.get("seasonYear"),
        "season": (m.get("season") or "").title(),
        "episode_count": m.get("episodes") or 0,
        "chapter_count": m.get("chapters") or 0,
        "volume_count": m.get("volumes") or 0,
        "duration": m.get("duration") or 0,
        "average_score": m.get("averageScore"),
        "status": m.get("status"),
        "trailer_site": trailer_site,
        "trailer_id": trailer_id,
        "staff": staff_nodes,
        "characters": char_nodes,
        "start_date": (sd.get("year") or 9999, sd.get("month") or 1, sd.get("day") or 1),
        "relations": relations,
    }


def save_metadata_json(media_id: int, data: Optional[dict]) -> Optional[str]:
    path = os.path.join(METADATA_DIR, f"{media_id}.json")
    if data is None:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        return None
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return path


def load_metadata_json(media_id: int) -> Optional[dict]:
    path = os.path.join(METADATA_DIR, f"{media_id}.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Media state helpers
# ---------------------------------------------------------------------------

def _row_to_list_item(row, done_count: int = 0, total_entries: int = 0) -> dict:
    return {
        "id": row["id"],
        "category": row["category"],
        "title": row["title"],
        "type": row["type"],
        "genres": row["genres"],
        "cover_url": row["cover_url"],
        "banner_url": row["banner_url"],
        "season_year": row["season_year"],
        "episode_count": row["episode_count"],
        "chapter_count": row["chapter_count"],
        "volume_count": row["volume_count"],
        "duration": row["duration"],
        "is_favorite": row["is_favorite"],
        "is_watching": row["is_watching"],
        "plan_to_watch": row["plan_to_watch"],
        "is_completed": row["is_completed"],
        "is_dropped": row["is_dropped"],
        "is_on_hold": row["is_on_hold"],
        "personal_score": row["personal_score"],
        "metadata_json": row["metadata_json"],
        "done_count": done_count,
        "total_entries": total_entries,
    }


def _decode_seasons(raw):
    try:
        v = json.loads(raw or "[]")
        return [int(x) for x in v if str(x).lstrip("-").isdigit()]
    except Exception:
        return []


STAFF_ROLE_ORDER = [
    ("creator", "Creator", ["creator"]),
    ("writer", "Writer", ["script", "scenario", "screenplay", "composition", "author", "novel"]),
    ("music", "Music", ["music", "composer", "theme song", "perform", "song"]),
    ("producer", "Producer", ["producer"]),
    ("sound", "Sound", ["sound", "sfx", "mix"]),
    ("director", "Director", ["director"]),
    ("design", "Design", ["design", "concept", "mecha"]),
    ("animation", "Animation", ["animat", "storyboard", "layout", "cg", "3d"]),
    ("editing", "Editing", ["edit"]),
]


def _classify_staff_role(role: str) -> str:
    r = (role or "").lower()
    for token, _label, keywords in STAFF_ROLE_ORDER:
        for kw in keywords:
            if kw in r:
                return token
    return "other"


def _series_breakdown(detail: dict):
    """If the AniList entry belongs to a multi-season TV/TV_SHORT series, return
    (total_episodes, [per_season_counts], series_title) ordered by start date;
    otherwise None."""
    if (detail.get("type") or "").upper() not in ("TV", "TV_SHORT"):
        return None
    if not detail.get("episode_count"):
        return None
    entries = [
        {
            "anilist_id": detail["anilist_id"],
            "episodes": detail["episode_count"],
            "start": detail.get("start_date") or (9999, 1, 1),
            "title": detail.get("title") or "",
        }
    ]
    seen = {detail["anilist_id"]}
    for r in detail.get("relations") or []:
        if (r.get("relation_type") or "") not in ("SEQUEL", "PREQUEL"):
            continue
        if (r.get("format") or "").upper() not in ("TV", "TV_SHORT"):
            continue
        if r.get("episodes") <= 0:
            continue
        if r["anilist_id"] in seen:
            continue
        seen.add(r["anilist_id"])
        entries.append(
            {
                "anilist_id": r["anilist_id"],
                "episodes": r["episodes"],
                "start": r.get("start") or (9999, 1, 1),
                "title": r.get("title") or "",
            }
        )
        if len(entries) > 12:
            return None
    if len(entries) < 2:
        return None
    entries.sort(key=lambda x: x["start"])
    breakdown = [int(e["episodes"]) for e in entries]
    if not all(b > 0 for b in breakdown):
        return None
    return sum(breakdown), breakdown, (entries[0].get("title") or detail["title"])


def reconcile_entries(cur, media_id: int, count: int, kind: str = "episode"):
    """Grow or trim a media's flat episode/chapter entries to `count`, keeping done flags."""
    if count <= 0:
        _exec_write(cur, "DELETE FROM entries WHERE media_id=? AND kind=?", (media_id, kind))
        return
    _exec_write(
        cur,
        "DELETE FROM entries WHERE media_id=? AND kind=? AND number > ?",
        (media_id, kind, count),
    )
    existing = cur.execute(
        "SELECT MAX(number) n FROM entries WHERE media_id=? AND kind=? AND number <= ?",
        (media_id, kind, count),
    ).fetchone()
    start = (existing["n"] or 0) + 1
    for n in range(start, count + 1):
        _exec_write(cur, "INSERT INTO entries (media_id, number, kind, is_done) VALUES (?,?,?,0)", (media_id, n, kind))


def seed_entries_for_media(conn, media_id: int):
    row = conn.execute(
        "SELECT category, episode_count, chapter_count FROM media WHERE id = ?", (media_id,)
    ).fetchone()
    if not row:
        return
    kind = "episode" if row["category"] == "anime" else "chapter"
    count = row["episode_count"] if row["category"] == "anime" else row["chapter_count"]
    if not count:
        return
    existing = conn.execute(
        "SELECT MAX(number) AS n FROM entries WHERE media_id = ? AND kind = ?", (media_id, kind)
    ).fetchone()
    start = (existing["n"] or 0) + 1
    for n in range(start, count + 1):
        conn.execute(
            "INSERT INTO entries (media_id, number, kind, is_done) VALUES (?, ?, ?, 0)",
            (media_id, n, kind),
        )


def apply_anilist_to_media(media_id: int, anilist_id: int) -> dict:
    detail = anilist_detail(anilist_id)
    if not detail:
        raise HTTPException(status_code=404, detail="No metadata found on AniList (or AniList unreachable)")
    conn = get_conn()
    cur = conn.cursor()

    trailer_site, trailer_id = detail.get("trailer_site", ""), detail.get("trailer_id", "")
    if not trailer_site or not trailer_id:
        _ex = conn.execute(
            "SELECT trailer_site, trailer_id FROM media WHERE id = ?", (media_id,)
        ).fetchone()
        if _ex:
            trailer_site = trailer_site or (_ex["trailer_site"] or "")
            trailer_id = trailer_id or (_ex["trailer_id"] or "")

    _ex2 = conn.execute(
        "SELECT episode_count, season_episodes FROM media WHERE id = ?", (media_id,)
    ).fetchone()
    season_episodes_val = (_ex2["season_episodes"] or "") if _ex2 else ""
    if _decode_seasons(season_episodes_val):
        # User-entered season breakdown: always preserve it.
        episode_count = _ex2["episode_count"]
    else:
        series = _series_breakdown(detail)
        if series:
            episode_count, breakdown, series_title = series
            season_episodes_val = json.dumps(breakdown)
            detail["title"] = series_title
        else:
            episode_count = detail["episode_count"]
            season_episodes_val = ""

    _exec_write(
        cur,
        """UPDATE media SET title=?, alt_titles=?, type=?, genres=?, description=?,
           studio=?, season_year=?, season=?, episode_count=?, chapter_count=?,
           volume_count=?, duration=?, anilist_id=?, mal_id=?, trailer_site=?, trailer_id=?,
           cover_url=?, banner_url=?, metadata_json=?, season_episodes=?, updated_at=? WHERE id=?""",
        (
            detail["title"],
            detail["alt_titles"],
            detail["type"],
            detail["genres"],
            detail["description"],
            detail["studio"],
            detail["season_year"],
            "",
            episode_count,
            detail["chapter_count"],
            detail["volume_count"],
            detail["duration"],
            detail["anilist_id"],
            detail["mal_id"],
            trailer_site,
            trailer_id,
            detail["cover_url"],
            detail["banner_url"],
            f"metadata/{media_id}.json",
            season_episodes_val,
            time.strftime("%Y-%m-%d %H:%M:%S"),
            media_id,
        ),
    )

    save_metadata_json(media_id, detail)

    repo_people = {}
    for p in conn.execute("SELECT id, anilist_id, name FROM people").fetchall():
        if p["anilist_id"]:
            repo_people[p["anilist_id"]] = p["id"]

    existing_credits = conn.execute(
        "SELECT kind, role FROM credits WHERE media_id = ?", (media_id,)
    ).fetchall()
    existing_pairs = {(c["kind"], c["role"]) for c in existing_credits}
    position = 0

    for s in detail["staff"]:
        if not s["name"]:
            continue
        role = s["role"] or "Staff"
        if ("staff", role) in existing_pairs:
            continue
        pid = repo_people.get(s["anilist_id"])
        if not pid:
            _exec_write(
                cur,
                "INSERT INTO people (name, native_name, image_url, anilist_id) VALUES (?,?,?,?)",
                (s["name"], s["native_name"], s["image_url"], s["anilist_id"]),
            )
            pid = cur.lastrowid
            repo_people[s["anilist_id"]] = pid
        _exec_write(
            cur,
            "INSERT INTO credits (media_id, person_id, kind, role, position) VALUES (?,?,?,?,?)",
            (media_id, pid, "staff", role, position),
        )
        position += 1

    pos_staff = position
    for c in detail["characters"]:
        if not c["name"]:
            continue
        if ("cast", c["name"]) in existing_pairs:
            continue
        va_id = None
        if c["va_name"]:
            # New-model cast credit: the person is the voice actor; the character's
            # name and portrait live on the credit itself.
            pid = repo_people.get(c["va_anilist_id"])
            if not pid:
                _exec_write(
                    cur,
                    "INSERT INTO people (name, native_name, image_url, anilist_id) VALUES (?,?,?,?)",
                    (c["va_name"], c["va_native"], c["va_image"], c["va_anilist_id"]),
                )
                pid = cur.lastrowid
                if c["va_anilist_id"]:
                    repo_people[c["va_anilist_id"]] = pid
        else:
            # Character has no listed voice actor: fall back to the character person.
            pid = repo_people.get(c["anilist_id"])
            if not pid:
                _exec_write(
                    cur,
                    "INSERT INTO people (name, native_name, image_url, anilist_id) VALUES (?,?,?,?)",
                    (c["name"], c["native_name"], c["image_url"], c["anilist_id"]),
                )
                pid = cur.lastrowid
                repo_people[c["anilist_id"]] = pid
        _exec_write(
            cur,
            """INSERT INTO credits (media_id, person_id, kind, role, language, vo_actor_id,
                 character_role, character_image, position) VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                media_id, pid, "cast", c["name"], "Japanese", va_id,
                c["character_role"], c["image_url"], pos_staff,
            ),
        )
        pos_staff += 1

    _post = conn.execute(
        "SELECT category, episode_count, chapter_count FROM media WHERE id = ?", (media_id,)
    ).fetchone()
    _post_kind = "episode" if _post["category"] == "anime" else "chapter"
    reconcile_entries(
        cur, media_id,
        _post["episode_count"] if _post_kind == "episode" else _post["chapter_count"],
        _post_kind,
    )
    conn.commit()

    cover = None
    if detail.get("cover_url"):
        img = download_image(detail["cover_url"])
        if img:
            cover = save_resized_cover(img, media_id)
    banner = None
    if detail.get("banner_url"):
        img = download_image(detail["banner_url"])
        if img:
            banner = save_resized_banner(img, media_id)
    if cover or banner:
        cur = conn.cursor()
        if cover:
            _exec_write(cur, "UPDATE media SET cover_url=? WHERE id=?", (cover, media_id))
        if banner:
            _exec_write(cur, "UPDATE media SET banner_url=? WHERE id=?", (banner, media_id))
        conn.commit()
    conn.close()
    return detail


# ---------------------------------------------------------------------------
# Trailer downloads
# ---------------------------------------------------------------------------

TRAILER_QUALITIES = {
    1080: "bv*[vcodec^=avc1][ext=mp4][height<=1080]+ba[acodec^=mp4a][ext=m4a]/bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b",
    720: "bv*[vcodec^=avc1][ext=mp4][height<=720]+ba[acodec^=mp4a][ext=m4a]/bv*[vcodec^=avc1][height<=720]+ba[acodec^=mp4a]/b",
    480: "bv*[vcodec^=avc1][ext=mp4][height<=480]+ba[acodec^=mp4a][ext=m4a]/bv*[vcodec^=avc1][height<=480]+ba[acodec^=mp4a]/b",
    360: "bv*[vcodec^=avc1][ext=mp4][height<=360]+ba[acodec^=mp4a][ext=m4a]/bv*[vcodec^=avc1][height<=360]+ba[acodec^=mp4a]/b",
    320: "bv*[vcodec^=avc1][ext=mp4][height<=320]+ba[acodec^=mp4a][ext=m4a]/bv*[vcodec^=avc1][height<=320]+ba[acodec^=mp4a]/b",
}

TRAILER_DOWNLOADS: dict = {}


def _probe_codecs(path: str):
    try:
        v = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name", "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=120,
        )
        a = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_name", "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=120,
        )
        return (v.stdout.strip() or None, a.stdout.strip() or None)
    except Exception:
        return (None, None)


def _ensure_h264_aac(path: str) -> None:
    """Remux or transcode a trailer so iPad/iOS Safari can play it."""
    vcodec, acodec = _probe_codecs(path)
    video_ok = (vcodec or "").lower() in ("h264",)
    audio_ok = (acodec or "").lower() in ("aac", "mp4a")
    tmp = os.path.join(TRAILERS_DIR, f".fix-{os.path.basename(path)}")
    if video_ok and audio_ok:
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", path, "-c", "copy", "-movflags", "+faststart", tmp]
    else:
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", path,
               "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", tmp]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        raise RuntimeError(f"Could not process trailer format: {(r.stderr or r.stdout).strip()[:300]}")
    os.replace(tmp, path)


def _trailer_download_job(media_id: int, video_id: str, quality: int):
    TRAILER_DOWNLOADS[media_id] = {"state": "running", "msg": "Starting download...", "file": ""}
    try:
        for f in os.listdir(TRAILERS_DIR):
            if f.startswith(f"{media_id}.") and (f.endswith(".mp4") or f.endswith(".part")):
                try:
                    os.remove(os.path.join(TRAILERS_DIR, f))
                except OSError:
                    pass

        def hook(d):
            status = d.get("status")
            TRAILER_DOWNLOADS[media_id]["msg"] = {
                "downloading": f"Downloading {d.get('_percent_str', '').strip()} @ {d.get('_speed_str', '').strip()}",
                "finished": "Processing file...",
                "error": "Download error",
            }.get(status, TRAILER_DOWNLOADS[media_id]["msg"])

        opts = {
            "format": TRAILER_QUALITIES.get(int(quality), TRAILER_QUALITIES[720]),
            "outtmpl": os.path.join(TRAILERS_DIR, f"{media_id}.%(ext)s"),
            "merge_output_format": "mp4",
            "format_sort": ["vcodec:h264", "acodec:aac"],
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "progress_hooks": [hook],
        }
        with YoutubeDL(opts) as ydl:
            ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)

        final = os.path.join(TRAILERS_DIR, f"{media_id}.mp4")
        if not os.path.exists(final):
            raise RuntimeError("Download finished but the video file is missing")
        TRAILER_DOWNLOADS[media_id]["msg"] = "Verifying playback format..."
        _ensure_h264_aac(final)
        conn = get_conn()
        cur = conn.cursor()
        _exec_write(cur, "UPDATE media SET trailer_file=? WHERE id=?", (f"/trailers/{media_id}.mp4", media_id))
        conn.commit()
        conn.close()
        TRAILER_DOWNLOADS[media_id] = {
            "state": "done",
            "msg": f"Saved at {quality}p",
            "file": f"/trailers/{media_id}.mp4",
        }
    except Exception as e:
        TRAILER_DOWNLOADS[media_id] = {"state": "error", "msg": str(e) or "Download failed", "file": ""}


@app.post("/api/media/{media_id}/download-trailer")
def download_trailer(media_id: int, body: dict):
    state = TRAILER_DOWNLOADS.get(media_id, {}).get("state")
    if state == "running":
        return {"status": "busy", "state": state}
    conn = get_conn()
    row = conn.execute(
        "SELECT trailer_site, trailer_id, trailer_file FROM media WHERE id = ?", (media_id,)
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Title not found")
    if row["trailer_site"] != "youtube" or not row["trailer_id"]:
        raise HTTPException(status_code=400, detail="This title has no YouTube trailer to download")
    quality = int(body.get("quality") or 720)
    if quality not in TRAILER_QUALITIES:
        quality = 720
    threading.Thread(target=_trailer_download_job, args=(media_id, row["trailer_id"], quality), daemon=True).start()
    return {"status": "started", "quality": quality}


@app.get("/api/media/{media_id}/trailer-download-status")
def trailer_download_status(media_id: int):
    return TRAILER_DOWNLOADS.get(media_id, {"state": "idle", "msg": "", "file": ""})


def search_youtube_trailer(title: str) -> str:
    """YouTube search '{title} trailer', return the first result's video id ('' if none)."""
    try:
        with YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True}) as ydl:
            info = ydl.extract_info(f"ytsearch1:{title} trailer", download=False)
            entries = info.get("entries") or []
            if entries and entries[0].get("id"):
                return entries[0]["id"]
    except Exception:
        pass
    return ""


def _autofind_trailer_job(media_id: int):
    """Find and attach a YouTube trailer when a title has none yet (anime only)."""
    try:
        conn = get_conn()
        row = conn.execute(
            "SELECT category, title, trailer_site, trailer_id FROM media WHERE id=?", (media_id,)
        ).fetchone()
        if not row:
            conn.close()
            return
        category, title, trailer_site, trailer_id = row
        if category != "anime" or trailer_site or trailer_id:
            conn.close()
            return
        conn.close()
        if not title:
            return
        vid = search_youtube_trailer(title)
        if not vid:
            return
        conn = get_conn()
        row = conn.execute(
            "SELECT trailer_site, trailer_id FROM media WHERE id=?", (media_id,)
        ).fetchone()
        if row and not (row[0] or row[1]):
            conn.execute(
                "UPDATE media SET trailer_site='youtube', trailer_id=?, updated_at=? WHERE id=?",
                (vid, time.strftime("%Y-%m-%d %H:%M:%S"), media_id),
            )
            conn.commit()
        conn.close()
    except Exception:
        pass


def _autofind_worker(media_ids: List[int]):
    """Background autofind for a list of titles, staggered so bulk pastes don't hammer YouTube."""
    for mid in media_ids:
        _autofind_trailer_job(mid)
        if len(media_ids) > 1:
            time.sleep(2)


@app.delete("/api/media/{media_id}/trailer")
def delete_media_trailer(media_id: int):
    conn = get_conn()
    row = conn.execute("SELECT trailer_file FROM media WHERE id=?", (media_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Title not found")
    fname = row[0]
    conn.execute(
        "UPDATE media SET trailer_site='', trailer_id='', trailer_file='', updated_at=? WHERE id=?",
        (time.strftime("%Y-%m-%d %H:%M:%S"), media_id),
    )
    conn.commit()
    conn.close()
    TRAILER_DOWNLOADS.pop(media_id, None)
    if fname:
        try:
            p = os.path.join(TRAILERS_DIR, os.path.basename(fname))
            if os.path.exists(p):
                os.remove(p)
        except Exception:
            pass
    return {"ok": True, "removed": bool(fname)}


# ---------------------------------------------------------------------------
# Health / settings
# ---------------------------------------------------------------------------

@app.get("/api/health", response_model=HealthResponse)
def health_check():
    return {
        "status": "ok",
        "title": get_setting("app_title", DEFAULT_TITLE),
        "subtitle": get_setting("app_subtitle", DEFAULT_SUBTITLE),
    }


@app.get("/api/settings")
def get_all_settings():
    conn = get_conn()
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    return {
        "settings": {r["key"]: r["value"] for r in rows},
        "app_title": get_setting("app_title", DEFAULT_TITLE),
        "app_subtitle": get_setting("app_subtitle", DEFAULT_SUBTITLE),
        "bg_color": get_setting("bg_color", "#fdf2f8"),
        "accent_color": get_setting("accent_color", "#ff8fb2"),
        "secondary_color": get_setting("secondary_color", "#b8a7ff"),
        "cover_source": get_setting("cover_source", "anilist"),
    }


@app.put("/api/settings/app-title")
def set_app_title(body: dict):
    value = (body.get("value") or "").strip() or DEFAULT_TITLE
    set_setting("app_title", value)
    return {"app_title": value}


@app.put("/api/settings/app-subtitle")
def set_app_subtitle(body: dict):
    value = (body.get("value") or "").strip() or DEFAULT_SUBTITLE
    set_setting("app_subtitle", value)
    return {"app_subtitle": value}


@app.put("/api/settings/pref/{key}")
def set_pref(key: str, body: dict):
    value = str(body.get("value") or "")
    set_setting(key, value)
    return {"key": key, "value": value}


# ---------------------------------------------------------------------------
# Media CRUD
# ---------------------------------------------------------------------------

@app.get("/api/media", response_model=List[MediaListItem])
def list_media(
    category: str = Query("all"),
    status: str = Query(None),
    genre: str = Query(None),
    studio: str = Query(None),
    year: int = Query(None),
    decade: str = Query(None),
    letter: str = Query(None),
    q: str = Query(None),
    sort: str = Query("title"),
    favorite_only: bool = Query(False),
):
    conn = get_conn()
    sql = """
        SELECT m.*, st.*,
               (SELECT COUNT(*) FROM entries e WHERE e.media_id = m.id AND e.is_done = 1) AS done_count,
               (SELECT COUNT(*) FROM entries e WHERE e.media_id = m.id) AS total_entries
        FROM media m
        LEFT JOIN media_status st ON st.media_id = m.id
        WHERE 1=1
    """
    params = []
    if category in ("anime", "manga"):
        sql += " AND m.category = ?"
        params.append(category)
    if q:
        sql += " AND (m.title LIKE ? OR m.alt_titles LIKE ?)"
        like = f"%{q}%"
        params.append(like)
        params.append(like)
    if genre:
        sql += " AND (',' || m.genres || ',') LIKE ?"
        params.append(f"%,{genre},%")
    if studio:
        sql += " AND m.studio LIKE ?"
        params.append(f"%{studio}%")
    if year:
        sql += " AND m.season_year = ?"
        params.append(year)
    if decade:
        dec = str(decade)
        sql += " AND m.season_year >= ? AND m.season_year < ?"
        params.append(int(dec))
        params.append(int(dec) + 10)
    if letter:
        if letter == "#":
            sql += " AND (upper(substr(m.title,1,1)) NOT BETWEEN 'A' AND 'Z')"
        else:
            sql += " AND upper(substr(m.title,1,1)) = ?"
            params.append(letter.upper())
    if favorite_only or status == "favorite":
        sql += " AND COALESCE(st.is_favorite,0) = 1"
    elif status == "watching":
        sql += " AND COALESCE(st.is_watching,0) = 1"
    elif status == "plan_to_watch":
        sql += " AND COALESCE(st.plan_to_watch,0) = 1"
    elif status == "completed":
        sql += " AND COALESCE(st.is_completed,0) = 1"
    elif status == "dropped":
        sql += " AND COALESCE(st.is_dropped,0) = 1"
    elif status == "on_hold":
        sql += " AND COALESCE(st.is_on_hold,0) = 1"
    elif status == "missing_metadata":
        sql += " AND (m.metadata_json IS NULL OR m.metadata_json = '')"

    order_map = {
        "title": "ORDER BY lower(m.title) COLLATE NOCASE",
        "year": "ORDER BY COALESCE(m.season_year, 0) DESC, lower(m.title)",
        "recent": "ORDER BY m.updated_at DESC",
        "score": "ORDER BY COALESCE(st.personal_score, 0) DESC",
        "type": "ORDER BY m.type, lower(m.title)",
        "status": "ORDER BY lower(m.title)",
    }
    sql += " " + order_map.get(sort, order_map["title"])
    rows = conn.execute(sql, params).fetchall()
    conn.close()

    results = []
    seen = set()
    for r in rows:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        results.append(_row_to_list_item(r, r["done_count"], r["total_entries"]))
    return results


@app.post("/api/media", response_model=dict)
def add_single_media(data: MediaBase):
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    conn = get_conn()
    cur = conn.cursor()
    _exec_write(
        cur,
        """INSERT INTO media (category, title, type, genres, description, alt_titles,
           studio, season_year, season, episode_count, chapter_count, volume_count,
           duration, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            data.category,
            data.title.strip(),
            data.type,
            data.genres,
            data.description,
            data.alt_titles,
            data.studio,
            data.season_year,
            data.season,
            data.episode_count,
            data.chapter_count,
            data.volume_count,
            data.duration,
            now,
            now,
        ),
    )
    media_id = cur.lastrowid
    _exec_write(cur, "INSERT INTO media_status (media_id, plan_to_watch) VALUES (?, 1)", (media_id,))
    conn.commit()
    conn.close()
    threading.Thread(target=_autofind_trailer_job, args=(media_id,), daemon=True).start()
    return {"id": media_id}


@app.post("/api/media/bulk")
def add_bulk_media(data: AddBulkRequest):
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    conn = get_conn()
    cur = conn.cursor()
    ids = []
    for title in data.titles:
        t = title.strip()
        if not t:
            continue
        _exec_write(
            cur,
            """INSERT INTO media (category, title, created_at, updated_at)
               VALUES (?,?,?,?)""",
            (data.category, t, now, now),
        )
        mid = cur.lastrowid
        ids.append(mid)
        _exec_write(cur, "INSERT INTO media_status (media_id, plan_to_watch) VALUES (?, 1)", (mid,))
    conn.commit()
    conn.close()
    if ids:
        threading.Thread(target=_autofind_worker, args=(ids,), daemon=True).start()
    return {"ids": ids, "count": len(ids)}


@app.get("/api/media/{media_id}", response_model=MediaDetail)
def get_media_detail(media_id: int):
    conn = get_conn()
    row = conn.execute(
        """SELECT m.*, st.*,
              (SELECT COUNT(*) FROM entries e WHERE e.media_id = m.id AND e.is_done = 1) AS done_count,
              (SELECT COUNT(*) FROM entries e WHERE e.media_id = m.id) AS total_entries
           FROM media m LEFT JOIN media_status st ON st.media_id = m.id
           WHERE m.id = ?""",
        (media_id,),
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Title not found")
    item = _row_to_list_item(row, row["done_count"], row["total_entries"])
    item.update(
        {
            "alt_titles": row["alt_titles"],
            "description": row["description"],
            "studio": row["studio"],
            "season": row["season"],
            "anilist_id": row["anilist_id"],
            "mal_id": row["mal_id"],
            "trailer_site": row["trailer_site"] or "",
            "trailer_id": row["trailer_id"] or "",
            "trailer_file": row["trailer_file"] or "",
            "banner_pos": row["banner_pos"] if row["banner_pos"] is not None else 50,
            "season_episodes": _decode_seasons(row["season_episodes"]),
            "started_at": row["started_at"],
            "completed_at": row["completed_at"],
            "notes": row["notes"] or "",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
    )
    return item


@app.put("/api/media/{media_id}")
def update_media(media_id: int, data: MediaUpdate):
    conn = get_conn()
    cur = conn.cursor()
    row = conn.execute("SELECT id, season_episodes FROM media WHERE id = ?", (media_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Title not found")

    season_counts = data.season_counts
    if season_counts is not None:
        season_counts = [max(0, int(n)) for n in season_counts]
        episode_count = sum(season_counts)
        season_episodes_val = json.dumps(season_counts)
    else:
        episode_count = data.episode_count
        season_episodes_val = row["season_episodes"] or ""

    _exec_write(
        cur,
        """UPDATE media SET category=?, title=?, type=?, genres=?, description=?,
           alt_titles=?, studio=?, season_year=?, season=?, episode_count=?,
           chapter_count=?, volume_count=?, duration=?, trailer_site=?, trailer_id=?,
           season_episodes=?, updated_at=? WHERE id=?""",
        (
            data.category,
            data.title.strip(),
            data.type,
            data.genres,
            data.description,
            data.alt_titles,
            data.studio,
            data.season_year,
            data.season,
            episode_count,
            data.chapter_count,
            data.volume_count,
            data.duration,
            *parse_trailer_url(data.trailer_url),
            season_episodes_val,
            time.strftime("%Y-%m-%d %H:%M:%S"),
            media_id,
        ),
    )
    if season_counts is not None and data.category == "anime":
        reconcile_entries(cur, media_id, episode_count, "episode")
    else:
        existing = conn.execute("SELECT COUNT(*) c FROM entries WHERE media_id=?", (media_id,)).fetchone()["c"]
        if existing == 0:
            seed_entries_for_media(conn, media_id)
    conn.commit()
    conn.close()
    return {"id": media_id}


@app.post("/api/media/{media_id}/seed-entries")
def seed_entries(media_id: int):
    conn = get_conn()
    cur = conn.cursor()
    seed_entries_for_media(conn, media_id)
    conn.commit()
    count = conn.execute("SELECT COUNT(*) c FROM entries WHERE media_id=?", (media_id,)).fetchone()["c"]
    conn.close()
    return {"count": count}


@app.post("/api/media/{media_id}/set-entries-count")
def set_entries_count(media_id: int, body: dict):
    count = int(body.get("count") or 0)
    kind = body.get("kind") or "episode"
    conn = get_conn()
    cur = conn.cursor()
    _exec_write(
        cur,
        "DELETE FROM entries WHERE media_id=? AND kind=? AND number > ?",
        (media_id, kind, count),
    )
    existing = conn.execute(
        "SELECT MAX(number) n FROM entries WHERE media_id=? AND kind=? AND number <= ?",
        (media_id, kind, count),
    ).fetchone()
    start = (existing["n"] or 0) + 1
    for n in range(start, count + 1):
        _exec_write(
            cur,
            "INSERT INTO entries (media_id, number, kind, is_done) VALUES (?,?,?,0)",
            (media_id, n, kind),
        )
    conn.commit()
    conn.close()
    return {"count": count}


@app.delete("/api/media/{media_id}")
def delete_media(media_id: int):
    conn = get_conn()
    cur = conn.cursor()
    row = conn.execute("SELECT id FROM media WHERE id = ?", (media_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Title not found")
    gallery_urls = [
        r["file_url"]
        for r in conn.execute(
            "SELECT file_url FROM media_images WHERE media_id=?", (media_id,)
        ).fetchall()
    ]
    cur.execute("DELETE FROM media WHERE id = ?", (media_id,))
    conn.commit()
    conn.close()
    for path in [
        os.path.join(COVERS_DIR, f"{media_id}.jpg"),
        os.path.join(BANNERS_DIR, f"{media_id}.jpg"),
        os.path.join(METADATA_DIR, f"{media_id}.json"),
    ]:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
    for u in gallery_urls:
        if u:
            try:
                os.remove(os.path.join(GALLERY_DIR, os.path.basename(u)))
            except OSError:
                pass
    for f in os.listdir(TRAILERS_DIR):
        if f.startswith(f"{media_id}.") or f.startswith(f".fix-{media_id}."):
            try:
                os.remove(os.path.join(TRAILERS_DIR, f))
            except OSError:
                pass
    return {"id": media_id}


@app.post("/api/media/{media_id}/status")
def update_status(media_id: int, data: StatusUpdate):
    conn = get_conn()
    cur = conn.cursor()
    row = conn.execute("SELECT id FROM media WHERE id = ?", (media_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Title not found")
    existing = conn.execute("SELECT id FROM media_status WHERE media_id=?", (media_id,)).fetchone()
    if not existing:
        _exec_write(cur, "INSERT INTO media_status (media_id) VALUES (?)", (media_id,))
    fields = []
    params = []
    nullable = {"personal_score", "started_at", "completed_at"}
    for k, v in data.model_dump(exclude_unset=True).items():
        if v is None and k not in nullable:
            continue
        fields.append(f"{k} = ?")
        params.append(v)
    if fields:
        params.append(media_id)
        _exec_write(cur, f"UPDATE media_status SET {', '.join(fields)} WHERE media_id=?", params)
        conn.commit()
    conn.close()
    return {"id": media_id}


@app.post("/api/media/{media_id}/view")
def register_view(media_id: int):
    conn = get_conn()
    cur = conn.cursor()
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    _exec_write(
        cur,
        "INSERT INTO recently_viewed (media_id, viewed_at) VALUES (?, ?) "
        "ON CONFLICT(media_id) DO UPDATE SET viewed_at = excluded.viewed_at",
        (media_id, now),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Metadata fetch (single, picker, bulk/SSE)
# ---------------------------------------------------------------------------

@app.post("/api/media/{media_id}/fetch-metadata")
def fetch_metadata_picker(media_id: int):
    conn = get_conn()
    row = conn.execute("SELECT id, title, category FROM media WHERE id=?", (media_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Title not found")
    candidates = anilist_search(row["title"], row["category"], per_page=8)
    return {"candidates": candidates}


@app.post("/api/media/{media_id}/apply-metadata")
def apply_metadata(media_id: int, body: ApplyMetadata):
    detail = apply_anilist_to_media(media_id, body.anilist_id)
    return {"applied": True, "title": detail["title"]}


@app.post("/api/media/{media_id}/fetch-banner")
def fetch_banner(media_id: int):
    conn = get_conn()
    row = conn.execute("SELECT id, banner_url FROM media WHERE id=?", (media_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Title not found")
    url = row["banner_url"]
    if not url:
        detail = load_metadata_json(media_id)
        if detail and detail.get("banner_url"):
            url = detail["banner_url"]
    if not url:
        raise HTTPException(status_code=404, detail="No banner URL available")
    img = download_image(url)
    if not img:
        raise HTTPException(status_code=404, detail="Could not download banner")
    banner = save_resized_banner(img, media_id)
    conn = get_conn()
    conn.execute("UPDATE media SET banner_url=? WHERE id=?", (banner, media_id))
    conn.commit()
    conn.close()
    return {"banner_url": banner}


@app.post("/api/media/fetch-metadata/bulk")
def bulk_fetch_metadata(body: dict):
    ids = [int(x) for x in body.get("media_ids", []) if str(x).strip().isdigit()]
    mode = body.get("mode", "auto")

    def gen():
        total = len(ids)
        set_fetch_cancel(False)
        done = 0
        skipped = 0
        for idx, mid in enumerate(ids):
            if is_fetch_cancelled():
                yield f"data: {json.dumps({'type': 'cancelled', 'done': done, 'total': total})}\n\n"
                return
            conn = get_conn()
            row = conn.execute("SELECT title, category, metadata_json FROM media WHERE id=?", (mid,)).fetchone()
            conn.close()
            if not row:
                done += 1
                continue
            title = row["title"]
            if mode == "missing" and row["metadata_json"]:
                done += 1
                skipped += 1
                continue
            try:
                candidates = anilist_search(title, row["category"], per_page=3)
            except Exception:
                candidates = []
            applied = None
            if candidates:
                best = candidates[0]
                try:
                    applied = apply_anilist_to_media(mid, best["anilist_id"])
                except Exception:
                    applied = None
            done += 1
            yield f"data: {json.dumps({'type': 'progress', 'index': idx + 1, 'done': done, 'total': total, 'media_id': mid, 'title': title, 'applied': bool(applied)})}\n\n"
        yield f"data: {json.dumps({'type': 'done', 'done': done, 'total': total, 'skipped': skipped})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/api/media/fetch-metadata/cancel")
def cancel_bulk_fetch():
    set_fetch_cancel(True)
    return {"cancelled": True}


# ---------------------------------------------------------------------------
# Entries (episodes / chapters)
# ---------------------------------------------------------------------------

@app.get("/api/media/{media_id}/entries", response_model=List[EntryItem])
def list_entries(media_id: int):
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM entries WHERE media_id=? ORDER BY kind, number", (media_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.put("/api/entries/{entry_id}")
def update_entry(entry_id: int, data: EntryUpdate):
    conn = get_conn()
    cur = conn.cursor()
    row = conn.execute("SELECT * FROM entries WHERE id=?", (entry_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Entry not found")
    new_is_done = row["is_done"]
    done_at = row["done_at"]
    if data.is_done is not None and data.is_done != row["is_done"]:
        new_is_done = 1 if data.is_done else 0
        done_at = time.strftime("%Y-%m-%d %H:%M:%S") if new_is_done else None
    _exec_write(
        cur,
        """UPDATE entries SET title=?, is_done=?, done_at=?, notes=? WHERE id=?""",
        (data.title, new_is_done, done_at, data.notes, entry_id),
    )
    conn.commit()
    conn.close()
    return {
        "id": entry_id,
        "is_done": new_is_done,
        "done_at": done_at,
        "title": data.title,
        "notes": data.notes,
    }


@app.post("/api/media/{media_id}/entries")
def add_entry(media_id: int, body: dict):
    number = int(body.get("number") or 1)
    kind = body.get("kind") or "episode"
    title = body.get("title") or ""
    conn = get_conn()
    cur = conn.cursor()
    try:
        _exec_write(
            cur,
            "INSERT INTO entries (media_id, number, kind, title, is_done) VALUES (?,?,?,?,0)",
            (media_id, number, kind, title),
        )
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=409, detail="Entry already exists")
    conn.commit()
    conn.close()
    return {"id": cur.lastrowid}


@app.delete("/api/entries/{entry_id}")
def delete_entry(entry_id: int):
    conn = get_conn()
    conn.execute("DELETE FROM entries WHERE id=?", (entry_id,))
    conn.commit()
    conn.close()
    return {"id": entry_id}


# ---------------------------------------------------------------------------
# Credits / people
# ---------------------------------------------------------------------------

@app.get("/api/media/{media_id}/credits")
def list_credits(media_id: int):
    conn = get_conn()
    rows = conn.execute(
        """SELECT c.*, p.name, p.native_name, p.image_url,
                  p.image_pos_x, p.image_pos_y,
                  va.name AS va_name, va.image_url AS va_image, va.native_name AS va_native,
                  va.image_pos_x AS va_pos_x, va.image_pos_y AS va_pos_y
           FROM credits c
           LEFT JOIN people p ON p.id = c.person_id
           LEFT JOIN people va ON va.id = c.vo_actor_id
           WHERE c.media_id = ?
           ORDER BY c.kind DESC, c.position, c.id""",
        (media_id,),
    ).fetchall()
    conn.close()
    return [
        {
            "id": r["id"],
            "media_id": r["media_id"],
            "person_id": r["person_id"],
            "kind": r["kind"],
            "role": r["role"],
            "language": r["language"],
            "character_role": r["character_role"],
            "position": r["position"],
            "name": r["name"],
            "native_name": r["native_name"],
            "image_url": r["image_url"],
            "image_pos_x": r["image_pos_x"],
            "image_pos_y": r["image_pos_y"],
            "character_image": r["character_image"],
            "character_pos_x": r["character_pos_x"],
            "character_pos_y": r["character_pos_y"],
            "vo_actor_id": r["vo_actor_id"],
            "va_name": r["va_name"],
            "va_image": r["va_image"],
            "va_native": r["va_native"],
            "va_pos_x": r["va_pos_x"],
            "va_pos_y": r["va_pos_y"],
        }
        for r in rows
    ]


def _upsert_person(cur, data: dict) -> int:
    person_id = data.get("person_id")
    if not person_id and data.get("name"):
        rows = cur.execute(
            "SELECT id FROM people WHERE lower(name)=lower(?) ORDER BY id", (data["name"].strip(),)
        ).fetchall()
        if rows:
            person_id = rows[0][0]
    if not person_id:
        cur.execute(
            "INSERT INTO people (name, native_name, image_url, image_pos_x, image_pos_y, anilist_id) "
            "VALUES (?,?,?,?,?,?)",
            (
                (data.get("name") or "").strip(),
                data.get("native_name") or "",
                data.get("image_url") or "",
                data.get("image_pos_x") if data.get("image_pos_x") is not None else 50,
                data.get("image_pos_y") if data.get("image_pos_y") is not None else 50,
                data.get("anilist_id"),
            ),
        )
        person_id = cur.lastrowid
    else:
        # update missing details if provided
        cur.execute(
            "UPDATE people SET native_name = COALESCE(NULLIF(?, ''), native_name), "
            "image_url = COALESCE(NULLIF(?, ''), image_url), "
            "image_pos_x = COALESCE(?, image_pos_x), image_pos_y = COALESCE(?, image_pos_y) "
            "WHERE id = ?",
            (
                data.get("native_name") or "",
                data.get("image_url") or "",
                data.get("image_pos_x"),
                data.get("image_pos_y"),
                person_id,
            ),
        )
    return person_id


@app.post("/api/media/{media_id}/credits")
def add_credit(media_id: int, data: CreditCreate):
    conn = get_conn()
    cur = conn.cursor()
    row = conn.execute("SELECT id FROM media WHERE id=?", (media_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Title not found")

    if data.kind == "cast":
        # cast = character (role + character_image on the credit) voiced by a person.
        role = (data.role or "").strip()
        if not role:
            conn.close()
            raise HTTPException(status_code=400, detail="Character name required")
        va_name = (data.va_actor_name or data.name or "").strip()
        if not va_name and not data.vo_actor_id:
            conn.close()
            raise HTTPException(status_code=400, detail="Voice actor name required")
        person_id = _upsert_person(
            cur,
            {
                "person_id": data.vo_actor_id,
                "name": va_name,
                "native_name": data.native_name or "",
                "image_url": data.image_url or "",
                "image_pos_x": data.image_pos_x,
                "image_pos_y": data.image_pos_y,
            },
        )
    else:
        if not (data.name or "").strip() and not data.person_id:
            conn.close()
            raise HTTPException(status_code=400, detail="Name required")
        person_id = _upsert_person(cur, data.model_dump())
        role = data.role or ""

    dup = conn.execute(
        "SELECT id FROM credits WHERE media_id=? AND person_id=? AND kind=? AND role=?",
        (media_id, person_id, data.kind, role),
    ).fetchone()
    if dup:
        conn.close()
        raise HTTPException(status_code=409, detail="Credit already exists")

    position = 0
    maxpos = conn.execute(
        "SELECT MAX(position) p FROM credits WHERE media_id=?", (media_id,)
    ).fetchone()
    if maxpos and maxpos["p"] is not None:
        position = maxpos["p"] + 1

    _exec_write(
        cur,
        """INSERT INTO credits (media_id, person_id, kind, role, language, vo_actor_id,
           character_role, character_image, character_pos_x, character_pos_y, position)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            media_id,
            person_id,
            data.kind,
            role,
            data.language,
            None,
            data.character_role,
            data.character_image or "",
            data.character_pos_x,
            data.character_pos_y,
            position,
        ),
    )
    conn.commit()
    conn.close()
    return {"id": cur.lastrowid, "person_id": person_id}


@app.put("/api/credits/{credit_id}")
def update_credit(credit_id: int, data: CreditUpdate):
    conn = get_conn()
    cur = conn.cursor()
    row = conn.execute("SELECT id FROM credits WHERE id=?", (credit_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Credit not found")
    updates = data.model_dump(exclude_unset=True)
    # Resolve a credited-person swap (reassign the VA of a cast entry, etc.)
    if "person_id" in updates or "va_actor_name" in updates:
        pid = updates.pop("person_id", None)
        vname = (updates.pop("va_actor_name", None) or "").strip()
        if pid:
            pr = cur.execute("SELECT id FROM people WHERE id=?", (pid,)).fetchone()
            if not pr:
                conn.close()
                raise HTTPException(status_code=404, detail="Person not found")
        elif vname:
            pr = cur.execute(
                "SELECT id FROM people WHERE lower(name)=lower(?) LIMIT 1", (vname,)
            ).fetchone()
            pid = pr[0] if pr else _upsert_person(cur, {"name": vname})
        if pid is not None:
            updates["person_id"] = pid
    if not updates:
        conn.close()
        return {"id": credit_id}
    fields = ", ".join(f"{k} = ?" for k in updates)
    params = list(updates.values()) + [credit_id]
    _exec_write(cur, f"UPDATE credits SET {fields} WHERE id=?", params)
    conn.commit()
    conn.close()
    return {"id": credit_id}


@app.delete("/api/credits/{credit_id}")
def delete_credit(credit_id: int):
    conn = get_conn()
    cur = conn.cursor()
    row = conn.execute("SELECT id FROM credits WHERE id=?", (credit_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Credit not found")
    cur.execute("DELETE FROM credits WHERE id=?", (credit_id,))
    conn.commit()
    conn.close()
    return {"id": credit_id}


@app.get("/api/people/search")
def search_people(q: str = Query("")):
    conn = get_conn()
    if q:
        rows = conn.execute(
            "SELECT id, name, native_name, image_url, image_pos_x, image_pos_y"
            " FROM people WHERE name LIKE ? ORDER BY lower(name) LIMIT 10",
            (f"%{q}%",),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, name, native_name, image_url, image_pos_x, image_pos_y"
            " FROM people ORDER BY id DESC LIMIT 10"
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


class PersonUpdate(BaseModel):
    name: Optional[str] = None
    native_name: Optional[str] = None
    image_url: Optional[str] = None
    image_pos_x: Optional[int] = None
    image_pos_y: Optional[int] = None
    bio: Optional[str] = None
    birth_date: Optional[str] = None
    nationality: Optional[str] = None


@app.put("/api/people/{person_id}")
def update_person(person_id: int, data: PersonUpdate):
    conn = get_conn()
    row = conn.execute("SELECT id FROM people WHERE id=?", (person_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Person not found")
    updates = data.model_dump(exclude_unset=True)
    if not updates:
        conn.close()
        return {"id": person_id}
    fields = ", ".join(f"{k} = ?" for k in updates)
    params = list(updates.values()) + [person_id]
    _exec_write(conn.cursor(), f"UPDATE people SET {fields} WHERE id=?", params)
    conn.commit()
    conn.close()
    return {"id": person_id}


@app.post("/api/people/{person_id}/image")
async def upload_person_image(person_id: int, file: UploadFile = File(...)):
    conn = get_conn()
    row = conn.execute("SELECT id FROM people WHERE id=?", (person_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Person not found")
    data = await file.read()
    if not data:
        conn.close()
        raise HTTPException(status_code=400, detail="Empty file")
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
        img = img.convert("RGB")
    except Exception:
        conn.close()
        raise HTTPException(status_code=400, detail="Invalid image")
    img.save(os.path.join(PEOPLE_DIR, f"{person_id}.jpg"), "JPEG", quality=90)
    url = f"/people/{person_id}.jpg"
    conn.execute("UPDATE people SET image_url=? WHERE id=?", (url, person_id))
    conn.commit()
    conn.close()
    return {"id": person_id, "image_url": url}


@app.post("/api/credits/{credit_id}/character-image")
async def upload_character_image(credit_id: int, file: UploadFile = File(...)):
    conn = get_conn()
    cur = conn.cursor()
    row = cur.execute("SELECT id FROM credits WHERE id=?", (credit_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Credit not found")
    data = await file.read()
    if not data:
        conn.close()
        raise HTTPException(status_code=400, detail="Empty file")
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
        img = img.convert("RGB")
    except Exception:
        conn.close()
        raise HTTPException(status_code=400, detail="Invalid image")
    img.save(os.path.join(CHARACTERS_DIR, f"{credit_id}.jpg"), "JPEG", quality=90)
    url = f"/characters/{credit_id}.jpg"
    cur.execute("UPDATE credits SET character_image=? WHERE id=?", (url, credit_id))
    conn.commit()
    conn.close()
    return {"id": credit_id, "character_image": url}


@app.get("/api/people/roles")
def list_staff_roles():
    """Populated staff-role categories for the people directory filter."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT c.role FROM credits c WHERE c.kind='staff' AND COALESCE(c.role,'') <> ''"
    ).fetchall()
    conn.close()
    counts = Counter(_classify_staff_role(r["role"]) for r in rows)
    out = []
    for token, label, _keywords in STAFF_ROLE_ORDER:
        if counts.get(token):
            out.append({"token": token, "label": label, "count": counts[token]})
    if counts.get("other"):
        out.append({"token": "other", "label": "Other", "count": counts["other"]})
    return out


def _staff_role_person_ids(conn, role):
    return sorted(
        {
            r["person_id"]
            for r in conn.execute(
                "SELECT DISTINCT c.person_id, c.role FROM credits c WHERE c.kind='staff'"
            )
            if r["person_id"] and _classify_staff_role(r["role"]) == role
        }
    )


def _people_where_clause(conn, q, letter, kind, role, restrict_ids=None):
    """Build the people-directory WHERE clause + params.

    Returns (where_sql, params) or (None, []) when the role filter matches nobody.

    Letter bucketing and ordering use the surname (last word of the name).
    """
    conds = ["1=1"]
    params = []
    if restrict_ids:
        placeholders = ",".join(["?"] * len(restrict_ids))
        conds.append(f"p.id IN ({placeholders})")
        params.extend(restrict_ids)
    if q:
        conds.append("p.name LIKE ?")
        params.append(f"%{q}%")
    if letter:
        if letter == "#":
            conds.append(
                "(" + _SURNAME_SQL + f" GLOB '[0-9]*' OR " + _SURNAME_SQL + " NOT GLOB '[A-Za-z]*')"
            )
        else:
            conds.append("upper(" + _SURNAME_SQL + ") LIKE ?")
            params.append(f"{letter}%")
    if kind == "va":
        conds.append(
            "EXISTS (SELECT 1 FROM credits c WHERE c.kind='cast'"
            " AND (c.person_id = p.id OR c.vo_actor_id = p.id))"
        )
    elif kind == "staff":
        conds.append(
            "EXISTS (SELECT 1 FROM credits c WHERE c.kind='staff' AND c.person_id = p.id)"
        )
    if role:
        allowed = _staff_role_person_ids(conn, role)
        if not allowed:
            return None, []
        placeholders = ",".join(["?"] * len(allowed))
        conds.append(f"p.id IN ({placeholders})")
        params.extend(allowed)
    return " AND ".join(conds), params


_PEOPLE_CARD_COLUMNS = (
    "p.id, p.name, p.native_name, p.image_url, p.image_pos_x, p.image_pos_y, "
    "p.bio, p.birth_date, p.nationality, "
    "(SELECT COUNT(*) FROM credits c WHERE c.person_id = p.id AND c.kind='staff') AS staff_count, "
    "(SELECT COUNT(DISTINCT c.id) FROM credits c WHERE c.kind='cast' "
    " AND (c.person_id = p.id OR c.vo_actor_id = p.id)) AS cast_count "
)

_SURNAME_SQL = (
    "CASE WHEN instr(p.name, ' ') > 0 "
    "THEN substr(p.name, instr(p.name, ' ') + 1) ELSE p.name END"
)


def _people_base_sql(conn, q, letter, kind, role, restrict_ids=None):
    """Build the people-directory SELECT + filter params.

    Produces the standard person-card fields (staff_count, cast_count). When
    restrict_ids is given, only those people are considered. Returns
    (sql, params) or (None, []) when the role filter matches nobody.

    Ordered by surname (last word) then full name.
    """
    where, params = _people_where_clause(conn, q, letter, kind, role, restrict_ids)
    if where is None:
        return None, []
    sql = (
        "SELECT " + _PEOPLE_CARD_COLUMNS +
        f"FROM people p WHERE {where}"
        " ORDER BY lower(" + _SURNAME_SQL + ") COLLATE NOCASE, lower(p.name) COLLATE NOCASE, p.id"
    )
    return sql, params


def _count_people(conn, q, letter, kind, role, restrict_ids=None):
    where, params = _people_where_clause(conn, q, letter, kind, role, restrict_ids)
    if where is None:
        return 0
    n = conn.execute(f"SELECT COUNT(*) AS n FROM people p WHERE {where}", params).fetchone()
    return int(n["n"])


def _paginate_people(conn, q, letter, kind, role, page, page_size, restrict_ids=None):
    """Return {people, total, page, page_size} for the standard people query."""
    total = _count_people(conn, q, letter, kind, role, restrict_ids)
    sql, params = _people_base_sql(conn, q, letter, kind, role, restrict_ids)
    if sql is None:
        return {"people": [], "total": total, "page": page, "page_size": page_size}
    page = max(1, page)
    offset = (page - 1) * page_size
    sql += " LIMIT ? OFFSET ?"
    params.extend([page_size, offset])
    rows = conn.execute(sql, params).fetchall()
    return {"people": [dict(r) for r in rows], "total": total, "page": page, "page_size": page_size}


def _collab_sorted_page(conn, q, kind, role, page, page_size, pids, collab_counts):
    """Paginate collaborator candidates by shared-title count (desc), name as tiebreak.

    Only used when no letter filter is active, so the most frequent collaborators
    rise to the top instead of pure alphabetical order.
    """
    where, params = _people_where_clause(conn, q, "", kind, role, pids)
    if where is None:
        return {"people": [], "total": 0, "page": page, "page_size": page_size}
    rows = conn.execute(f"SELECT p.id, p.name FROM people p WHERE {where}", params).fetchall()
    entries = [(r["id"], r["name"], collab_counts.get(r["id"], 0)) for r in rows]
    entries.sort(key=lambda e: (-e[2], e[1].rsplit(" ", 1)[-1].lower()))
    total = len(entries)
    page = max(1, page)
    page_size = max(1, page_size)
    slice_rows = entries[(page - 1) * page_size:page * page_size]
    people = []
    if slice_rows:
        page_ids = [e[0] for e in slice_rows]
        ph = ",".join(["?"] * len(page_ids))
        card_rows = conn.execute(
            "SELECT " + _PEOPLE_CARD_COLUMNS + f"FROM people p WHERE p.id IN ({ph})", page_ids
        ).fetchall()
        by_id = {r["id"]: dict(r) for r in card_rows}
        for pid, name, count in slice_rows:
            p = by_id.get(pid)
            if p is None:
                continue
            p["collab_count"] = count
            people.append(p)
    return {"people": people, "total": total, "page": page, "page_size": page_size}


@app.get("/api/people")
def list_people(
    q: str = Query(""),
    letter: str = Query(""),
    kind: str = Query("all"),
    role: str = Query(""),
    page: int = Query(1, ge=1),
    page_size: int = Query(44, ge=1, le=200),
):
    """People directory: voice actors and staff (characters live on credits, not people)."""
    conn = get_conn()
    try:
        return _paginate_people(conn, q, letter, kind, role, page, page_size)
    finally:
        conn.close()


class PeopleCollabRequest(BaseModel):
    person_ids: List[int] = []
    q: str = ""
    letter: str = ""
    kind: str = "all"
    role: str = ""
    page: int = 1
    page_size: int = 44


@app.post("/api/people/collab")
def collab_people(data: PeopleCollabRequest):
    """People who share at least one credited title with all selected people.

    Returns the surviving constellation (with per-person collab_count) after the
    standard directory filters are applied, plus the shared titles themselves.
    """
    conn = get_conn()
    try:
        ids = list(dict.fromkeys(int(x) for x in data.person_ids))
        if not ids:
            return {"people": [], "total": 0, "page": 1, "page_size": data.page_size, "shared_titles": [], "shared_characters": []}
        ph = ",".join(["?"] * len(ids))
        found = conn.execute(f"SELECT id FROM people WHERE id IN ({ph})", ids).fetchall()
        if len(found) != len(ids):
            raise HTTPException(status_code=404, detail="One or more people not found")

        shared = None
        for pid in ids:
            rows = conn.execute(
                "SELECT DISTINCT media_id FROM credits WHERE media_id IS NOT NULL"
                " AND (person_id = ? OR vo_actor_id = ?)",
                (pid, pid),
            ).fetchall()
            s = {r["media_id"] for r in rows}
            shared = s if shared is None else (shared & s)
            if not shared:
                break
        shared = shared or set()

        titles = []
        if shared:
            sph = ",".join(["?"] * len(shared))
            title_rows = conn.execute(
                f"SELECT id, title, category, type, season_year, cover_url, episode_count"
                f" FROM media WHERE id IN ({sph}) ORDER BY lower(title) COLLATE NOCASE",
                sorted(shared),
            ).fetchall()
            titles = [dict(r) for r in title_rows]

        shared_characters = []
        if shared:
            sph = ",".join(["?"] * len(shared))
            seen_pairs = set()
            for pid in ids:
                rows = conn.execute(
                    f"SELECT c.media_id, c.kind, c.role, c.character_image, c.character_pos_x, c.character_pos_y "
                    f"FROM credits c WHERE c.media_id IN ({sph}) AND c.kind IN ('cast','staff') "
                    f"AND (c.person_id = ? OR c.vo_actor_id = ?)",
                    list(sorted(shared)) + [pid, pid],
                ).fetchall()
                for r in rows:
                    key = (pid, r["media_id"], r["kind"])
                    if key in seen_pairs:
                        continue
                    seen_pairs.add(key)
                    shared_characters.append(
                        {
                            "person_id": pid,
                            "media_id": r["media_id"],
                            "kind": r["kind"],
                            "role": r["role"],
                            "character_image": r["character_image"],
                            "character_pos_x": r["character_pos_x"],
                            "character_pos_y": r["character_pos_y"],
                        }
                    )

        candidate_set = set()
        collab_media = {}
        if shared:
            sph = ",".join(["?"] * len(shared))
            rows = conn.execute(
                f"SELECT person_id, vo_actor_id, media_id FROM credits"
                f" WHERE media_id IN ({sph})",
                sorted(shared),
            ).fetchall()
            for r in rows:
                for pid in (r["person_id"], r["vo_actor_id"]):
                    if pid:
                        collab_media.setdefault(pid, set()).add(r["media_id"])
                        candidate_set.add(pid)
        candidate_set -= set(ids)

        if not candidate_set:
            return {"people": [], "total": 0, "page": 1, "page_size": data.page_size,
                    "shared_titles": titles, "shared_characters": shared_characters}
        restrict_ids = sorted(candidate_set)
        page = max(1, data.page)
        page_size = max(1, min(200, data.page_size))
        collab_counts = {pid: len(s) for pid, s in collab_media.items()}
        if data.letter:
            result = _paginate_people(conn, data.q, data.letter, data.kind, data.role, page, page_size, restrict_ids)
        else:
            result = _collab_sorted_page(conn, data.q, data.kind, data.role, page, page_size, restrict_ids, collab_counts)
        for p in result["people"]:
            p["collab_count"] = len(collab_media.get(p["id"], set()))
        result["shared_titles"] = titles
        result["shared_characters"] = shared_characters
        return result
    finally:
        conn.close()


@app.get("/api/people/{person_id}")
def get_person(person_id: int):
    conn = get_conn()
    p = conn.execute("SELECT * FROM people WHERE id=?", (person_id,)).fetchone()
    if not p:
        conn.close()
        raise HTTPException(status_code=404, detail="Person not found")
    credits = conn.execute(
        "SELECT c.id, c.media_id, m.title, m.category, m.cover_url, c.kind, c.role, "
        "c.character_image, c.character_pos_x, c.character_pos_y, c.character_role "
        "FROM credits c JOIN media m ON m.id = c.media_id "
        "WHERE c.person_id = ? ORDER BY c.kind DESC, c.position, c.id",
        (person_id,),
    ).fetchall()
    conn.close()
    return {**dict(p), "credits": [dict(r) for r in credits]}


# ---------------------------------------------------------------------------
# Franchises
# ---------------------------------------------------------------------------

@app.get("/api/franchises")
def list_franchises():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM franchises ORDER BY name").fetchall()
    out = []
    for f in rows:
        media_rows = conn.execute(
            """SELECT m.id, m.title, m.cover_url, m.category, m.type, m.season_year
               FROM franchise_media fm
               JOIN media m ON m.id = fm.media_id
               WHERE fm.franchise_id = ? ORDER BY fm.position, m.title""",
            (f["id"],),
        ).fetchall()
        out.append(
            {
                "id": f["id"],
                "name": f["name"],
                "description": f["description"],
                "created_at": f["created_at"],
                "count": len(media_rows),
                "cover_url": media_rows[0]["cover_url"] if media_rows else "",
                "media": [dict(r) for r in media_rows],
            }
        )
    conn.close()
    return out


@app.post("/api/franchises")
def create_franchise(data: FranchiseCreate):
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    conn = get_conn()
    try:
        cur = conn.cursor()
        _exec_write(cur, "INSERT INTO franchises (name, description, created_at) VALUES (?,?,?)", (name, data.description, now))
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=409, detail="Franchise already exists")
    conn.commit()
    conn.close()
    return {"id": cur.lastrowid}


@app.put("/api/franchises/{franchise_id}")
def update_franchise(franchise_id: int, data: FranchiseCreate):
    conn = get_conn()
    cur = conn.cursor()
    _exec_write(
        cur,
        "UPDATE franchises SET name=?, description=? WHERE id=?",
        (data.name.strip(), data.description, franchise_id),
    )
    conn.commit()
    conn.close()
    return {"id": franchise_id}


@app.delete("/api/franchises/{franchise_id}")
def delete_franchise(franchise_id: int):
    conn = get_conn()
    conn.execute("DELETE FROM franchises WHERE id=?", (franchise_id,))
    conn.commit()
    conn.close()
    return {"id": franchise_id}


@app.post("/api/franchises/{franchise_id}/media")
def add_franchise_media(franchise_id: int, body: dict):
    media_id = int(body.get("media_id"))
    position = int(body.get("position") or 0)
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO franchise_media (franchise_id, media_id, position) VALUES (?,?,?)",
            (franchise_id, media_id, position),
        )
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=409, detail="Already in franchise")
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/franchises/{franchise_id}/media")
def remove_franchise_media(franchise_id: int, body: dict):
    media_id = int(body.get("media_id"))
    conn = get_conn()
    conn.execute(
        "DELETE FROM franchise_media WHERE franchise_id=? AND media_id=?", (franchise_id, media_id)
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/franchises/{franchise_id}/reorder")
def reorder_franchise(franchise_id: int, body: dict):
    order = body.get("media_ids", [])
    conn = get_conn()
    cur = conn.cursor()
    for i, mid in enumerate(order):
        _exec_write(
            cur,
            "UPDATE franchise_media SET position=? WHERE franchise_id=? AND media_id=?",
            (i, franchise_id, int(mid)),
        )
    conn.commit()
    conn.close()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Collections
# ---------------------------------------------------------------------------

@app.get("/api/collections")
def list_collections():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM collections ORDER BY name").fetchall()
    out = []
    for c in rows:
        media_rows = conn.execute(
            """SELECT m.id, m.title, m.cover_url, m.category, m.type, m.season_year
               FROM collection_media cm JOIN media m ON m.id = cm.media_id
               WHERE cm.collection_id = ? ORDER BY m.title""",
            (c["id"],),
        ).fetchall()
        out.append(
            {
                "id": c["id"],
                "name": c["name"],
                "description": c["description"],
                "created_at": c["created_at"],
                "count": len(media_rows),
                "cover_url": media_rows[0]["cover_url"] if media_rows else "",
                "media": [dict(r) for r in media_rows],
            }
        )
    conn.close()
    return out


@app.post("/api/collections")
def create_collection(data: CollectionCreate):
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    conn = get_conn()
    try:
        cur = conn.cursor()
        _exec_write(cur, "INSERT INTO collections (name, description, created_at) VALUES (?,?,?)", (name, data.description, now))
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=409, detail="Collection already exists")
    conn.commit()
    conn.close()
    return {"id": cur.lastrowid}


@app.put("/api/collections/{collection_id}")
def update_collection(collection_id: int, data: CollectionCreate):
    conn = get_conn()
    cur = conn.cursor()
    _exec_write(
        cur,
        "UPDATE collections SET name=?, description=? WHERE id=?",
        (data.name.strip(), data.description, collection_id),
    )
    conn.commit()
    conn.close()
    return {"id": collection_id}


@app.delete("/api/collections/{collection_id}")
def delete_collection(collection_id: int):
    conn = get_conn()
    conn.execute("DELETE FROM collections WHERE id=?", (collection_id,))
    conn.commit()
    conn.close()
    return {"id": collection_id}


@app.post("/api/collections/{collection_id}/media")
def add_collection_media(collection_id: int, body: dict):
    media_id = int(body.get("media_id"))
    conn = get_conn()
    try:
        conn.execute("INSERT INTO collection_media (collection_id, media_id) VALUES (?,?)", (collection_id, media_id))
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=409, detail="Already in collection")
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/collections/{collection_id}/media")
def remove_collection_media(collection_id: int, body: dict):
    media_id = int(body.get("media_id"))
    conn = get_conn()
    conn.execute("DELETE FROM collection_media WHERE collection_id=? AND media_id=?", (collection_id, media_id))
    conn.commit()
    conn.close()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Covers / banners
# ---------------------------------------------------------------------------

def _delete_cover(conn, media_id: int):
    path = os.path.join(COVERS_DIR, f"{media_id}.jpg")
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    conn.execute("UPDATE media SET cover_url='' WHERE id=?", (media_id,))


def _delete_banner(conn, media_id: int):
    path = os.path.join(BANNERS_DIR, f"{media_id}.jpg")
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    conn.execute("UPDATE media SET banner_url='' WHERE id=?", (media_id,))


@app.post("/api/media/{media_id}/upload-cover")
async def upload_cover(media_id: int, file: UploadFile = File(...)):
    data = await file.read()
    img = Image.open(io.BytesIO(data))
    img.load()
    cover = save_resized_cover(img, media_id)
    if not cover:
        raise HTTPException(status_code=400, detail="Invalid image")
    conn = get_conn()
    conn.execute("UPDATE media SET cover_url=? WHERE id=?", (cover, media_id))
    conn.commit()
    conn.close()
    return {"cover_url": cover}


@app.post("/api/media/{media_id}/cover-from-url")
def cover_from_url(media_id: int, data: CoverFromUrl):
    img = download_image(data.url)
    if not img:
        raise HTTPException(status_code=400, detail="Could not download image")
    cover = save_resized_cover(img, media_id)
    conn = get_conn()
    conn.execute("UPDATE media SET cover_url=? WHERE id=?", (cover, media_id))
    conn.commit()
    conn.close()
    return {"cover_url": cover}


@app.delete("/api/media/{media_id}/cover")
def delete_cover(media_id: int):
    conn = get_conn()
    _delete_cover(conn, media_id)
    conn.commit()
    conn.close()
    return {"id": media_id}


@app.post("/api/media/{media_id}/upload-banner")
async def upload_banner(media_id: int, file: UploadFile = File(...)):
    data = await file.read()
    img = Image.open(io.BytesIO(data))
    img.load()
    banner = save_resized_banner(img, media_id)
    if not banner:
        raise HTTPException(status_code=400, detail="Invalid image")
    conn = get_conn()
    conn.execute("UPDATE media SET banner_url=? WHERE id=?", (banner, media_id))
    conn.commit()
    conn.close()
    return {"banner_url": banner}


@app.post("/api/media/{media_id}/banner-from-url")
def banner_from_url(media_id: int, data: CoverFromUrl):
    img = download_image(data.url)
    if not img:
        raise HTTPException(status_code=400, detail="Could not download image")
    banner = save_resized_banner(img, media_id)
    conn = get_conn()
    conn.execute("UPDATE media SET banner_url=? WHERE id=?", (banner, media_id))
    conn.commit()
    conn.close()
    return {"banner_url": banner}


@app.delete("/api/media/{media_id}/banner")
def delete_banner(media_id: int):
    conn = get_conn()
    _delete_banner(conn, media_id)
    conn.commit()
    conn.close()
    return {"id": media_id}


class BannerPosUpdate(BaseModel):
    pos: int = 50


@app.put("/api/media/{media_id}/banner-pos")
def update_banner_pos(media_id: int, data: BannerPosUpdate):
    pos = max(0, min(100, data.pos))
    conn = get_conn()
    row = conn.execute(
        "SELECT banner_pos FROM media WHERE id=?", (media_id,)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Title not found")
    conn.execute(
        "UPDATE media SET banner_pos=?, updated_at=? WHERE id=?",
        (pos, time.strftime("%Y-%m-%d %H:%M:%S"), media_id),
    )
    conn.commit()
    conn.close()
    return {"pos": pos}


# ---------------------------------------------------------------------------
# Gallery (media images)
# ---------------------------------------------------------------------------

def _media_exists(media_id: int) -> bool:
    conn = get_conn()
    try:
        row = conn.execute("SELECT id FROM media WHERE id=?", (media_id,)).fetchone()
        return row is not None
    finally:
        conn.close()


def _add_gallery_image(conn, media_id: int, img) -> Optional[int]:
    try:
        img.load()
        w, h = img.size
        if not w or not h:
            return None
        img = img.convert("RGB")
        pos = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM media_images WHERE media_id=?", (media_id,)
        ).fetchone()[0]
        cur = conn.execute(
            "INSERT INTO media_images (media_id, file_url, width, height, position, created_at) "
            "VALUES (?, '', ?, ?, ?, ?)",
            (media_id, w, h, pos, time.strftime("%Y-%m-%d %H:%M:%S")),
        )
        img_id = cur.lastrowid
        url = f"/gallery/{img_id}.jpg"
        img.save(os.path.join(GALLERY_DIR, f"{img_id}.jpg"), "JPEG", quality=90)
        conn.execute("UPDATE media_images SET file_url=? WHERE id=?", (url, img_id))
        return img_id
    except Exception:
        return None


def _gallery_images_dict(media_id: int) -> List[dict]:
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, file_url, width, height, position, created_at FROM media_images "
            "WHERE media_id=? ORDER BY position, id",
            (media_id,),
        ).fetchall()
        return [
            {"id": r["id"], "url": r["file_url"], "width": r["width"], "height": r["height"],
             "position": r["position"], "created_at": r["created_at"]}
            for r in rows
        ]
    finally:
        conn.close()


@app.get("/api/media/{media_id}/images")
def list_gallery_images(media_id: int):
    if not _media_exists(media_id):
        raise HTTPException(status_code=404, detail="Title not found")
    return _gallery_images_dict(media_id)


@app.post("/api/media/{media_id}/images")
async def upload_gallery_images(media_id: int, files: List[UploadFile] = File(...)):
    if not _media_exists(media_id):
        raise HTTPException(status_code=404, detail="Title not found")
    conn = get_conn()
    added = []
    for file in files:
        data = await file.read()
        if not data:
            continue
        try:
            img = Image.open(io.BytesIO(data))
            img.load()
        except Exception:
            continue
        img_id = _add_gallery_image(conn, media_id, img)
        if img_id is not None:
            conn.commit()
            added.append(img_id)
    conn.close()
    if not added:
        raise HTTPException(status_code=400, detail="No valid images in upload")
    images = _gallery_images_dict(media_id)
    return {"added": added, "images": images}


@app.post("/api/media/{media_id}/image-from-url")
def gallery_from_urls(media_id: int, data: ImageUrls):
    if not _media_exists(media_id):
        raise HTTPException(status_code=404, detail="Title not found")
    conn = get_conn()
    added = []
    for url in (data.urls or []):
        url = (url or "").strip()
        if not url:
            continue
        try:
            img = download_image(url)
        except Exception:
            img = None
        if img is None:
            continue
        img_id = _add_gallery_image(conn, media_id, img)
        if img_id is not None:
            conn.commit()
            added.append(img_id)
    conn.close()
    if not added:
        raise HTTPException(status_code=400, detail="Could not download any image")
    images = _gallery_images_dict(media_id)
    return {"added": added, "images": images}


@app.delete("/api/media/{media_id}/images/{image_id}")
def delete_gallery_image(media_id: int, image_id: int):
    conn = get_conn()
    row = conn.execute(
        "SELECT file_url FROM media_images WHERE id=? AND media_id=?", (image_id, media_id)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Image not found")
    conn.execute("DELETE FROM media_images WHERE id=?", (image_id,))
    conn.commit()
    conn.close()
    url = row["file_url"]
    if url:
        try:
            os.remove(os.path.join(GALLERY_DIR, os.path.basename(url)))
        except FileNotFoundError:
            pass
    return {"id": image_id}


# ---------------------------------------------------------------------------
# Facets & stats
# ---------------------------------------------------------------------------

@app.get("/api/genres")
def get_genres():
    conn = get_conn()
    rows = conn.execute("SELECT genres FROM media WHERE genres != ''").fetchall()
    conn.close()
    counts = {}
    for r in rows:
        for g in [x.strip() for x in r["genres"].split(",") if x.strip()]:
            counts[g] = counts.get(g, 0) + 1
    return [{"name": k, "count": v} for k, v in sorted(counts.items(), key=lambda x: -x[1])]


@app.get("/api/studios")
def get_studios():
    conn = get_conn()
    rows = conn.execute("SELECT studio FROM media WHERE studio != ''").fetchall()
    conn.close()
    counts = {}
    for r in rows:
        for s in [x.strip() for x in r["studio"].split(",") if x.strip()]:
            counts[s] = counts.get(s, 0) + 1
    return [{"name": k, "count": v} for k, v in sorted(counts.items(), key=lambda x: -x[1])]


@app.get("/api/years")
def get_years():
    conn = get_conn()
    rows = conn.execute("SELECT season_year, COUNT(*) c FROM media WHERE season_year IS NOT NULL GROUP BY season_year ORDER BY season_year DESC").fetchall()
    conn.close()
    return [{"year": r["season_year"], "count": r["c"]} for r in rows]


@app.get("/api/stats")
def get_stats():
    conn = get_conn()
    media_count = conn.execute("SELECT COUNT(*) c FROM media").fetchone()["c"]
    anime_count = conn.execute("SELECT COUNT(*) c FROM media WHERE category='anime'").fetchone()["c"]
    manga_count = conn.execute("SELECT COUNT(*) c FROM media WHERE category='manga'").fetchone()["c"]
    completed = conn.execute("SELECT COUNT(*) c FROM media_status WHERE is_completed=1").fetchone()["c"]
    favorites = conn.execute("SELECT COUNT(*) c FROM media_status WHERE is_favorite=1").fetchone()["c"]
    watching = conn.execute("SELECT COUNT(*) c FROM media_status WHERE (is_watching=1)").fetchone()["c"]
    plan = conn.execute("SELECT COUNT(*) c FROM media_status WHERE plan_to_watch=1").fetchone()["c"]
    dropped = conn.execute("SELECT COUNT(*) c FROM media_status WHERE is_dropped=1").fetchone()["c"]
    on_hold = conn.execute("SELECT COUNT(*) c FROM media_status WHERE is_on_hold=1").fetchone()["c"]

    hours = conn.execute(
        """SELECT COALESCE(SUM(d.done_count * m.duration), 0) AS total_minutes
           FROM media m JOIN (
               SELECT media_id, COUNT(*) done_count FROM entries WHERE is_done=1 GROUP BY media_id
           ) d ON d.media_id = m.id"""
    ).fetchone()["total_minutes"]
    hours_watched = round(int(hours or 0) / 60, 1)

    entries_done = conn.execute("SELECT COUNT(*) c FROM entries WHERE is_done=1").fetchone()["c"]

    recently = conn.execute(
        """SELECT m.id, m.title, m.category, m.type, m.cover_url, m.season_year, rv.viewed_at
           FROM recently_viewed rv JOIN media m ON m.id = rv.media_id
           ORDER BY rv.viewed_at DESC LIMIT 8"""
    ).fetchall()

    last_added = conn.execute(
        "SELECT id, title, category, type, cover_url, season_year, created_at FROM media ORDER BY id DESC LIMIT 8"
    ).fetchall()

    franchise_rows = conn.execute("SELECT * FROM franchises ORDER BY name LIMIT 8").fetchall()
    franchises = []
    for f in franchise_rows:
        fm = conn.execute(
            "SELECT m.cover_url FROM franchise_media x JOIN media m ON m.id=x.media_id WHERE x.franchise_id=? LIMIT 1",
            (f["id"],),
        ).fetchone()
        franchises.append(
            {
                "id": f["id"],
                "name": f["name"],
                "count": conn.execute("SELECT COUNT(*) c FROM franchise_media WHERE franchise_id=?", (f["id"],)).fetchone()["c"],
                "cover_url": fm["cover_url"] if fm else "",
            }
        )
    conn.close()
    return {
        "media_count": media_count,
        "anime_count": anime_count,
        "manga_count": manga_count,
        "completed": completed,
        "favorites": favorites,
        "watching": watching,
        "plan_to_watch": plan,
        "dropped": dropped,
        "on_hold": on_hold,
        "hours_watched": hours_watched,
        "entries_done": entries_done,
        "recently_viewed": [dict(r) for r in recently],
        "last_added": [dict(r) for r in last_added],
        "franchises": franchises,
    }


# ---------------------------------------------------------------------------
# Headers
# ---------------------------------------------------------------------------

@app.get("/api/headers")
def list_headers():
    files = sorted(
        f for f in os.listdir(HEADERS_DIR)
        if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))
    )
    return {"headers": [f"/headers/{f}" for f in files]}


@app.post("/api/headers/upload")
async def upload_header(file: UploadFile = File(...)):
    data = await file.read()
    img = Image.open(io.BytesIO(data))
    img.load()
    if img.width > BANNER_WIDTH:
        ratio = BANNER_WIDTH / img.width
        img = img.resize((BANNER_WIDTH, int(img.height * ratio)), Image.LANCZOS)
    img = img.convert("RGB")
    path = os.path.join(HEADERS_DIR, f"header_{int(time.time())}.jpg")
    img.save(path, "JPEG", quality=88)
    return {"url": f"/headers/{os.path.basename(path)}"}


@app.get("/api/convert-static/{path:path}")
def static_file_proxy(path: str):
    return FileResponse(os.path.join(str(APP_DIR), path))


init_db()
run_migrations()

# ---------------------------------------------------------------------------
# Music library
# ---------------------------------------------------------------------------

AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".ogg", ".wav", ".aac"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
AUDIO_MIME = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".aac": "audio/aac",
}


def _safe_music_rel(path: str, root: str) -> Optional[str]:
    """Resolve a relative path inside root; return relative path or None."""
    if not path:
        return None
    try:
        full = os.path.realpath(os.path.join(root, path))
    except (OSError, ValueError):
        return None
    root_real = os.path.realpath(root)
    if os.path.commonpath([root_real, full]) != root_real or not os.path.exists(full):
        return None
    return os.path.relpath(full, root_real)


def _music_albums_for(root: str):
    """Enumerate album units under root.

    A folder with audio files directly is its own album. A folder (album-like)
    whose subfolders are all discs ("Disc 1", "CD 2", ディスク 3) is one album
    with the discs flattened in order. Anything else (category folders) is
    descended into so each real album becomes a selectable unit.
    """
    root_real = os.path.realpath(root)
    music_base = _music_root_real()

    def rel_of(full_path: str) -> str:
        return os.path.relpath(full_path, music_base)

    def descend(units, d):
        entries = sorted(os.listdir(d))
        audio_now = [f for f in entries
                     if os.path.isfile(os.path.join(d, f)) and os.path.splitext(f)[1].lower() in AUDIO_EXTS]
        subs = [e for e in entries if os.path.isdir(os.path.join(d, e))]

        def direct_audio(path):
            try:
                return [f for f in os.listdir(path)
                        if os.path.isfile(os.path.join(path, f)) and os.path.splitext(f)[1].lower() in AUDIO_EXTS]
            except OSError:
                return []

        def subtree_has_audio(path):
            try:
                entries = os.listdir(path)
            except OSError:
                return False
            for e in entries:
                full = os.path.join(path, e)
                if os.path.isfile(full) and os.path.splitext(e)[1].lower() in AUDIO_EXTS:
                    return True
                if os.path.isdir(full) and subtree_has_audio(full):
                    return True
            return False

        disc_re = re.compile(r"^(disc|cd|ディスク)\s*\d", re.IGNORECASE)

        if audio_now:
            units.append({"dir": d, "kind": "flat"})
            return
        if not subs:
            return
        audio_subs = [s for s in subs if direct_audio(os.path.join(d, s))]
        if audio_subs and all(disc_re.match(s) for s in audio_subs):
            units.append({"dir": d, "kind": "discs"})
            return
        for s in subs:
            full = os.path.join(d, s)
            if subtree_has_audio(full):
                descend(units, full)

    units = []
    descend(units, root_real)
    units.sort(key=lambda u: rel_of(u["dir"]))

    def find_cover(unit):
        base = unit["dir"]
        dirs = [base]
        if unit["kind"] == "discs":
            dirs += [os.path.join(base, s) for s in sorted(
                s for s in os.listdir(base)
                if os.path.isdir(os.path.join(base, s))
            )]
        for d in dirs:
            try:
                imgs = sorted(
                    f for f in os.listdir(d)
                    if os.path.isfile(os.path.join(d, f)) and os.path.splitext(f)[1].lower() in IMAGE_EXTS
                )
            except OSError:
                imgs = []
            if imgs:
                return rel_of(os.path.join(d, imgs[0]))
        return None

    def tracks_for(unit):
        base = unit["dir"]
        tracks = []
        if unit["kind"] == "discs":
            discs = sorted(s for s in os.listdir(base) if os.path.isdir(os.path.join(base, s)))
            i = 1
            for disc in discs:
                for f in sorted(x for x in os.listdir(os.path.join(base, disc))
                                if os.path.isfile(os.path.join(base, disc, x))
                                and os.path.splitext(x)[1].lower() in AUDIO_EXTS):
                    tracks.append({
                        "num": i,
                        "title": os.path.splitext(f)[0],
                        "url": "/api/music/stream?p=" + _enc(rel_of(os.path.join(base, disc, f))),
                    })
                    i += 1
        else:
            for i, f in enumerate(sorted(x for x in os.listdir(base)
                                          if os.path.isfile(os.path.join(base, x))
                                          and os.path.splitext(x)[1].lower() in AUDIO_EXTS), 1):
                tracks.append({
                    "num": i,
                    "title": os.path.splitext(f)[0],
                    "url": "/api/music/stream?p=" + _enc(rel_of(os.path.join(base, f))),
                })
        return tracks

    result = []
    for unit in units:
        rel = rel_of(unit["dir"])
        name = os.path.basename(rel) if rel else os.path.basename(root_real.rstrip("/")) or "Music"
        cover = find_cover(unit)
        result.append({
            "name": name,
            "rel_path": rel,
            "cover_url": ("/api/music/cover?p=" + _enc(cover)) if cover else "",
            "tracks": tracks_for(unit),
        })
    return result


def _enc(text: str) -> str:
    import urllib.parse
    return urllib.parse.quote(text, safe="/")


def _music_path_for(conn, media_id: int) -> Optional[str]:
    row = conn.execute("SELECT music_path FROM media_music WHERE media_id=?", (media_id,)).fetchone()
    if not row or not row["music_path"]:
        return None
    p = row["music_path"]
    if not os.path.exists(p):
        return None
    p_real = os.path.realpath(p)
    if os.path.commonpath([_music_root_real(), p_real]) != _music_root_real():
        return None
    return p_real


@app.get("/api/media/{media_id}/music")
def get_media_music(media_id: int):
    conn = get_conn()
    row = conn.execute("SELECT music_path FROM media_music WHERE media_id=?", (media_id,)).fetchone()
    conn.close()
    if not row or not row["music_path"]:
        return {"path": None}
    return {"path": row["music_path"]}


@app.put("/api/media/{media_id}/music")
def set_media_music(media_id: int, data: MusicPathRequest):
    path = (data.path or "").strip().rstrip("/")
    if not path:
        raise HTTPException(status_code=400, detail="Music path is required")
    p_real = os.path.realpath(path)
    root_real = _music_root_real()
    if os.path.commonpath([root_real, p_real]) != root_real:
        raise HTTPException(status_code=400, detail="Path must be inside the music folder")
    if not os.path.isdir(p_real):
        raise HTTPException(status_code=400, detail="Folder not found on the server")
    conn = get_conn()
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    conn.execute(
        "INSERT INTO media_music(media_id, music_path, created_at, updated_at) VALUES(?,?,?,?) "
        "ON CONFLICT(media_id) DO UPDATE SET music_path=excluded.music_path, updated_at=excluded.updated_at",
        (media_id, p_real, now, now),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "path": p_real}


@app.delete("/api/media/{media_id}/music")
def delete_media_music(media_id: int):
    conn = get_conn()
    conn.execute("DELETE FROM media_music WHERE media_id=?", (media_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/media/{media_id}/music/albums")
def get_media_music_albums(media_id: int):
    conn = get_conn()
    root = _music_path_for(conn, media_id)
    conn.close()
    if not root:
        raise HTTPException(status_code=404, detail="No music linked to this title")
    try:
        return {"ok": True, "albums": _music_albums_for(root)}
    except OSError:
        raise HTTPException(status_code=500, detail="Could not scan music folder")


@app.get("/api/music/library")
def list_music_library():
    """All media that have a linked soundtrack folder, alphabetical by title."""
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT m.id, m.category, m.title, m.type, m.cover_url, m.season_year "
            "FROM media m JOIN media_music mm ON mm.media_id = m.id "
            "ORDER BY m.title COLLATE NOCASE"
        ).fetchall()
    finally:
        conn.close()
    items = [
        {
            "id": r["id"],
            "category": r["category"],
            "title": r["title"],
            "type": r["type"],
            "cover_url": r["cover_url"],
            "season_year": r["season_year"],
        }
        for r in rows
    ]
    return {"ok": True, "items": items, "total": len(items)}


@app.get("/api/music/stream")
def stream_music(p: str = Query(...)):
    root = _music_root_real()
    rel = _safe_music_rel(p, root)
    if not rel:
        raise HTTPException(status_code=404, detail="File not found")
    full = os.path.join(root, rel)
    ext = os.path.splitext(full)[1].lower()
    return FileResponse(
        full,
        media_type=AUDIO_MIME.get(ext, "application/octet-stream"),
    )


@app.get("/api/music/cover")
def stream_music_cover(p: str = Query(...)):
    root = _music_root_real()
    rel = _safe_music_rel(p, root)
    if not rel:
        raise HTTPException(status_code=404, detail="File not found")
    ext = os.path.splitext(rel)[1].lower()
    mime = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
            ".webp": "image/webp", ".gif": "image/gif"}.get(ext, "image/jpeg")
    return FileResponse(os.path.join(root, rel), media_type=mime)


if __name__ == "__main__":
    import uvicorn

    _port = int(
        os.environ.get("OTAKU_BACKEND_PORT")
        or _config.get("backend_port")
        or 9001
    )
    uvicorn.run(app, host="0.0.0.0", port=_port)