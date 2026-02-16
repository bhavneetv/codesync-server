FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    default-jre default-jdk \
    build-essential \
    golang-go \
    php-cli \
    rustc cargo \
    mono-mcs mono-runtime \
    kotlin \
    lua5.4 \
    perl \
    ruby-full \
    swi-prolog \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server ./server

ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "server/index.js"]
