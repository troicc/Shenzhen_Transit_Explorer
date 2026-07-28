"""Local-only file server for the generated review artifact."""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse


REVIEW_INDEX = Path(__file__).resolve().parent / "dist" / "review" / "index.html"
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/", include_in_schema=False)
def review_index() -> FileResponse:
    if not REVIEW_INDEX.exists():
        raise HTTPException(status_code=503, detail="请先运行 python -m zhanyue.build --mode review")
    return FileResponse(REVIEW_INDEX, headers={"Cache-Control": "no-store, max-age=0"})
