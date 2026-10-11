# Renders the Airagram launcher icons into aipgram/branding/res (run: py -3 aipgram/branding/make_icons.py).
# Placeholder artwork until the final logo: a white "A" on an indigo-to-sky gradient. apply.js copies the
# result over every Telegram launcher icon so the app no longer carries the Telegram plane.
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "res")
FONT = r"C:\Windows\Fonts\segoeuib.ttf"
TOP, BOTTOM = (106, 90, 249), (43, 184, 245)
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def gradient(size):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
    return img


def glyph(size, scale):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    font = ImageFont.truetype(FONT, round(size * scale))
    box = draw.textbbox((0, 0), "A", font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    draw.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1]), "A", font=font, fill=(255, 255, 255, 255))
    return layer


def launcher(size, round_):
    big = size * 4
    img = gradient(big).convert("RGBA")
    img.alpha_composite(glyph(big, 0.62))
    mask = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(mask)
    if round_:
        d.ellipse((0, 0, big - 1, big - 1), fill=255)
    else:
        d.rounded_rectangle((0, 0, big - 1, big - 1), radius=big // 5, fill=255)
    img.putalpha(mask)
    return img.resize((size, size), Image.LANCZOS)


def save(img, *parts):
    path = os.path.join(OUT, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)


for name, k in DENSITIES.items():
    save(launcher(round(48 * k), False), "mipmap-" + name, "airagram_launcher.png")
    save(launcher(round(48 * k), True), "mipmap-" + name, "airagram_launcher_round.png")
    # adaptive icon layers: 108dp canvas, the glyph inside the 66dp safe zone
    fg = glyph(round(108 * k) * 4, 0.40).resize((round(108 * k),) * 2, Image.LANCZOS)
    save(fg, "mipmap-" + name, "airagram_foreground.png")
    save(gradient(round(108 * k)), "mipmap-" + name, "airagram_background.png")
save(launcher(512, False), "airagram_icon_512.png")
print("icons written to", OUT)
