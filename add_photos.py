#!/usr/bin/env python3
"""Sync event photos/videos into the website gallery.

Usage:
    python3 add_photos.py                # syncs ../PHOTOS (default)
    python3 add_photos.py /other/folder  # syncs another folder

Each subfolder of the source is a category (e.g. PHOTOS/MAIN STAGE ->
"Main Stage"). Photos (JPG/PNG/HEIC/TIFF/WEBP) get a 2048px full version and
a 720px thumbnail via macOS `sips`. Videos (MP4/MOV/M4V) are re-encoded to
1080p with `avconvert` and get a poster via Quick Look.

Files already processed are skipped, files still being copied are skipped
until the next run, and anything deleted from the source is removed from
the gallery — so just re-run it whenever the folder changes.
"""
import glob, hashlib, json, os, re, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SRC = os.path.join(HERE, "..", "PHOTOS")
GALLERY = os.path.join(HERE, "gallery")
FULL, VIDEO, THUMB = (os.path.join(GALLERY, d) for d in ("full", "video", "thumbs"))
META = os.path.join(GALLERY, "meta.json")
PHOTO_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".tif", ".tiff", ".webp"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v"}
QUIET = dict(check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# Categories listed here come first, in this order; any others follow A–Z.
PRIORITY = ["Main Stage"]


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "media"


def natural(s):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s.lower())]


def category_of(rel):
    parts = rel.split(os.sep)
    return parts[0].strip().title() if len(parts) > 1 else "General"


def dims(path):
    out = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
                         capture_output=True, text=True).stdout
    w = int(re.search(r"pixelWidth: (\d+)", out).group(1))
    h = int(re.search(r"pixelHeight: (\d+)", out).group(1))
    return w, h


def resize(src, dst, size, quality):
    size = min(size, max(dims(src)))  # never upscale
    subprocess.run(["sips", "-Z", str(size), "-s", "format", "jpeg",
                    "-s", "formatOptions", str(quality), src, "--out", dst], **QUIET)


def do_photo(src, name):
    resize(src, os.path.join(FULL, name + ".jpg"), 2048, 66)
    resize(os.path.join(FULL, name + ".jpg"), os.path.join(THUMB, name + ".jpg"), 720, 64)


def do_video(src, name):
    out = os.path.join(VIDEO, name + ".mp4")
    try:
        subprocess.run(["avconvert", "--source", src, "--preset", "Preset1920x1080",
                        "--output", out, "--replace"], **QUIET)
    except subprocess.CalledProcessError:
        shutil.copy(src, out)  # fall back to the original file
    tmp = tempfile.mkdtemp()
    subprocess.run(["qlmanage", "-t", "-s", "1200", "-o", tmp, out], **QUIET)
    poster = glob.glob(os.path.join(tmp, "*.png"))
    if poster:
        resize(poster[0], os.path.join(THUMB, name + ".jpg"), 720, 64)
    shutil.rmtree(tmp, ignore_errors=True)


def fingerprint(path):
    """Cheap content ID: size + hash of the first and last 256 KB."""
    size = os.path.getsize(path)
    h = hashlib.md5(str(size).encode())
    with open(path, "rb") as f:
        h.update(f.read(262144))
        if size > 524288:
            f.seek(-262144, 2)
            h.update(f.read())
    return h.hexdigest()


def outputs(name, kind):
    main = os.path.join(VIDEO, name + ".mp4") if kind == "video" else os.path.join(FULL, name + ".jpg")
    return [main, os.path.join(THUMB, name + ".jpg")]


def main():
    src_dir = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC)
    for d in (FULL, VIDEO, THUMB):
        os.makedirs(d, exist_ok=True)

    # Only one run at a time (the watcher and a manual run must not overlap)
    lock = os.path.join(GALLERY, ".lock")
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode()); os.close(fd)
    except FileExistsError:
        try:
            pid = int(open(lock).read() or 0)
            os.kill(pid, 0)
            print("Another run is in progress; skipping.")
            return
        except (ValueError, ProcessLookupError, PermissionError):
            open(lock, "w").write(str(os.getpid()))  # stale lock
    try:
        sync(src_dir)
    finally:
        if os.path.exists(lock):
            os.remove(lock)


