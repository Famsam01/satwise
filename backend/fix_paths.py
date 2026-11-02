import re, shutil
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES, STATIC = ROOT / "TEMPLATES", ROOT / "static"

backup = ROOT / "TEMPLATES_backup"
if not backup.exists():
    shutil.copytree(TEMPLATES, backup)  # safety copy of your pages

files = {p.name.lower(): p.relative_to(STATIC).as_posix()
         for p in STATIC.rglob("*") if p.is_file()}
pattern = re.compile(r'''(href|src)=(["'])([^"']+)\2''')
SKIP = ("/", "#", "http:", "https:", "data:", "mailto:", "tel:", "javascript:")

for page in TEMPLATES.glob("*.html"):
    text = page.read_text(encoding="utf-8")

    def fix(m):
        attr, q, url = m.groups()
        if url.startswith(SKIP):
            return m.group(0)
        name = unquote(Path(urlparse(url).path).name).lower()
        if name in files:
            new = "/static/" + quote(files[name])
            print(f"{page.name}: {url} -> {new}")
            return f"{attr}={q}{new}{q}"
        return m.group(0)

    new_text = pattern.sub(fix, text)
    if new_text != text:
        page.write_text(new_text, encoding="utf-8")