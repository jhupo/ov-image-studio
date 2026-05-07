#!/bin/sh

# 用环境变量替换前端默认 API URL
DEFAULT_IMAGE_API_URL=${DEFAULT_IMAGE_API_URL:-http://192.168.2.60:8080/v1}

# 查找所有 js 文件并将占位符替换为运行时配置
find /usr/share/nginx/html/assets -type f -name "*.js" -exec sed -i "s|__VITE_DEFAULT_IMAGE_API_URL_PLACEHOLDER__|$DEFAULT_IMAGE_API_URL|g" {} +

exec "$@"
