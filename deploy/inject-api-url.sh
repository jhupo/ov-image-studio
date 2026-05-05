#!/bin/sh

# 用环境变量替换前端默认 API URL
DEFAULT_IMAGE_API_URL=${DEFAULT_IMAGE_API_URL:-${API_URL:-http://192.168.2.60:8080/v1}}
API_PROXY_URL=${API_PROXY_URL%/}
DOCKER_LEGACY_API_URL_USED=${DOCKER_LEGACY_API_URL_USED:-false}
if [ -n "$API_URL" ]; then
    DOCKER_LEGACY_API_URL_USED=true
fi

API_PROXY_AVAILABLE=false
if [ "$ENABLE_API_PROXY" = "true" ]; then
    API_PROXY_AVAILABLE=true
fi

# 查找所有 js 文件并将占位符替换为运行时配置
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_DEFAULT_API_URL_PLACEHOLDER__|$DEFAULT_IMAGE_API_URL|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_DEFAULT_IMAGE_API_URL_PLACEHOLDER__|$DEFAULT_IMAGE_API_URL|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_API_PROXY_AVAILABLE_PLACEHOLDER__|$API_PROXY_AVAILABLE|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_DOCKER_DEPLOYMENT_PLACEHOLDER__|true|g" {} +
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_DOCKER_LEGACY_API_URL_USED_PLACEHOLDER__|$DOCKER_LEGACY_API_URL_USED|g" {} +

# 检查是否启用了 API 代理
if [ "$ENABLE_API_PROXY" != "true" ]; then
    # 删除代理配置块
    sed -i '/# BEGIN API PROXY/,/# END API PROXY/d' /etc/nginx/conf.d/default.conf
fi

exec "$@"
