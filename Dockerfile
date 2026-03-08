FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY . .

RUN mkdir -p data

EXPOSE 3500

ENV PORT=3500

CMD ["node", "server.js"]
