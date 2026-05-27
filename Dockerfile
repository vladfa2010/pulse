FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
# Clear cache to ensure fresh source
RUN rm -rf src dist
COPY . .
RUN npx tsc
# Copy schema.sql to dist (tsc only compiles .ts files)
RUN mkdir -p dist/models && cp src/models/schema.sql dist/models/schema.sql
EXPOSE 3001
ENV BUILD_TIMESTAMP=1779922000
CMD ["node", "dist/index.js"]
