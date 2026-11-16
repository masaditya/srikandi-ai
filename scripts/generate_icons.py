#!/usr/bin/env python3
"""Generate ikon extension (PNG) tanpa dependensi eksternal.

Gambar: rounded-rectangle gradient indigo→violet dengan "sparkle" putih
(4-sudut) di tengah — sesuai identitas SRIKANDI Naskah AI.

Jalankan:  python3 scripts/generate_icons.py
Hasil:     extension/icons/icon{16,48,128}.png
"""
import math
import os
import struct
import zlib


def clamp01(v: float) -> float:
    return 0.0 if v < 0 else (1.0 if v > 1 else v)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def inside_rounded(u: float, v: float, r: float) -> bool:
    """u,v di [0,1]; r = radius sudut (proporsi)."""
    x, y = u, v
    if x < 0 or x > 1 or y < 0 or y > 1:
        return False
    if x < r and y < r:
        return (x - r) ** 2 + (y - r) ** 2 <= r * r
    if x > 1 - r and y < r:
        return (x - (1 - r)) ** 2 + (y - r) ** 2 <= r * r
    if x < r and y > 1 - r:
        return (x - r) ** 2 + (y - (1 - r)) ** 2 <= r * r
    if x > 1 - r and y > 1 - r:
        return (x - (1 - r)) ** 2 + (y - (1 - r)) ** 2 <= r * r
    return True


def inside_sparkle(u: float, v: float, cx: float, cy: float, r: float, power: float = 1.6) -> bool:
    """Bintang 4-sudut: radius sudut θ = r*|cos(2θ)|^power."""
    du, dv = u - cx, v - cy
    rho = math.hypot(du, dv)
    if rho == 0:
        return True
    if rho > r:
        return False
    theta = math.atan2(dv, du)
    return rho <= r * abs(math.cos(2 * theta)) ** power


def render_supersampled(size: int) -> list:
    ss = 4  # supersampling
    S = size * ss
    buf = [[(0, 0, 0, 0)] * S for _ in range(S)]
    # warna gradient: indigo #4F46E5 (79,70,229) → violet #9333EA (147,51,234)
    for y in range(S):
        yn = (y + 0.5) / S
        row = buf[y]
        for x in range(S):
            xn = (x + 0.5) / S
            if not inside_rounded(xn, yn, 0.22):
                continue
            t = (xn + yn) / 2
            rr = lerp(79, 147, t)
            gg = lerp(70, 51, t)
            bb = lerp(229, 234, t)
            shade = 1.0 - 0.18 * (yn ** 3)  # shade halus agar tampak "3D"
            rr *= shade
            gg *= shade
            bb *= shade
            white = inside_sparkle(xn, yn, 0.47, 0.50, 0.30) or (
                math.hypot(xn - 0.74, yn - 0.26) <= 0.075
            )
            row[x] = (255, 255, 255, 255) if white else (int(rr), int(gg), int(bb), 255)
    return buf


def downsample(buf, size: int, ss: int) -> bytearray:
    """Rata-rata ss×ss sampel menjadi satu piksel output."""
    px = bytearray()
    S = size * ss
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = a = 0
            for dy in range(ss):
                src = buf[y * ss + dy]
                for dx in range(ss):
                    pr, pg, pb, pa = src[x * ss + dx]
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            n = a  # total alpha sampel → warna truecolor = Σ(color·α)/Σα
            if n > 0:
                r, g, b = r / n, g / n, b / n
            row += bytes((int(r), int(g), int(b), int(a / (ss * ss))))
        px += bytes([0]) + bytes(row)
    return px


def make_icon(size: int) -> bytes:
    ss = 4
    buf = render_supersampled(size)
    px = downsample(buf, size, ss)

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(px), 9))
        + chunk(b"IEND", b"")
    )
    return png


def main() -> None:
    out = os.path.join(os.path.dirname(__file__), "..", "extension", "icons")
    os.makedirs(out, exist_ok=True)
    for size in (16, 48, 128):
        path = os.path.join(out, f"icon{size}.png")
        with open(path, "wb") as f:
            f.write(make_icon(size))
        print(f"tulis {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
