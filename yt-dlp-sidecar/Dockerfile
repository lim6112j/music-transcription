FROM python:3.12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir yt-dlp
COPY sidecar.py /app/sidecar.py
EXPOSE 4940
CMD ["python", "/app/sidecar.py"]
