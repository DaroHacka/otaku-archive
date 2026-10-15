# 🍡 Otaku Archive

<img src="ico/logo.svg" width="200" align="right" alt="Otaku Archive Logo">
# Otaku Archive
<br><br>

*A lightweight, user-friendly anime & manga archive with rotating themed headers, customizable visuals, and smart AniList metadata fetching.*

Otaku Archive is a lightweight web application for keeping track of everything you watch and read: anime, manga, and everything in between. It runs on your own machine, stores everything in a single local SQLite file, and fetches metadata, cover art, cast, and trailers from the internet so you don't have to type it all in yourself.

It's built for people who want a **tidy, searchable, good-looking** shelf of their collection — not another subscription service.

---

## ✨ Screenshots

<p align="center">
  <img src="preview/Screenshot%202026-10-15%20132927.png" width="900" alt="Otaku Archive - library view">
</p>

<p align="center">
  <img src="preview/Screenshot%202026-10-15%20132952.png" width="900" alt="Otaku Archive - title detail">
</p>

<p align="center">
  <img src="preview/Screenshot%202026-10-15%20133149.png" width="900" alt="Otaku Archive - metadata search">
</p>

<p align="center">
  <img src="preview/Screenshot%202026-10-15%20133209.png" width="900" alt="Otaku Archive - cast and staff">
</p>

<p align="center">
  <img src="preview/Screenshot%202026-10-15%20133321.png" width="900" alt="Otaku Archive - people and collaboration">
</p>

<p align="center">
  <img src="preview/Screenshot%202026-10-15%20133345.png" width="900" alt="Otaku Archive - music player">
</p>

---

## 🚀 Features

### 📚 Your collection
- **Add titles** one at a time, or **paste a whole list** (one title per line) to create many entries at once.
- Track **anime and manga** side by side.
- **Status tracking:** Watching, Completed, Plan to Watch, On Hold, Dropped, and ⭐ Favorite, plus a personal score and free-text notes.
- **Episodes / chapters:** seed an entry with numbered episodes or chapters, adjust the count, tick progress off as you go, and jot per-episode notes.
- **Filters & search:** browse by status, genre, studio, and decade, search across the archive, and jump around with an alphabetical index.
- **Collections & franchises:** group related titles into collections, and link a title to its franchise so sequels and spin-offs stay together.

### 🖼 Artwork & metadata
- **Automatic metadata from AniList** (an open, keyless API) — search a title, pick the right match, and the app fills in the description, genres, studio, season/year, episode counts, cover art, cast & staff, and the trailer.
- **Bulk fetch** to enrich many titles at once — perfect after importing a big list.
- **Covers, banners, and gallery images:** upload from disk or pull from a URL, and fine-tune banner framing.

### 🎬 Trailers
- When metadata is applied, the title's **YouTube trailer is added automatically** and plays right inside the detail view.
- Optionally **download the trailer** to your machine for offline and iOS-friendly playback (needs `ffmpeg` installed).

### 🎭 People & collaboration
- A **People** directory for voice actors, staff, and creators, with portraits, native names, birthdays, and bios.
- The index is sorted by **surname**, so people line up the way a real index should.
- **Collaborate / "Together on":** select two or more people and the app shows **every title they worked on together** — great for spotting favourite voice-actor pairings.
- Hit **🎭 Show characters** to line up the **character portraits** each person played, title by title, with the actor's name and the character underneath.

### 🎵 Music
- Link a soundtrack to any title by **pasting the path to its album folder** on your machine — albums and tracks are detected automatically, complete with cover art.
- A **floating player** with a track list, cover zoom, and a volume slider that remembers your setting.
- A dedicated **Music library** page that gathers every title you've linked music to.
- **Autoplay options** in Settings: choose whether opening a title's music tab starts playing on its own.

### 🎨 Make it yours
- Rename the archive title and subtitle.
- Pick your **accent, secondary, and background colours**.
- Rotating **header images** with upload and gallery support.

---

## 🧩 Installing

**Requirements:** Python 3.9+ (3.11 recommended). `ffmpeg` is optional — only needed if you want to download trailers for offline playback.

Clone the repository and run the launcher:

```bash
git clone https://github.com/DaroHacka/otaku-archive.git
cd otaku-archive
python Otaku_Archive.py
```

The launcher takes care of everything on first run:

1. Creates a Python **virtual environment** and installs the requirements.
2. Asks **where your archive should store its data** (defaults to a `data/` folder next to the app).
3. Asks **where your music library lives**.
4. Asks which **ports** to use for the backend and the web interface (defaults: `9001` and `3012`).
5. Optionally sets the archive up to **start automatically on boot** (Linux/systemd).
6. Starts the servers and prints the address to open.

Then open the address it shows, e.g. **http://localhost:3012** — or, from another device on your network, `http://<your-local-ip>:3012`.

Your settings live in `.otaku_archive.conf` next to the app, so you can re-run `python Otaku_Archive.py` any time to start it again. Press **Ctrl+C** to stop.

### Under the hood
- **Backend:** FastAPI + Uvicorn, serving a JSON API.
- **Frontend:** plain HTML/CSS/JavaScript, served as static files.
- **Database:** a single SQLite file (`db/otaku.db`), created automatically and empty on first run — the framework ships without any data, and you curate your own.
- **Metadata:** AniList GraphQL (`https://graphql.anilist.co`) — public, no API key required. An internet connection is needed to fetch metadata.

---

## 📖 A quick tour

**Adding a title.** Click **➕ Add Title**, then either type one title or switch to **Paste List** and drop in as many as you like. New titles start with a placeholder poster.

**Fetching the real data.** Open a title → use the metadata search (**Found on AniList**) to match it to AniList and apply the full record in one go, or run a **bulk fetch** from the toolbar to enrich a batch.

**Tracking progress.** In the **Episodes / Chapters** tab, generate the entries, then tick them off. Mark whole titles with a status (Watching, Completed, …) and a ⭐ from the title card.

**Linking music.** Open a title's **🎵 Music** tab and paste the path to the album folder on your machine (it must sit inside the music library you configured during setup). The player appears automatically.

**Comparing people.** In **🎭 People**, pick two or more names, and the **Together on** panel lists the titles they share. Toggle **Show characters** to see the characters they each voiced, side by side.

---

## 📂 Project structure

```
otaku-archive/
├── Otaku_Archive.py     # installer + launcher
├── main.py              # FastAPI backend (API, metadata, music, trailers)
├── index.html           # UI markup
├── app.js               # UI logic
├── style.css            # styling
├── requirements.txt
├── ico/                 # icons
├── fonts/               # pixel font used in the music player
├── preview/             # README screenshots
├── theme_images/        # user theme assets
├── data/                # ← your archive data (created on setup; git-ignored)
│   ├── covers/  banners/  headers/  trailers/  gallery/
│   └── music/           # ← your music library
└── db/                  # ← SQLite database (created on first run; git-ignored)
```

The `data/`, `db/`, and `preview/` contents are yours; the rest is the framework. Nothing personal is committed to the repository.

---

## 📜 License

MIT — see [LICENSE](LICENSE). Use it, fork it, make it yours.
