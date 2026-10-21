from pathlib import Path
import sys

Path(sys.argv[-1]).write_text("editor-return-marker", encoding="utf-8")
