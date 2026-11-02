---
title: nanoVLM Factory
kind: project
stage: evaluating
tags: [视觉-语言, 连接器扫参, 轻量模型]
updated: 2026-11-02
links:
  - hf_collection:gatilin/nanovlm-factory-6addc6d2eb1f2ac4e493b2b3
  - hf_collection:gatilin/nanovlm-684ee2c750787233ba47f4d7
  - hf_model:gatilin/nanoVLM-SmolLM2-dinov2
  - hf_model:gatilin/nanoVLM-SmolLM2-sglip2
  - hf_model:gatilin/nanovlm-factory-MoonViT-SO-400M_224_mp2_SmolLM2-360M-Instruct
  - gh_repo:huggingface/nanoVLM
---
# nanoVLM Factory

视觉编码器 × 连接器的批量扫参产线：在同一批 SmolLM2 底座下替换 dinov2 / siglip / sgclip / MoonViT / convnext 等视觉侧，用来横向比较连接器形态与视觉塔的影响。

- 列出的三个模型只是代表条目，集合本身覆盖全部产出；未登记的成员会出现在「未登记」清单里，而不是被当成缺失。
- `gh_repo:huggingface/nanoVLM` 是上游框架仓库，属本期范围外，只作对照，不计入核对成功。
