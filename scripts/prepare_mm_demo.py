"""Local synthetic fixtures only; no model output or real student data."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

candidates = [
    str(Path.home() / '.fonts' / 'LXGWWenKai-Medium.ttf'),
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/System/Library/Fonts/PingFang.ttc',
]
font_path = next((c for c in candidates if Path(c).exists()), None)
font = ImageFont.truetype(font_path, 42) if font_path else ImageFont.load_default()

im = Image.new('RGB', (900, 650), '#f9f5e8')
d = ImageDraw.Draw(im)
for y in range(160, 630, 65):
    d.line((35, y, 865, y), fill='#cad4dc', width=2)
for text, xy in [
    ('测试图，非真实作业', (45, 40)),
    ('小数乘法练习', (65, 130)),
    ('0.3 × 0.2 = 0.6', (85, 238)),
    ('我的想法：3 × 2 = 6', (72, 330)),
    ('所以答案是 0.6', (100, 425)),
]:
    layer = Image.new('RGBA', (830, 75))
    ImageDraw.Draw(layer).text((4, 4), text, font=font, fill='#34436b')
    layer = layer.rotate(-1.2, resample=Image.Resampling.BICUBIC)
    im.paste(layer, xy, layer)
im.save(out / 'homework.png')
