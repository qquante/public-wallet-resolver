FROM node:24-slim

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test

CMD ["npm", "run", "service"]
