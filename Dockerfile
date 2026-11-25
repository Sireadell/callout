FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
ENV PORT=8787
EXPOSE 8787
VOLUME /app/data
CMD ["node", "server/index.js"]
