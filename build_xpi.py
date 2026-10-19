# -*- coding: utf-8 -*-
"""Build zotero-collection-count.xpi, mirroring the zip construction of
known-working Zotero 10 plugins (e.g. MuiseDestiny's zotero-style/zotero-gpt):
  - flat layout, files at zip root, forward-slash arcnames
  - no wrapper directory, no directory entries (Firefox doesn't need them)
  - create_system = 3 (Unix), external attrs 0644, deflate compression
  - bootstrap.js first, then manifest.json, then icons (entry order irrelevant,
    but mirrors the reference builds)
"""
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "zotero-collection-count.xpi")
FILES = ["bootstrap.js", "manifest.json", "icons/48.png", "icons/96.png"]


def main():
    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in FILES:
            src = os.path.join(HERE, *rel.split("/"))
            if not os.path.isfile(src):
                sys.exit("missing file: " + rel)
            zi = zipfile.ZipInfo.from_file(src, rel)
            zi.create_system = 3               # Unix, like the reference plugins
            zi.external_attr = 0o644 << 16     # rw-r--r--
            zi.compress_type = zipfile.ZIP_DEFLATED
            try:
                zi.flag_bits = 0x800           # UTF-8 filename flag
            except Exception:
                pass
            with open(src, "rb") as f:
                data = f.read()
            zf.writestr(zi, data)
    print("built:", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
