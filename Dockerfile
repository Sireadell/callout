FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
# The try-it page runs the glasses app code itself in the browser.
COPY glasses/src ./glasses/src
ENV PORT=8787
EXPOSE 8787
VOLUME /app/data
CMD ["node", "server/index.js"]
