from __future__ import annotations

import os

import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "zhanyue.public_server:app",
        host=os.getenv("ZHANYUE_PUBLIC_HOST", "127.0.0.1"),
        port=int(os.getenv("ZHANYUE_PUBLIC_PORT", "8010")),
        reload=False,
    )
