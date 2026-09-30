# Version pineada a la que se instala via npm (playwright ^1.48.0 en package.json).
# Si se bumpea la version de playwright en package.json, actualizar este tag tambien.
ARG PLAYWRIGHT_VERSION=1.48.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/server.js"]
