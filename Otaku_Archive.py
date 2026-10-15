#!/usr/bin/env python3
"""
Otaku Archive - installer & launcher
A personal, self-hosted anime & manga archive.

First run:
  1. creates a virtual environment and installs requirements
  2. asks where your archive data lives, and which ports to use
  3. writes .otaku_archive.conf (portable, absolute paths) + config.js
  4. starts the backend (FastAPI :<backend_port>) and static frontend (:<frontend_port>)

Run it again any time to just start the servers. Press Ctrl+C to stop.

On Linux with systemd you can also opt into auto-start on boot.
"""

import json
import os
import shutil
import socket
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(SCRIPT_DIR, ".otaku_archive.conf")
CONFIG_JS = os.path.join(SCRIPT_DIR, "config.js")
REQUIREMENTS_FILE = os.path.join(SCRIPT_DIR, "requirements.txt")
VENV_DIR = os.path.join(SCRIPT_DIR, "venv")
DEFAULT_BACKEND_PORT = 9001
DEFAULT_FRONTEND_PORT = 3012
SERVICE_NAME = "otaku-archive"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def is_windows():
    return os.name == "nt"


def venv_python():
    if is_windows():
        return os.path.join(VENV_DIR, "Scripts", "python.exe")
    return os.path.join(VENV_DIR, "bin", "python")


def venv_pip():
    if is_windows():
        return os.path.join(VENV_DIR, "Scripts", "pip.exe")
    return os.path.join(VENV_DIR, "bin", "pip")


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "localhost"


def port_in_use(port):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            return s.connect_ex(("127.0.0.1", port)) == 0
    except Exception:
        return False


def ask(prompt, default):
    raw = input(f"{prompt} [{default}]: ").strip()
    return raw or str(default)


def ask_port(prompt, default):
    while True:
        raw = input(f"{prompt} [{default}]: ").strip()
        if not raw:
            return default
        if raw.isdigit() and 1 <= int(raw) <= 65535:
            return int(raw)
        print("  Please enter a number between 1 and 65535.")


def ask_yes_no(prompt, default=False):
    suffix = "[Y/n]" if default else "[y/N]"
    raw = input(f"{prompt} {suffix}: ").strip().lower()
    if not raw:
        return default
    return raw in ("y", "yes")


def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_config(config):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)


def write_config_js(backend_port):
    with open(CONFIG_JS, "w", encoding="utf-8") as f:
        f.write(f"window.OTAKU_BACKEND_PORT = {backend_port};\n")


# ---------------------------------------------------------------------------
# Requirements
# ---------------------------------------------------------------------------

def requirements_ok():
    py = venv_python()
    if not os.path.exists(py):
        return False
    try:
        r = subprocess.run([py, "-m", "pip", "show", "fastapi"],
                           capture_output=True, text=True)
        return r.returncode == 0
    except Exception:
        return False


def install_requirements():
    print("\nSetting up the Python environment (this may take a minute)...")
    if not os.path.exists(VENV_DIR):
        subprocess.run([sys.executable, "-m", "venv", VENV_DIR], check=True)
    subprocess.run([venv_python(), "-m", "pip", "install", "--upgrade", "pip"],
                   check=False)
    subprocess.run([venv_pip(), "install", "-r", REQUIREMENTS_FILE], check=True)
    print("Environment ready.")


# ---------------------------------------------------------------------------
# Configuration wizard
# ---------------------------------------------------------------------------

def configure(first_run):
    config = load_config()

    if not first_run:
        # Only fill in anything that is missing.
        if all(k in config for k in
               ("data_dir", "music_dir", "backend_port", "frontend_port")):
            return config

    print("\n" + "=" * 60)
    print("  OTAKU ARCHIVE - SETUP")
    print("=" * 60)
    print("Press Enter to accept each default.\n")

    default_data = config.get("data_dir") or os.path.join(SCRIPT_DIR, "data")
    data_dir = os.path.abspath(os.path.expanduser(
        ask("Where should the archive store its data (covers, banners, trailers, ...)?", default_data)))
    os.makedirs(data_dir, exist_ok=True)

    default_music = config.get("music_dir") or os.path.join(data_dir, "music")
    music_dir = os.path.abspath(os.path.expanduser(
        ask("Where is your music library located?", default_music)))
    os.makedirs(music_dir, exist_ok=True)

    backend_port = ask_port("Backend (API) port", config.get("backend_port", DEFAULT_BACKEND_PORT))
    frontend_port = ask_port("Frontend (web) port", config.get("frontend_port", DEFAULT_FRONTEND_PORT))

    if frontend_port == backend_port:
        print("  Frontend and backend can't share a port; using defaults for both.")
        backend_port, frontend_port = DEFAULT_BACKEND_PORT, DEFAULT_FRONTEND_PORT

    config.update({
        "data_dir": data_dir,
        "music_dir": music_dir,
        "backend_port": backend_port,
        "frontend_port": frontend_port,
    })

    if first_run:
        if not is_windows() and shutil.which("systemctl"):
            print("\nStart Otaku Archive automatically on boot? (Linux systemd)")
            config["auto_boot"] = ask_yes_no("Enable auto-start on boot?", False)
        else:
            config["auto_boot"] = False
    config.setdefault("auto_boot", False)

    save_config(config)
    write_config_js(backend_port)
    print("\nConfiguration saved to .otaku_archive.conf")
    return config


