FROM python:3.12-slim
RUN pip install --no-cache-dir gemini-webapi==2.1.1 websockets==17.4
WORKDIR /app
COPY bridge.py manage.py browser_session.py proxy.py account_pool.py ./
ENV GEMINI_COOKIE_PATH=/data/cookies PYTHONUNBUFFERED=1
USER 10001:10001
EXPOSE 8010
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8010/healthz',timeout=3)"
CMD ["python", "bridge.py"]
