# ---- Build stage ----
ARG BUILDPLATFORM=linux/amd64
ARG TARGETOS=linux
ARG TARGETARCH=amd64

FROM --platform=$BUILDPLATFORM node:20-alpine AS build

WORKDIR /app

ARG BASE_URL=/

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN VITE_DEFAULT_API_URL="$BASE_URL" VITE_DOCKER_DEPLOYMENT=true VITE_SHOW_DEFAULT_CONFIG_ONLY=false npm run build

# ---- API stage ----
FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS api-build

WORKDIR /app

ARG TARGETOS
ARG TARGETARCH

COPY go.mod ./
COPY backend ./backend
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/ov-image-studio ./backend

# ---- Runtime stage ----
FROM alpine:3.20

WORKDIR /app

RUN apk add --no-cache ca-certificates

COPY --from=build /app/dist ./dist
COPY --from=api-build /out/ov-image-studio ./ov-image-studio

EXPOSE 80

CMD ["./ov-image-studio"]
