#!/usr/bin/env python3
"""Builds Active's icon from source.svg (the original "code to words" A).

    python3 active/branding/build_icon.py

Writes icon.svg (the adjusted artwork), icon-512.png and Active.icns next to this file; scripts/apply_patches.py
copies them into Code OSS. macOS only: it renders with qlmanage and packs with iconutil; it needs Pillow.

The adjustments, all made by moving or thickening elements (nothing is skewed, so dashes stay flat and words
stay upright):
- The legs are made to lean equally. In the source the dash leg leans further than the word leg, so the A looks
  slanted; each element moves sideways in proportion to its height (a shear of its position only).
- The white parts are thickened: wider strokes, bigger dots, and an outline on the text.
- The artwork is centred on the canvas, then placed on Apple's icon grid (an 824px rounded square on 1024).
"""
import pathlib
import re
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw

HERE = pathlib.Path(__file__).resolve().parent

# How far each element moves sideways per unit of height from the middle row: half the difference between how
# much the two legs lean (dash leg centre 0.45, word leg 0.31).
SHEAR = 0.07
MIDDLE_ROW = 625
LINE_WIDTH = 1.8   # times the source stroke widths
DOT_RADIUS = 2.0   # times the source dot radii
TEXT_OUTLINE = 1.7  # outline width on the text, in canvas units


def adjust(svg: str) -> str:
    shift = lambda y: SHEAR * (float(y) - MIDDLE_ROW)
    svg = re.sub(r'x1="([\d.]+)" x2="([\d.]+)" y1="([\d.]+)"',
                 lambda m: f'x1="{float(m[1]) + shift(m[3]):.2f}" x2="{float(m[2]) + shift(m[3]):.2f}" y1="{m[3]}"', svg)
    svg = re.sub(r'<circle cx="([\d.]+)" cy="([\d.]+)"', lambda m: f'<circle cx="{float(m[1]) + shift(m[2]):.2f}" cy="{m[2]}"', svg)
    svg = re.sub(r'(<text[^>]*?) x="([\d.]+)" y="([\d.]+)"', lambda m: f'{m[1]} x="{float(m[2]) + shift(m[3]):.2f}" y="{m[3]}"', svg)
    svg = re.sub(r'stroke-width="([\d.]+)"', lambda m: f'stroke-width="{float(m[1]) * LINE_WIDTH:.2f}"', svg)
    svg = re.sub(r'(<circle[^>]*\br=")([\d.]+)"', lambda m: f'{m[1]}{float(m[2]) * DOT_RADIUS:.2f}"', svg)
    return svg.replace('<text fill="#FFFFFF"', f'<text fill="#FFFFFF" stroke="#FFFFFF" stroke-width="{TEXT_OUTLINE}" stroke-linejoin="round"')


def render(svg: str, size: int) -> Image.Image:
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / 'icon.svg'
        path.write_text(svg)
        subprocess.run(['qlmanage', '-t', '-s', str(size), '-o', tmp, str(path)], check=True, capture_output=True)
        return Image.open(pathlib.Path(tmp) / 'icon.svg.png').convert('RGBA')


def centred(svg: str) -> str:
    """Moves everything but the background so the white parts sit in the middle of the 1200-unit canvas."""
    image = render(svg, 2048)
    x0, y0, x1, y1 = image.convert('L').point(lambda v: 255 if v > 60 else 0).getbbox()
    unit = 1200 / image.width
    dx, dy = (1200 - (x0 + x1) * unit) / 2, (1200 - (y0 + y1) * unit) / 2
    background = '<rect fill="#000000" height="1200" width="1200" x="0" y="0" />'
    head, rest = svg.split(background, 1)
    body, tail = rest.rsplit('</svg>', 1)
    return f'{head}{background}<g transform="translate({dx:.1f} {dy:.1f})">{body}</g></svg>{tail}'


def main() -> None:
    svg = centred(adjust((HERE / 'source.svg').read_text()))
    (HERE / 'icon.svg').write_text(svg)
    canvas, body = 1024, 824
    art = render(svg, 2048).resize((body, body), Image.LANCZOS)
    mask = Image.new('L', (body * 4, body * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, body * 4 - 1, body * 4 - 1), radius=185 * 4, fill=255)
    icon = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    icon.paste(art, ((canvas - body) // 2, (canvas - body) // 2), mask.resize((body, body), Image.LANCZOS))
    icon.resize((512, 512), Image.LANCZOS).save(HERE / 'icon-512.png')
    with tempfile.TemporaryDirectory() as tmp:
        iconset = pathlib.Path(tmp) / 'Active.iconset'
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            icon.resize((size, size), Image.LANCZOS).save(iconset / f'icon_{size}x{size}.png')
            icon.resize((size * 2, size * 2), Image.LANCZOS).save(iconset / f'icon_{size}x{size}@2x.png')
        subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(pathlib.Path(tmp) / 'Active.icns')], check=True)
        shutil.copyfile(pathlib.Path(tmp) / 'Active.icns', HERE / 'Active.icns')
    print('built icon.svg, icon-512.png and Active.icns')


if __name__ == '__main__':
    main()
