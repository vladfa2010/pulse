FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npx tsc
# Copy schema.sql to dist (tsc only compiles .ts files)
RUN mkdir -p dist/models && cp src/models/schema.sql dist/models/schema.sql
EXPOSE 3001
CMD ["node", "dist/index.js"]
