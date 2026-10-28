FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data SECURE_COOKIES=1 TRUST_PROXY=1
VOLUME /data
EXPOSE 8080
CMD ["node", "server/index.js"]
