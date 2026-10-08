#!/bin/bash
# MarkFlow 一键停止
echo "停止后端…";  lsof -ti :8080 2>/dev/null | xargs kill -9 2>/dev/null || true
echo "停止前端…";  lsof -ti :5173 2>/dev/null | xargs kill -9 2>/dev/null || true
echo "停止 PG…";   docker stop markflow-pg >/dev/null 2>&1 || true
echo "✓ 全部已停止"
