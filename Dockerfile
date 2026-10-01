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
# ТЗ-100 v15: миграция LMS для POST /migrate-lms (читается из dist/migrations)
RUN mkdir -p dist/migrations && cp src/migrations/lms_v1.sql dist/migrations/lms_v1.sql
# ТЗ-102 v2: миграция UGC для POST /migrate-lms-ugc
RUN cp src/migrations/lms_v2_ugc.sql dist/migrations/lms_v2_ugc.sql
# ТЗ-103: миграция мэтчинга курсов для POST /migrate-lms-matching
RUN cp src/migrations/lms_v3_matching.sql dist/migrations/lms_v3_matching.sql
EXPOSE 3001
ENV BUILD_TIMESTAMP=1779922500
CMD ["node", "dist/index.js"]
