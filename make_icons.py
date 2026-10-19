#!/usr/bin/env python3
"""Generate simple 48/96 PNG icons for the Collection Count plugin (pure stdlib)."""
import struct
import zlib
import os

BASE = os.path.dirname(os.path.abspath(__file__))


def png_bytes(width, height, pixel_fn):
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter: none
        for x in range(width):
            raw.extend(pixel_fn(x, y, width, height))
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def icon_pixel(x, y, w, h):
    # Rounded-square blue background
    r = w * 0.18
    inset = w * 0.04
    x0, y0, x1, y1 = inset, inset, w - inset, h - inset
    dx = max(x0 - x, x - x1, 0)
    dy = max(y0 - y, y - y1, 0)
    if dx * dx + dy * dy > r * r:
        # outside the rounded square, but inside the corner region check
        if x < x0 and y < y0:
            pass
        elif x > x1 and y > y1:
            pass
        elif x < x0 and y > y1:
            pass
        elif x > x1 and y < y0:
            pass
        else:
            return (0, 0, 0, 0)
    # inside rounded square
    # draw a white "#" glyph
    s = w / 48.0
    # two vertical strokes
    def in_rect(x, y, rx, ry, rw, rh):
        return rx <= x < rx + rw and ry <= y < ry + rh
    strokes = [
        (20 * s, 9 * s, 4 * s, 30 * s),
        (24 * s, 9 * s, 4 * s, 30 * s),
        (8 * s, 14 * s, 32 * s, 4 * s),
        (8 * s, 30 * s, 32 * s, 4 * s),
    ]
    for (rx, ry, rw, rh) in strokes:
        if in_rect(x, y, rx, ry, rw, rh):
            return (255, 255, 255, 255)
    return (61, 133, 255, 255)  # #3D85FF


def main():
    for size in (48, 96):
        data = png_bytes(size, size, icon_pixel)
        out = os.path.join(BASE, "icons", "%d.png" % size)
        with open(out, "wb") as f:
            f.write(data)
        print("wrote", out, len(data), "bytes")


if __name__ == "__main__":
    main()
