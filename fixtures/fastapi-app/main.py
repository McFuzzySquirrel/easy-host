import os

import uvicorn
from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "fastapi-app"}


def main() -> None:
    port = int(os.environ["PORT"])
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
