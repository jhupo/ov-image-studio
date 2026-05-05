# ---- Build stage ----
FROM node:20-alpine AS build

WORKDIR /app

ENV VITE_DEFAULT_IMAGE_API_URL=__VITE_DEFAULT_IMAGE_API_URL_PLACEHOLDER__
ENV VITE_API_PROXY_AVAILABLE=__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__
ENV VITE_DOCKER_DEPLOYMENT=__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__
ENV VITE_DOCKER_LEGACY_API_URL_USED=__VITE_DOCKER_LEGACY_API_URL_USED_PLACEHOLDER__

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Production stage ----
FROM nginx:alpine

ENV HOST=0.0.0.0
ENV PORT=80
ENV IMAGE_STUDIO_PORT=8787
ENV DEFAULT_IMAGE_API_URL=
ENV API_PROXY_URL=
ENV ENABLE_API_PROXY=false
ENV POSTGRES_DSN=
ENV REDIS_URL=

COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/templates/default.conf.template
COPY deploy/migrate-api-env.envsh /docker-entrypoint.d/05-migrate-api-env.envsh
COPY deploy/inject-api-url.sh /docker-entrypoint.d/40-inject-api-url.sh
COPY backend /opt/app/backend
COPY requirements.txt /opt/app/requirements.txt
RUN apk add --no-cache python3 py3-pip \
    && python3 -m pip install --break-system-packages --no-cache-dir -r /opt/app/requirements.txt
RUN chmod +x /docker-entrypoint.d/05-migrate-api-env.envsh /docker-entrypoint.d/40-inject-api-url.sh \
    && sed -i 's/\r$//' /docker-entrypoint.d/05-migrate-api-env.envsh /docker-entrypoint.d/40-inject-api-url.sh /etc/nginx/templates/default.conf.template

EXPOSE 80

CMD ["/bin/sh", "-lc", ". /docker-entrypoint.d/05-migrate-api-env.envsh; envsubst '${HOST} ${PORT} ${API_PROXY_URL} ${IMAGE_STUDIO_PORT}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf; /docker-entrypoint.d/40-inject-api-url.sh true; gunicorn --chdir /opt/app/backend --bind 127.0.0.1:${IMAGE_STUDIO_PORT} --workers 1 --threads 8 --timeout 1200 server:app & nginx -g 'daemon off;'"]
