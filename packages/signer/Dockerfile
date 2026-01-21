FROM python:3.11-slim

WORKDIR /app

COPY packages/signer/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY packages/signer /app/packages/signer
WORKDIR /app/packages/signer

ENV PYTHONUNBUFFERED=1

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]

