#!/bin/bash
# 🌟 一键部署 AI Proxy

echo "🚀 正在部署 AI 统一代理..."

# 1. Fork 仓库
gh repo fork https://github.com/yourusername/ai-proxy-template --clone=false

# 2. 设置 Secrets
read -p "输入 Cloudflare API Token: " token
gh secret set CLOUDFLARE_API_TOKEN -b "$token" --repo yourusername/ai-proxy

# 3. 自动部署
gh workflow run "🚀 Deploy AI Proxy" --repo yourusername/ai-proxy

echo "✅ 部署完成！查看: https://github.com/yourusername/ai-proxy/actions"