# ---------------------------------------------------------------------------
# Auto-start (Linux systemd user service)
# ---------------------------------------------------------------------------

def setup_autostart(config):
    if not shutil.which("systemctl"):
        print("Auto-start: systemd not found; skipping (start it manually or add your own boot entry).")
        return
    unit_dir = os.path.expanduser("~/.config/systemd/user")
    os.makedirs(unit_dir, exist_ok=True)
    unit_path = os.path.join(unit_dir, f"{SERVICE_NAME}.service")
    py = venv_python()
    unit = f"""[Unit]
Description=Otaku Archive (anime & manga archive)
After=network.target

[Service]
Type=simple
WorkingDirectory={SCRIPT_DIR}
Environment=OTAKU_DATA_DIR={config['data_dir']}
Environment=OTAKU_MUSIC_DIR={config['music_dir']}
Environment=OTAKU_BACKEND_PORT={config['backend_port']}
ExecStart={py} {os.path.join(SCRIPT_DIR, 'main.py')}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
"""
    with open(unit_path, "w", encoding="utf-8") as f:
        f.write(unit)
    # Frontend service
    fe_path = os.path.join(unit_dir, f"{SERVICE_NAME}-frontend.service")
    fe = f"""[Unit]
Description=Otaku Archive frontend (static)
After=network.target

[Service]
Type=simple
WorkingDirectory={SCRIPT_DIR}
ExecStart={sys.executable} -m http.server {config['frontend_port']}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
"""
    with open(fe_path, "w", encoding="utf-8") as f:
        f.write(fe)
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
    subprocess.run(["systemctl", "--user", "enable", "--now",
                    f"{SERVICE_NAME}.service", f"{SERVICE_NAME}-frontend.service"], check=False)
    print("Auto-start enabled (systemd user services). Disable with:")
    print(f"  systemctl --user disable --now {SERVICE_NAME} {SERVICE_NAME}-frontend")


def disable_autostart():
    if shutil.which("systemctl"):
        subprocess.run(["systemctl", "--user", "disable", "--now",
                        f"{SERVICE_NAME}.service", f"{SERVICE_NAME}-frontend.service"], check=False)


# ---------------------------------------------------------------------------
# Servers
# ---------------------------------------------------------------------------

def start_servers(config):
    data_dir = config["data_dir"]
    music_dir = config["music_dir"]
    backend_port = config["backend_port"]
    frontend_port = config["frontend_port"]

    env = os.environ.copy()
    env["OTAKU_DATA_DIR"] = data_dir
    env["OTAKU_MUSIC_DIR"] = music_dir
    env["OTAKU_BACKEND_PORT"] = str(backend_port)

    if port_in_use(backend_port):
        print(f"\nPort {backend_port} is already in use. Is Otaku Archive already running?")
        sys.exit(1)
    if port_in_use(frontend_port):
        print(f"\nPort {frontend_port} is already in use.")
        sys.exit(1)

    local_ip = get_local_ip()
    print("\n" + "=" * 60)
    print("  OTAKU ARCHIVE")
    print("=" * 60)
    print(f"\n  Data:  {data_dir}")
    print(f"  Music: {music_dir}")
    print(f"\n  ➤ To access from this computer, open:")
    print(f"      http://localhost:{frontend_port}")
    print(f"\n  ➤ To access from another device on your network, open:")
    print(f"      http://{local_ip}:{frontend_port}")
    print("\n" + "-" * 60)
    print("  Press Ctrl+C to stop.")
    print("-" * 60 + "\n")

    backend = subprocess.Popen([venv_python(), "main.py"], cwd=SCRIPT_DIR, env=env)
    frontend = subprocess.Popen([sys.executable, "-m", "http.server", str(frontend_port)],
                                cwd=SCRIPT_DIR)

    try:
        backend.wait()
    except KeyboardInterrupt:
        print("\nStopping servers...")
    finally:
        for proc in (backend, frontend):
            if proc.poll() is None:
                proc.terminate()
        for proc in (backend, frontend):
            try:
                proc.wait(timeout=5)
            except Exception:
                proc.kill()
        print("Stopped.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    os.chdir(SCRIPT_DIR)

    first_run = not os.path.exists(CONFIG_FILE)

    if not requirements_ok():
        install_requirements()

    config = configure(first_run)

    if config.get("auto_boot"):
        setup_autostart(config)
    else:
        disable_autostart()

    start_servers(config)


if __name__ == "__main__":
    main()
