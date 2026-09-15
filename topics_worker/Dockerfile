# ТЗ-115, задача 2 — one-shot воркер кластеризации тем (профиль worker в compose)
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

CMD ["python", "main.py"]
