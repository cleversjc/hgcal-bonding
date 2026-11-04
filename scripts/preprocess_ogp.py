"""Convert text-based HGCal YOLO grid reports into portable offline OGP JSON.

Install: python -m pip install pymupdf
Usage: python scripts/preprocess_ogp.py report.pdf report.ogp.json [--assets DIR]
Images with baked-in annotations are extracted without recompression. If the
page has vector drawings/annotations, the complete tile is rendered losslessly.
Unknown layouts, ambiguous pairings, missing modules or mismatched counts fail
before the output is written. This is not an OCR / arbitrary-PDF converter.
"""
import argparse
import base64
import hashlib
import json
import re
from pathlib import Path

import pymupdf

MODULE = re.compile(r"320[A-Z0-9]{12}(?![A-Z0-9])")
LABEL = re.compile(r"cell\s+(\d+)\s+conf\s+(0(?:\.\d+)?|1(?:\.0+)?)", re.I)


def convert(source: Path, assets: Path | None = None):
    doc = pymupdf.open(source)
    if not 1 <= len(doc) <= 60:
        raise ValueError("Expected 1-60 pages")
    previous = None
    pages, detections = [], []
    for page_number, page in enumerate(doc, 1):
        lines = [line for block in page.get_text("dict", flags=0)["blocks"]
                 for line in block.get("lines", [])]
        headings, labels = [], []
        for line in lines:
            value = "".join(s["text"] for s in line["spans"]).strip()
            if re.search(r"HGCal\s+YOLO\s+Leakage\s+Report", value, re.I):
                found = MODULE.findall(value)
                if len(set(found)) != 1:
                    raise ValueError(f"Page {page_number}: invalid module heading")
                headings.extend(found)
            if re.search(r"\bcell\b", value, re.I):
                match = LABEL.fullmatch(value)
                if not match or not 1 <= int(match[1]) <= 198:
                    raise ValueError(f"Page {page_number}: unsupported caption {value!r}")
                labels.append((line["spans"][0]["origin"], f"C{int(match[1])}", float(match[2]), value))
        if len(set(headings)) > 1:
            raise ValueError(f"Page {page_number}: ambiguous module")
        module_id = headings[0] if headings else previous
        if module_id is None:
            raise ValueError("First page must identify its module; cannot infer it")
        images = page.get_image_info(xrefs=True)
        if not labels or len(labels) != len(images):
            raise ValueError(f"Page {page_number}: {len(labels)} captions / {len(images)} images")
        used = set()
        pages.append({"page": page_number, "moduleId": module_id, "count": len(labels), "inherited": not bool(headings)})
        for index, ((x, y), cell, confidence, caption) in enumerate(labels, 1):
            candidates = [(i, image) for i, image in enumerate(images)
                          if image["bbox"][0] - 2 <= x < image["bbox"][2]
                          and 0 <= y - image["bbox"][3] <= 30]
            if len(candidates) != 1 or candidates[0][0] in used:
                raise ValueError(f"Page {page_number} / {index}: ambiguous image")
            image_index, info = candidates[0]
            used.add(image_index)
            transform = info["transform"]
            if abs(transform[1]) > .01 or abs(transform[2]) > .01 or transform[0] <= 0 or transform[3] <= 0:
                raise ValueError("Rotated / skewed tiles require a separate validated converter")
            if max(info["width"], info["height"]) > 4096:
                raise ValueError("Tile exceeds 4096 pixels")
            raw = doc.extract_image(info["xref"]) if info["xref"] else None
            # Preserve the exact original encoded bytes where no PDF overlay,
            # transparency mask, or unsupported color model changes the tile.
            if raw and raw["ext"] in ("jpeg", "png") and not raw.get("smask") and info["colorspace"] == 3 and not page.get_drawings() and not list(page.annots() or []):
                content, ext = raw["image"], raw["ext"]
                width, height = raw["width"], raw["height"]
            else:
                scale = info["width"] / (info["bbox"][2] - info["bbox"][0])
                pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=info["bbox"], alpha=False)
                content, ext, width, height = pixmap.tobytes("png"), "png", pixmap.width, pixmap.height
            name = f"page-{page_number}-{index}-{cell}.{ext}"
            if assets:
                assets.mkdir(parents=True, exist_ok=True)
                (assets / name).write_bytes(content)
            detections.append({"moduleId": module_id, "cell": cell, "confidence": confidence,
                               "page": page_number, "index": index, "caption": caption,
                               "image": {"name": name, "width": width, "height": height,
                                         "data": f"data:image/{ext};base64," + base64.b64encode(content).decode("ascii")}})
        previous = module_id
    if len(detections) > 2000:
        raise ValueError("Maximum 2000 detections per import")
    return {"app": "HGCAL OGP Import", "schemaVersion": 1,
            "source": {"name": source.name, "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                       "pageCount": len(doc), "parser": "hgcal-yolo-grid-v1-pymupdf"},
            "pages": pages, "detections": detections}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--assets", type=Path, help="Also write original image files for inspection")
    args = parser.parse_args()
    result = convert(args.pdf, args.assets)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    counts = {module: sum(r["moduleId"] == module for r in result["detections"])
              for module in sorted({r["moduleId"] for r in result["detections"]})}
    print(json.dumps({"pages": result["pages"], "modules": counts, "detections": len(result["detections"]),
                      "sourceSha256": result["source"]["sha256"], "jsonBytes": args.output.stat().st_size}))


if __name__ == "__main__":
    main()
