#!/usr/bin/env python3
"""
Every app icon, from the one brand file.

    python3 -m venv .venv && .venv/bin/pip install Pillow
    .venv/bin/python web/scripts/generate_icons.py

Source: web/public/Jewel P Icon.png — a pure-white crowned P in a circle on transparency, with
"SINCE 1990" beneath it. Two things about that file drive everything here.

WHY THE MARK IS CROPPED
"SINCE 1990" is 40px tall in a 650px image. On a 48dp launcher icon it is under three pixels — not
small text but a grey smudge under the logo, and it steals the room the P needs to be recognisable.
The circle occupies y 1..563 and the words sit at y 609..648 with a clean gap between, so the crop
is exact rather than a guess. Measured, not eyeballed: see the band analysis in the git history.

WHY THERE IS A BACKGROUND
The mark is pure white with no outline. On a white or light surface it is invisible — which is
precisely what happened when the file was opened in a previewer and came back blank. Every icon
below therefore carries #080d0b behind it, which is already the manifest's background_color and the
dark theme-color, so the icon, the splash and the installed title bar are one colour rather than
three near-misses.

WHY EACH SIZE HAS ITS OWN INSET
A circular mark inside a square frame reads smaller than a square one at the same width, so it is
set larger than a naive "leave 10% padding" rule. Where the platform crops, the inset is dictated by
the platform and not by taste:

  maskable / Android adaptive — the launcher may crop to a circle inscribed in the inner 80%, and
      Android's own guidance keeps content inside 66 of 108 units. Anything outside can be cut off,
      so these get the smallest mark.
  iOS — supplies its own rounded mask and rejects alpha entirely, so the canvas is flat and square.
  favicon — rendered at 16px in a browser tab; the crown is the first thing to turn to mush, so the
      mark is given nearly the whole frame.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'web' / 'public' / 'Jewel P Icon.png'
PUBLIC = ROOT / 'web' / 'public'
ANDROID_RES = ROOT / 'android' / 'app' / 'src' / 'main' / 'res'
IOS_APPICON = ROOT / 'ios' / 'App' / 'App' / 'Assets.xcassets' / 'AppIcon.appiconset'

BG = (8, 13, 11, 255)          # #080d0b — the manifest's background_color and dark theme-color
SUPERSAMPLE = 4                # draw large, resample down once; keeps the crown's dots clean


def load_mark() -> Image.Image:
    """The circled crowned P alone, trimmed to its own bounds and squared."""
    im = Image.open(SOURCE).convert('RGBA')
    alpha = im.split()[3]
    width, height = im.size

    # Find rows that carry any ink, then take the FIRST contiguous band — the circle. The wordmark
    # below it is a second band, separated by a gap of empty rows, so this drops it without a
    # hardcoded pixel row that would silently mis-crop if the source is ever re-exported.
    rows = [any(alpha.getpixel((x, y)) > 128 for x in range(width)) for y in range(height)]
    top = rows.index(True)
    bottom = top
    while bottom + 1 < height and rows[bottom + 1]:
        bottom += 1

    band = im.crop((0, top, width, bottom + 1))
    box = band.split()[3].getbbox()
    mark = band.crop(box)

    # Square it on transparency so every later paste is a plain centred resize.
    side = max(mark.size)
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.paste(mark, ((side - mark.width) // 2, (side - mark.height) // 2), mark)
    return square


def load_inner_mark(mark: Image.Image) -> Image.Image:
    """The crowned P without its surrounding ring — the mark simplified for tiny sizes.

    A 16px favicon cannot hold this logo. Measured across the centre row, the ring is 33px of 564,
    so at 16px it lands on under one pixel and renders as a grey halo, while the crown — the thing
    that makes it *this* company's P — disappears into it entirely. Dropping the ring gives the P
    and its crown the whole frame, which is the usual answer for a mark that has to survive a
    browser tab, and it is still recognisably the same logo.

    The ring is found rather than assumed: walking in from the edge along the centre row gives its
    thickness, so a re-exported source with a different weight still crops correctly.
    """
    width, _ = mark.size
    alpha = mark.split()[3]
    centre = width // 2

    # Step over any transparent margin first. Starting the measurement at x=0 finds nothing — the
    # source has a row of empty pixels down its edge — and yields a thickness of zero, which crops
    # nothing at all and quietly hands back the full mark.
    x = 0
    while x < width and alpha.getpixel((x, centre)) <= 128:
        x += 1
    ring_start = x
    while x < width and alpha.getpixel((x, centre)) > 128:
        x += 1
    ring_thickness = x - ring_start

    # Erase everything outside the ring's INNER circle. A square crop looks like it works and does
    # not: it clears the ring where it runs closest to each edge and leaves four arcs of it sitting
    # in the corners, which at 16px read as a broken box around the letter.
    outer_radius = width / 2 - ring_start
    inner_radius = outer_radius - ring_thickness
    keep = Image.new('L', (width, width), 0)
    draw = ImageDraw.Draw(keep)
    # A shade inside the measured radius, so no anti-aliased fringe of the ring survives.
    r = inner_radius * 0.97
    draw.ellipse((width / 2 - r, width / 2 - r, width / 2 + r, width / 2 + r), fill=255)

    inner = mark.copy()
    inner.putalpha(Image.composite(inner.split()[3], Image.new('L', (width, width), 0), keep))

    box = inner.split()[3].getbbox()
    inner = inner.crop(box)

    side = max(inner.size)
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.paste(inner, ((side - inner.width) // 2, (side - inner.height) // 2), inner)
    return square


def canvas(size: int, *, radius_ratio: float | None, transparent: bool = False) -> Image.Image:
    """A background plate. radius_ratio None = square, 0.5 = circle."""
    big = size * SUPERSAMPLE
    plate = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    if not transparent:
        draw = ImageDraw.Draw(plate)
        if radius_ratio is None:
            draw.rectangle((0, 0, big, big), fill=BG)
        else:
            draw.rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * radius_ratio), fill=BG)
    return plate


def compose(mark: Image.Image, size: int, scale: float, *,
            radius_ratio: float | None = None, transparent: bool = False,
            flatten: bool = False) -> Image.Image:
    """Centre `mark` at `scale` of the width on a plate, rendered big and resampled down."""
    big = size * SUPERSAMPLE
    plate = canvas(size, radius_ratio=radius_ratio, transparent=transparent)

    target = max(1, int(big * scale))
    scaled = mark.resize((target, target), Image.LANCZOS)
    offset = (big - target) // 2
    plate.alpha_composite(scaled, (offset, offset))

    out = plate.resize((size, size), Image.LANCZOS)
    if flatten:
        # iOS rejects an alpha channel in the app icon outright.
        flat = Image.new('RGB', (size, size), BG[:3])
        flat.paste(out, (0, 0), out)
        return flat
    return out


def write(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)
    print(f'  {path.relative_to(ROOT)}  {image.size[0]}x{image.size[1]}')


def main() -> None:
    mark = load_mark()
    print(f'mark cropped to {mark.size[0]}x{mark.size[1]} from {SOURCE.name}\n')

    # --- web -------------------------------------------------------------------------------------
    print('web/public:')
    write(compose(mark, 192, 0.74, radius_ratio=0.22), PUBLIC / 'pwa-icon-192.png')
    write(compose(mark, 512, 0.74, radius_ratio=0.22), PUBLIC / 'pwa-icon-512.png')
    # Maskable: the launcher may crop to the inner 80%, so the mark stays well inside that.
    write(compose(mark, 512, 0.60, radius_ratio=None), PUBLIC / 'pwa-maskable-512.png')
    # Apple touch icons are composited on white if they carry alpha, so this one is flattened.
    write(compose(mark, 180, 0.76, radius_ratio=0.22, flatten=True), PUBLIC / 'pwa-icon-180.png')
    # In-app: white mark on transparency, tinted by CSS where it is used.
    write(compose(mark, 256, 1.0, transparent=True), PUBLIC / 'brand-mark.png')

    # 16px gets the ring dropped; 32 and 48 keep the full mark. index.html declares all three with
    # explicit sizes so the browser picks per context rather than downscaling one file into mush —
    # which is the thing a single SVG favicon cannot do.
    inner = load_inner_mark(mark)
    write(compose(inner, 16, 0.80, radius_ratio=0.18), PUBLIC / 'favicon-16.png')
    write(compose(mark, 32, 0.86, radius_ratio=0.18), PUBLIC / 'favicon-32.png')
    write(compose(mark, 48, 0.86, radius_ratio=0.18), PUBLIC / 'favicon-48.png')

    # The .ico carries the same per-size art rather than one image resampled three ways.
    ico_16 = compose(inner, 16, 0.80, radius_ratio=0.18)
    ico_32 = compose(mark, 32, 0.86, radius_ratio=0.18)
    ico_48 = compose(mark, 48, 0.86, radius_ratio=0.18)
    ico_48.save(PUBLIC / 'favicon.ico', append_images=[ico_32, ico_16])
    print(f'  {(PUBLIC / "favicon.ico").relative_to(ROOT)}  48/32/16')

    # --- android ---------------------------------------------------------------------------------
    # Legacy icons are the full artwork; the adaptive foreground is the mark alone on transparency,
    # because the launcher draws ic_launcher_background behind it and composites the two.
    print('\nandroid:')
    for folder, legacy, foreground in (
        ('mdpi', 48, 108), ('hdpi', 72, 162), ('xhdpi', 96, 216),
        ('xxhdpi', 144, 324), ('xxxhdpi', 192, 432),
    ):
        out = ANDROID_RES / f'mipmap-{folder}'
        write(compose(mark, legacy, 0.74, radius_ratio=0.22), out / 'ic_launcher.png')
        write(compose(mark, legacy, 0.74, radius_ratio=0.5), out / 'ic_launcher_round.png')
        # 66 of 108 units is Android's safe zone for adaptive icons.
        write(compose(mark, foreground, 66 / 108, transparent=True), out / 'ic_launcher_foreground.png')

    # --- ios -------------------------------------------------------------------------------------
    print('\nios:')
    write(compose(mark, 1024, 0.76, radius_ratio=None, flatten=True), IOS_APPICON / 'AppIcon-512@2x.png')

    print('\ndone.')


if __name__ == '__main__':
    main()
