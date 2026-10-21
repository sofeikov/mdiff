"""Converts the 24-bit XWD screen dumps in a folder to PNG files next to them.

Usage: python3 scripts/xwd2png.py FOLDER
"""

import struct
import sys
from pathlib import Path

from PIL import Image


def read_xwd(path: Path) -> Image.Image:
    data = path.read_bytes()
    # The header is 25 big-endian 32-bit fields, then the window name.
    fields = struct.unpack(">25I", data[:100])
    header_size = fields[0]
    width, height = fields[4], fields[5]
    byte_order = fields[7]
    bits_per_pixel = fields[11]
    bytes_per_line = fields[12]
    ncolors = fields[19]
    if bits_per_pixel != 32:
        raise ValueError(f"{path}: {bits_per_pixel} bits per pixel is not supported")
    offset = header_size + ncolors * 12
    pixels = data[offset : offset + bytes_per_line * height]
    # LSBFirst stores each pixel as B, G, R, X.
    raw_mode = "BGRX" if byte_order == 0 else "XRGB"
    return Image.frombuffer("RGB", (width, height), pixels, "raw", raw_mode, bytes_per_line, 1)


def main() -> None:
    folder = Path(sys.argv[1])
    for xwd in sorted(folder.glob("*.xwd")):
        png = xwd.with_suffix(".png")
        read_xwd(xwd).save(png, optimize=True)
        print(png)


if __name__ == "__main__":
    main()
