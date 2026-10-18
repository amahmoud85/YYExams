"""Convert the Python exam source (exams.py style) into exams/<id>.json files.

Usage: python3 scripts/export_exams.py <dir containing exams.py> [module ...]
Each module must define EXAMS (a list) or the names passed after the dir.
"""
import json, os, sys

src = os.path.abspath(sys.argv[1])
sys.path.insert(0, src)
from exams import EXAMS  # noqa: E402

out = os.path.join(os.path.dirname(__file__), "..", "exams")
os.makedirs(out, exist_ok=True)
for order, e in enumerate(EXAMS, 1):
    e = {**e, "order": e.get("order", order)}
    with open(os.path.join(out, e["id"] + ".json"), "w", encoding="utf-8") as f:
        json.dump(e, f, ensure_ascii=False, indent=1)
    print(e["id"], len(e["questions"]), "questions", sum(q["marks"] for q in e["questions"]), "marks")
