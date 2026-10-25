# FrontDoor in one container: build the React site, then serve it and the FastAPI server on $PORT.
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.13-slim
WORKDIR /app/server
COPY server/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server/ ./
COPY --from=web /web/dist /app/web/dist
ENV PORT=8000
CMD ["sh", "-c", "uvicorn serve:root --host 0.0.0.0 --port ${PORT}"]