def sync(src_dir):
    meta = json.load(open(META)) if os.path.exists(META) else {}
    seen, done, used, prints, dupes = set(), 0, {}, {}, 0
    if os.path.isdir(src_dir):
        files = sorted((
            os.path.relpath(os.path.join(r, f), src_dir) for r, _, fs in os.walk(src_dir) for f in fs
            if os.path.splitext(f)[1].lower() in PHOTO_EXTS | VIDEO_EXTS and not f.startswith(".")
        ), key=natural)
        for i, rel in enumerate(files, 1):
            path = os.path.join(src_dir, rel)
            cat = category_of(rel)
            kind = "video" if os.path.splitext(rel)[1].lower() in VIDEO_EXTS else "photo"
            name = slug(os.path.splitext(rel)[0])  # full path, so same filenames in different folders don't clash
            if used.get(name, rel) != rel:  # e.g. "photo-.jpg" vs "photo.jpg"
                name += "-" + hashlib.md5(rel.encode()).hexdigest()[:6]
            used[name] = rel
            try:
                fp = meta[name]["fp"] if name in meta and meta[name].get("source") == rel and "fp" in meta[name] else fingerprint(path)
            except OSError:
                continue
            if fp in prints:  # the exact same photo is already in the gallery from another folder
                dupes += 1
                continue
            prints[fp] = name
            seen.add(name)
            if name in meta and meta[name].get("source") == rel and all(os.path.exists(p) for p in outputs(name, kind)):
                meta[name]["fp"] = fp
                continue
            try:
                size = os.path.getsize(path)
                time.sleep(0.2)
                if os.path.getsize(path) != size:  # still growing
                    print(f"  still copying, skipped for now: {rel}")
                    seen.discard(name)
                    continue
                print(f"[{i}/{len(files)}] {rel}")
                (do_video if kind == "video" else do_photo)(path, name)
            except (OSError, subprocess.CalledProcessError, AttributeError):
                print(f"  could not process (moved or unreadable), skipped: {rel}")
                seen.discard(name)
                continue
            meta[name] = {"cat": cat, "type": kind, "source": rel, "fp": fp}
            thumb = os.path.join(THUMB, name + ".jpg")
            if os.path.exists(thumb):
                meta[name]["w"], meta[name]["h"] = dims(thumb)
            done += 1
            if done % 25 == 0:
                write_out(meta)  # the site fills up as we go

        # Drop anything that was deleted from the source or turned out to be a duplicate
        for name in [n for n in meta if n not in seen]:
            if not os.path.exists(os.path.join(src_dir, meta[name]["source"])):
                print(f"  removed (no longer in source): {meta[name]['source']}")
            del meta[name]
        if dupes:
            print(f"  skipped {dupes} exact duplicate files")

    # Delete generated files that no longer belong to anything
    keep = {os.path.basename(p) for n, m in meta.items() for p in outputs(n, m["type"])}
    for d in (FULL, VIDEO, THUMB):
        for f in os.listdir(d):
            if f not in keep and not f.startswith("."):
                os.remove(os.path.join(d, f))

    write_out(meta)


def write_out(meta):
    def order(item):
        cat = item[1]["cat"]
        rank = PRIORITY.index(cat) if cat in PRIORITY else len(PRIORITY)
        return (rank, cat, natural(item[0]))

    media = []
    for name, m in sorted(meta.items(), key=order):
        entry = {"cat": m["cat"], "thumb": f"gallery/thumbs/{name}.jpg"}
        if m["type"] == "video":
            entry.update(type="video", src=f"gallery/video/{name}.mp4")
        else:
            entry["src"] = f"gallery/full/{name}.jpg"
        thumb = os.path.join(THUMB, name + ".jpg")
        if "w" not in m and os.path.exists(thumb):
            m["w"], m["h"] = dims(thumb)
        if "w" in m:
            entry["w"], entry["h"] = m["w"], m["h"]
        media.append(entry)

    tmp = META + ".tmp"
    json.dump(meta, open(tmp, "w"), indent=1)
    os.replace(tmp, META)
    js = os.path.join(GALLERY, "photos.js")
    with open(js + ".tmp", "w") as fh:
        fh.write("// Generated by add_photos.py — do not edit by hand.\n")
        fh.write("window.LMC_PHOTOS = " + json.dumps(media) + ";\n")
    os.replace(js + ".tmp", js)
    cats = sorted({m["cat"] for m in media})
    print(f"Gallery now has {len(media)} items across {len(cats)} categories: {', '.join(cats)}")

if __name__ == "__main__":
    main()
