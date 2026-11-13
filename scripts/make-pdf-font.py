"""Builds the PDF export font: Phetsarath (Lao) + DejaVu Sans (Latin, ₭).

jsPDF draws one font per text run and has no fallback, and Phetsarath has no
Latin letters, so an export with an English name or SKU would print blanks.
This merges the two into one font per weight. Phetsarath comes first, so its
digits and Lao shaping win; DejaVu only fills in what Phetsarath lacks.

Licenses: Phetsarath is SIL OFL 1.1 (Ministry of Posts and Telecommunications,
Laos), DejaVu is the Bitstream Vera licence. Both allow bundling and changes;
see src/assets/fonts/LICENSES.txt.

Needs: pip install fonttools
Usage: python scripts/make-pdf-font.py <Phetsarath-Regular.ttf> <Phetsarath-Bold.ttf>
                                       <DejaVuSans.ttf> <DejaVuSans-Bold.ttf>
"""
import os
import sys
import tempfile

from fontTools import subset
from fontTools.merge import Merger
from fontTools.ttLib import TTFont

OUT = os.path.join(os.path.dirname(__file__), "..", "src", "assets", "fonts")
# Basic Latin, Latin-1, general punctuation, currency signs (₭ $ ¥), №, ™, ฿
LATIN = "U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-203A,U+20A0-20CF,U+2116,U+2122,U+0E3F"


def latin_only(src, dst):
    opts = subset.Options()
    opts.layout_features = []  # Latin kerning isn't worth a merge conflict
    opts.name_IDs = ["*"]
    opts.drop_tables += ["MATH", "FFTM"]  # DejaVu extras the merger can't combine
    font = TTFont(src)
    s = subset.Subsetter(opts)
    s.populate(unicodes=subset.parse_unicodes(LATIN))
    s.subset(font)
    font.save(dst)


def build(lao, latin, out):
    with tempfile.TemporaryDirectory() as tmp:
        lat = os.path.join(tmp, "latin.ttf")
        latin_only(latin, lat)
        merged = Merger().merge([lao, lat])
        # A changed OFL font must not go out under the original's name.
        bold = "Bold" in os.path.basename(out) or "bold" in os.path.basename(out)
        style = "Bold" if bold else "Regular"
        names = {1: "RAPIDEWMS PDF", 2: style, 3: f"RAPIDEWMS PDF {style}", 4: f"RAPIDEWMS PDF {style}",
                 6: f"RAPIDEWMSPDF-{style}", 16: "RAPIDEWMS PDF", 17: style}
        tbl = merged["name"]
        for rec in list(tbl.names):
            if rec.nameID in names:
                tbl.removeNames(nameID=rec.nameID)
        for nid, text in names.items():
            tbl.setName(text, nid, 3, 1, 0x409)
        merged.save(out)
    print(out, os.path.getsize(out), "bytes")


if __name__ == "__main__":
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    os.makedirs(OUT, exist_ok=True)
    build(sys.argv[1], sys.argv[3], os.path.join(OUT, "pdf-regular.ttf"))
    build(sys.argv[2], sys.argv[4], os.path.join(OUT, "pdf-bold.ttf"))
